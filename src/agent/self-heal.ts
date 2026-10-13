// 自纠错 Agent 闭环：extract → eval（覆盖率 + 引擎自检 + 语义评审）→ self-heal（LLM 修正）→ 重复直到通过或达到 maxRounds
// 这是项目的核心 Agent 能力：不是单次 LLM 调用，而是「感知 → 决策 → 行动」的闭环。
// 设计取舍：决策空间离散且可枚举（删幻觉 / 补漏提 / 修语义 / 修行为），策略用确定性代码编码，
// LLM 只在需要泛化的环节（提取 / 修正 / 评审）出场——可复现、可审计、成本可控。
import { Linter } from 'eslint';
import type { LLMClient } from '../llm/client.js';
import type {
  BehaviorFailureDetail,
  Constraint,
  Condition,
  EngineConfig,
  HealRound,
  Message,
  SelfHealResult,
} from '../types/index.js';
import { constraintArraySchema } from '../types/index.js';
import { extractConstraints } from './extract.js';
import { Tracer } from './trace.js';
import { computeCoverage } from '../engine/coverage.js';
import { severityOf, synthesizeScenarios, unverifiedMinVersions } from '../engine/behavior.js';
import { buildUnsupportedApiConfig } from '../engine/unsupported-api.js';
import { nameFromTarget, targetToSelector } from '../engine/selector.js';
import { callWithItemFallback } from './heal-batch.js';
import {
  healMissedPrompt,
  healBehaviorPrompt,
  healSemanticsPrompt,
  healVersionsPrompt,
} from '../llm/prompts.js';
import { verifySemantics } from './judge.js';
import { logger } from '../utils/logger.js';

/** 统一错误信息提取（catch 块用）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SelfHealOptions {
  maxRounds?: number;
  tracer?: Tracer;
}

/** LLM 输出的原始约束（selector 可选，由 Zod schema 决定）。 */
type RawConstraint = Omit<Constraint, 'selector' | 'name'> & { selector?: string; name?: string };

const linter = new Linter({ configType: 'flat' });

/** 批次级降级的可观测结果，用于落盘与告警。 */
interface HealFallbackReport {
  /** 整批是否成功（未降级） */
  batchSucceeded: boolean;
  /** 逐条重试实际发生的调用次数 */
  fallbackCalls: number;
  /** 是否因探测失败（系统性故障）而放弃降级 */
  abortedOnProbe: boolean;
  /** 因超过上限而未逐条重试的条数 */
  skippedByLimit: number;
}

/**
 * 带「逐条降级」的约束类 heal 调用。
 *
 * 先整批调用（成功则零额外成本）；整批失败（如某条 `name` 不合 kebab-case 导致
 * Zod 校验整体失败）时降级为逐条重试，并**保留已通过校验的部分**——一条坏数据
 * 不再让整批修正作废（见 agent/heal-batch.ts 的说明与实测记录）。
 *
 * 返回 null 表示确实没救回来（探测也失败，或最终一条都没解析成功）。
 */
async function healConstraintsWithFallback(
  items: unknown[],
  label: string,
  buildPrompt: (batch: unknown[]) => Message[],
  llm: LLMClient,
  sdkName: string,
): Promise<{ constraints: Constraint[]; report: HealFallbackReport; recovered: boolean }> {
  // `items` 是各 heal prompt 的入参（字符串 / 失败明细对象，形态各异），
  // 这里只做透传，不关心具体结构。
  const batchCall = async (batch: unknown[]): Promise<Constraint[]> => {
    const raw = await llm.chatJSON(buildPrompt(batch), constraintArraySchema, {
      label,
      temperature: 0.1,
      maxTokens: 8192,
      structuredOutput: true,
    });
    return toConstraints(raw as RawConstraint[], sdkName);
  };

  const outcome = await callWithItemFallback<unknown, Constraint>(items, batchCall);
  const report: HealFallbackReport = {
    batchSucceeded: outcome.batchSucceeded,
    fallbackCalls: outcome.fallbackCalls,
    abortedOnProbe: outcome.abortedOnProbe,
    skippedByLimit: outcome.skippedByLimit,
  };
  // 注意：即使一条都没救回来（探测即失败）也必须把 report 交出去——
  // 降级确实发生了，成本与原因不能被「没救回来」这件事吞掉。
  return { constraints: outcome.items, report, recovered: outcome.items.length > 0 };
}

/**
 * 把修正结果合并回约束列表（按 target 对齐），返回新的约束数组与被接受的**真实变更数**。
 * 语义与原先各 heal 分支内联的逻辑一致：只有内容真的变了才计入 healedCount，
 * 杜绝「重试次数」被当成「修正数」的虚假指标。
 */
function mergeHealedConstraints(
  constraints: Constraint[],
  healed: Constraint[],
  restrictToTargets?: Set<string>,
): { constraints: Constraint[]; changed: number } {
  const byTarget = new Map(healed.map((c) => [c.target, c]));
  let changed = 0;
  const next = constraints.map((c) => {
    if (restrictToTargets && !restrictToTargets.has(c.target)) return c;
    const replacement = byTarget.get(c.target);
    if (!replacement || sameConstraint(c, replacement)) return c;
    changed++;
    return replacement;
  });
  return { constraints: next, changed };
}

/**
 * 把降级情况落盘告警。
 *
 * 为什么必须上报而不是静默降级：逐条重试会成倍放大 LLM 调用次数，
 * 如果不显式说明「整批失败了、改走了逐条、花了多少次、有没有被上限截断」，
 * 成本上升会被完全隐藏，也无从判断是「个别数据坏」还是「系统性故障」。
 */
function reportFallback(
  strategy: string,
  report: HealFallbackReport,
  llmFailures: { strategy: string; error: string }[],
): void {
  if (report.batchSucceeded) return;
  const parts = [`整批失败→逐条重试 ${report.fallbackCalls} 次`];
  if (report.abortedOnProbe) parts.push('探测即失败，判定为系统性故障，已放弃逐条重试');
  if (report.skippedByLimit > 0) parts.push(`${report.skippedByLimit} 条超出逐条上限未重试`);
  const note = `${strategy}：${parts.join('；')}`;
  llmFailures.push({ strategy: `${strategy}_batch_fallback`, error: note });
  logger.warn(note);
}

/**
 * 单条约束的引擎自检：验证该约束接到真实 ESLint 引擎上能否按预期触发。
 * 做法：为该约束合成一组场景（每段代码 + 一个期望输出 error/warn/ok），
 * 逐段跑 linter.verify 并把实际消息归约为三态，与期望比对；
 * 全部一致返回 null，否则返回带失配场景的失败详情。
 * 边界：期望由约束数据自身推导，这里只查引擎链路通不通（selector 能否命中、
 * 版本/平台解析、severity 归约），查不了数据本身对不对——那由 verifySemantics 语义评审负责。
 */
function verifyBehavior(
  constraint: Constraint,
  config: EngineConfig,
): BehaviorFailureDetail | null {
  const lintConfig = buildUnsupportedApiConfig([constraint], config);
  const mismatches: BehaviorFailureDetail['mismatches'] = [];

  for (const scenario of synthesizeScenarios(constraint, config)) {
    const actual = severityOf(linter.verify(scenario.code, lintConfig));
    if (actual !== scenario.expect) {
      mismatches.push({
        scenarioId: scenario.id,
        code: scenario.code,
        expect: scenario.expect,
        actual,
      });
    }
  }

  if (mismatches.length === 0) return null;
  return {
    name: constraint.name,
    target: constraint.target,
    reason: `${mismatches.length} 个场景实际判定与期望不符：${mismatches
      .map((m) => `${m.scenarioId}(期望 ${m.expect} 实际 ${m.actual})`)
      .join('、')}`,
    conditions: constraint.conditions,
    level: constraint.level,
    onResolveFail: constraint.onResolveFail,
    mismatches,
  };
}

/** 批量行为校验：返回所有失败约束的完整详情。 */
function verifyAllBehaviors(
  constraints: Constraint[],
  config: EngineConfig,
): BehaviorFailureDetail[] {
  const failures: BehaviorFailureDetail[] = [];
  for (const c of constraints) {
    const detail = verifyBehavior(c, config);
    if (detail) failures.push(detail);
  }
  return failures;
}

/** 从 LLM 原始输出构造 Constraint[]（selector 由 target 机械推导，evidence 透传）。 */
function toConstraints(raw: RawConstraint[], sdkName: string): Constraint[] {
  return raw.map((c) => ({
    // name 与 selector 一样由 target 机械推导：LLM 曾把 name 填成 API 路径，
    // 违反 kebab-case 让整批修正作废（实测 9 条漏提三轮修不回）。
    name: nameFromTarget(c.target, sdkName),
    target: c.target,
    selector: targetToSelector(c.target, sdkName),
    message: c.message,
    conditions: c.conditions as Condition[],
    level: c.level,
    onResolveFail: c.onResolveFail,
    evidence: c.evidence,
  }));
}

/** 判断两条约束数据是否等价（不含 selector —— selector 由 target 决定）。 */
function sameConstraint(a: Constraint, b: Constraint): boolean {
  return (
    a.name === b.name &&
    a.message === b.message &&
    a.level === b.level &&
    a.onResolveFail === b.onResolveFail &&
    a.evidence === b.evidence &&
    JSON.stringify(a.conditions) === JSON.stringify(b.conditions)
  );
}

/**
 * 自纠错 Agent 循环：提取 → 校验 → LLM 修正 → 重复。
 * - 第 0 轮：调用 extractConstraints 做初始提取（含分块 + Zod 校验）
 * - 第 1~maxRounds 轮：跑覆盖率 + 行为 + 语义三道校验，若有失败则用 LLM 修正
 * - 全部通过或达到 maxRounds 后返回
 */
export async function extractWithSelfHeal(
  doc: string,
  llm: LLMClient,
  engineConfig: EngineConfig,
  options: SelfHealOptions = {},
): Promise<SelfHealResult> {
  const maxRounds = options.maxRounds ?? 3;
  const tracer = options.tracer ?? new Tracer();
  const sdkName = engineConfig.sdkName;
  const started = Date.now();

  // 第 0 轮：初始提取
  const extractResult = await extractConstraints(doc, llm, { sdkName, tracer });
  let constraints = extractResult.constraints;
  const conflicts = extractResult.conflicts;

  const rounds: HealRound[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const roundStart = Date.now();
    const roundTokensBefore = llm.getTotalTokens();

    // ---- 感知：覆盖率 + 行为 + 语义三道校验 ----
    const coverage = computeCoverage(doc, constraints, sdkName);
    const versionProblems = unverifiedMinVersions(constraints, engineConfig);
    const behaviorFailures = verifyAllBehaviors(constraints, engineConfig);

    const semanticCheck = await verifySemantics(doc, constraints, llm, sdkName);
    const semanticFailures = semanticCheck.failures;

    // 语义评审批次失败 → 本轮「无语义问题」不可信：必须计入失败清单，
    // 否则一轮批调用全挂时会静默判定为「全部通过」。
    const semanticBatchFailures: { strategy: string; error: string }[] =
      constraints.length > 0 && (semanticCheck.failedBatches > 0 || semanticCheck.okBatches === 0)
        ? [
            {
              strategy: 'judge_semantics',
              error: `${semanticCheck.failedBatches} 批评审调用失败（成功 ${semanticCheck.okBatches} 批），本轮语义结论不完整`,
            },
          ]
        : [];

    const allPassed =
      coverage.missed.length === 0 &&
      coverage.hallucinated.length === 0 &&
      behaviorFailures.length === 0 &&
      semanticFailures.length === 0 &&
      semanticBatchFailures.length === 0 &&
      versionProblems.length === 0;

    const observation = allPassed
      ? `第 ${round} 轮：全部通过（${constraints.length} 条约束）`
      : `第 ${round} 轮：漏提 ${coverage.missed.length}、幻觉 ${coverage.hallucinated.length}、` +
        `自检失败 ${behaviorFailures.length}、语义失败 ${semanticFailures.length}、` +
        `版本清单缺项 ${versionProblems.length}`;

    const healRound: HealRound = {
      round,
      observation,
      constraintCount: 0,
      coverageMissed: coverage.missed,
      coverageHallucinated: coverage.hallucinated,
      behaviorFailures: behaviorFailures.map(({ name, reason }) => ({ name, reason })),
      semanticFailures,
      unverifiedMinVersions: versionProblems,
      healedCount: 0,
      durationMs: 0,
      tokensUsed: 0,
      llmFailures: [],
    };

    if (allPassed) {
      healRound.durationMs = Date.now() - roundStart;
      healRound.tokensUsed = llm.getTotalTokens() - roundTokensBefore;
      healRound.constraintCount = constraints.length;
      rounds.push(healRound);
      tracer.append({
        step: round,
        observation,
        timestamp: Date.now(),
        durationMs: healRound.durationMs,
        tokensUsed: healRound.tokensUsed,
      });
      tracer.save();
      tracer.printStep({
        step: round,
        observation,
        timestamp: Date.now(),
        durationMs: healRound.durationMs,
        tokensUsed: healRound.tokensUsed,
      });
      return {
        constraints,
        conflicts,
        rounds,
        passed: true,
        finalMissed: [],
        finalHallucinated: [],
        finalBehaviorFailures: [],
        finalSemanticFailures: [],
        durationMs: Date.now() - started,
      };
    }

    // ---- 决策 + 行动：自纠错（四类固定策略，决策空间可枚举） ----
    let healedCount = 0;
    const llmFailures: { strategy: string; error: string }[] = [...semanticBatchFailures];

    // 1. 移除幻觉约束（无需 LLM）
    if (coverage.hallucinated.length > 0) {
      const hallucinatedSet = new Set(coverage.hallucinated);
      const before = constraints.length;
      constraints = constraints.filter((c) => !hallucinatedSet.has(c.target));
      healedCount += before - constraints.length;
    }

    // 2. 补提取漏掉的 API（LLM 调用，整批失败自动降级为逐条重试）
    if (coverage.missed.length > 0) {
      const res = await healConstraintsWithFallback(
        coverage.missed,
        'heal_missed',
        (batch) => healMissedPrompt(batch as string[], doc, sdkName),
        llm,
        sdkName,
      ).catch((err: unknown) => {
        const msg = errMessage(err);
        llmFailures.push({ strategy: 'heal_missed', error: msg });
        logger.warn(`heal_missed LLM 调用失败（不中断循环）：${msg.slice(0, 120)}`);
        return {
          constraints: [],
          report: {
            batchSucceeded: false,
            fallbackCalls: 0,
            abortedOnProbe: false,
            skippedByLimit: 0,
          },
          recovered: false,
        };
      });
      if (!res.report.batchSucceeded) reportFallback('heal_missed', res.report, llmFailures);
      if (res.recovered) {
        const existing = new Set(constraints.map((c) => c.target));
        for (const c of res.constraints) {
          if (!existing.has(c.target)) {
            constraints.push(c);
            existing.add(c.target);
            healedCount++;
          }
        }
      }
    }

    // 3. 修正语义评审失败的约束（LLM 调用，带评审意见 + 文档原文）
    if (semanticFailures.length > 0) {
      const res = await healConstraintsWithFallback(
        semanticFailures,
        'heal_semantics',
        (batch) =>
          healSemanticsPrompt(
            batch as { name: string; target: string; issue: string }[],
            doc,
            sdkName,
          ),
        llm,
        sdkName,
      ).catch((err: unknown) => {
        const msg = errMessage(err);
        llmFailures.push({ strategy: 'heal_semantics', error: msg });
        logger.warn(`heal_semantics LLM 调用失败（不中断循环）：${msg.slice(0, 120)}`);
        return {
          constraints: [],
          report: {
            batchSucceeded: false,
            fallbackCalls: 0,
            abortedOnProbe: false,
            skippedByLimit: 0,
          },
          recovered: false,
        };
      });
      if (!res.report.batchSucceeded) reportFallback('heal_semantics', res.report, llmFailures);
      if (res.recovered) {
        const merged = mergeHealedConstraints(constraints, res.constraints);
        constraints = merged.constraints;
        healedCount += merged.changed;
      }
    }

    // 4. 修正引擎自检失败的约束（LLM 调用，带不匹配场景代码 + 期望/实际差异 + 文档原文）
    if (behaviorFailures.length > 0) {
      const res = await healConstraintsWithFallback(
        behaviorFailures,
        'heal_behavior',
        (batch) => healBehaviorPrompt(batch as BehaviorFailureDetail[], doc, sdkName),
        llm,
        sdkName,
      ).catch((err: unknown) => {
        const msg = errMessage(err);
        llmFailures.push({ strategy: 'heal_behavior', error: msg });
        logger.warn(`heal_behavior LLM 调用失败（不中断循环）：${msg.slice(0, 120)}`);
        return {
          constraints: [],
          report: {
            batchSucceeded: false,
            fallbackCalls: 0,
            abortedOnProbe: false,
            skippedByLimit: 0,
          },
          recovered: false,
        };
      });
      if (!res.report.batchSucceeded) reportFallback('heal_behavior', res.report, llmFailures);
      if (res.recovered) {
        const merged = mergeHealedConstraints(constraints, res.constraints);
        constraints = merged.constraints;
        healedCount += merged.changed;
      }
    }

    // 5. 修正 minVersion 不在版本清单的约束（LLM 调用，带合法版本清单 + 文档原文）
    //    注意：这一步**允许模型原样返回**——若文档原文确实写了这个清单外版本，
    //    那属于「版本清单需要补充」，不该为了迎合清单而篡改数据（prompt 已明确规则）。
    if (versionProblems.length > 0) {
      const healedTargets = new Set(versionProblems.map((p) => p.target));
      const res = await healConstraintsWithFallback(
        versionProblems,
        'heal_versions',
        (batch) =>
          healVersionsPrompt(
            batch as { name: string; target: string; platform: string; minVersion: string }[],
            engineConfig.order,
            doc,
            sdkName,
          ),
        llm,
        sdkName,
      ).catch((err: unknown) => {
        const msg = errMessage(err);
        llmFailures.push({ strategy: 'heal_versions', error: msg });
        logger.warn(`heal_versions LLM 调用失败（不中断循环）：${msg.slice(0, 120)}`);
        return {
          constraints: [],
          report: {
            batchSucceeded: false,
            fallbackCalls: 0,
            abortedOnProbe: false,
            skippedByLimit: 0,
          },
          recovered: false,
        };
      });
      if (!res.report.batchSucceeded) reportFallback('heal_versions', res.report, llmFailures);
      if (res.recovered) {
        const merged = mergeHealedConstraints(constraints, res.constraints, healedTargets);
        constraints = merged.constraints;
        healedCount += merged.changed;
      }
    }

    healRound.healedCount = healedCount;
    healRound.llmFailures = llmFailures;
    if (llmFailures.length > 0) {
      healRound.observation = `${observation}；LLM 调用失败 ${llmFailures.length} 次`;
    }
    healRound.durationMs = Date.now() - roundStart;
    healRound.tokensUsed = llm.getTotalTokens() - roundTokensBefore;
    healRound.constraintCount = constraints.length;
    rounds.push(healRound);

    tracer.append({
      step: round,
      observation: healRound.observation,
      timestamp: Date.now(),
      durationMs: healRound.durationMs,
      tokensUsed: healRound.tokensUsed,
    });
    tracer.save();
    tracer.printStep({
      step: round,
      observation: healRound.observation,
      timestamp: Date.now(),
      durationMs: healRound.durationMs,
      tokensUsed: healRound.tokensUsed,
    });
  }

  // 达到 maxRounds 后仍未通过：返回剩余问题
  const finalCoverage = computeCoverage(doc, constraints, sdkName);
  const finalBehaviorFailures = verifyAllBehaviors(constraints, engineConfig);
  const finalSemanticCheck = await verifySemantics(doc, constraints, llm, sdkName);
  const finalSemanticFailures = finalSemanticCheck.failures;

  return {
    constraints,
    conflicts,
    rounds,
    passed: false,
    finalMissed: finalCoverage.missed,
    finalHallucinated: finalCoverage.hallucinated,
    finalBehaviorFailures: finalBehaviorFailures.map(({ name, reason }) => ({
      name,
      reason,
    })),
    finalSemanticFailures,
    durationMs: Date.now() - started,
  };
}

/**
 * 打印自纠错收敛分析表——量化 Agent 每轮的感知-修正效果。
 * 面试视角：这张表证明你不只是"跑通了"，而是能量化评估 Agent 收敛行为。
 */
export function printConvergenceTable(rounds: HealRound[], passed: boolean): void {
  if (rounds.length === 0) return;

  const totalTokens = rounds.reduce((s, r) => s + r.tokensUsed, 0);
  const totalMs = rounds.reduce((s, r) => s + r.durationMs, 0);

  console.log('\n======== 自纠错收敛分析 ========');
  const header = [
    '轮次',
    '约束数',
    '漏提',
    '幻觉',
    '自检失败',
    '语义失败',
    '版本缺项',
    '修正数',
    'LLM失败',
    'Token',
    '耗时',
  ];
  console.log(header.map((h) => h.padStart(6)).join('  '));
  for (const r of rounds) {
    const row = [
      String(r.round).padStart(6),
      String(r.constraintCount).padStart(6),
      String(r.coverageMissed.length).padStart(6),
      String(r.coverageHallucinated.length).padStart(6),
      String(r.behaviorFailures.length).padStart(6),
      String(r.semanticFailures.length).padStart(6),
      String(r.unverifiedMinVersions.length).padStart(6),
      String(r.healedCount).padStart(6),
      String(r.llmFailures.length).padStart(6),
      String(r.tokensUsed).padStart(6),
      `${(r.durationMs / 1000).toFixed(1)}s`.padStart(6),
    ];
    console.log(row.join('  '));
  }
  console.log('─'.repeat(78));
  console.log(
    `合计${' '.repeat(52)}${String(totalTokens).padStart(6)}   ${(totalMs / 1000).toFixed(1)}s`,
  );
  console.log(`收敛: ${passed ? '全部通过' : '仍有残留'}（${rounds.length} 轮）\n`);
}
