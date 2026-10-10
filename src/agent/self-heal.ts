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
  SelfHealResult,
} from '../types/index.js';
import { constraintArraySchema } from '../types/index.js';
import { extractConstraints } from './extract.js';
import { Tracer } from './trace.js';
import { computeCoverage } from '../engine/coverage.js';
import { synthesizeScenarios, type ScenarioExpect } from '../engine/behavior.js';
import { buildUnsupportedApiConfig } from '../engine/unsupported-api.js';
import { targetToSelector } from '../engine/selector.js';
import { healMissedPrompt, healBehaviorPrompt, healSemanticsPrompt } from '../llm/prompts.js';
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
type RawConstraint = Omit<Constraint, 'selector'> & { selector?: string };

const linter = new Linter({ configType: 'flat' });

/** 把 Linter 消息归约为 error / warn / ok 三态。 */
function severityOf(msgs: Linter.LintMessage[]): ScenarioExpect {
  if (msgs.some((m) => m.severity === 2)) return 'error';
  if (msgs.some((m) => m.severity === 1)) return 'warn';
  return 'ok';
}

/**
 * 单条约束的引擎自检（通电测试）：对合成出的全部场景逐个跑真实 Linter，
 * 任一实际输出与场景期望不符即失败。
 * 注意：期望由约束数据自身推导，这里只验证引擎接线（selector/解析/severity），
 * 不验证数据正确性——数据对不对由 eval --semantic 的文档差分（agent/oracle.ts）负责。
 * 返回 null=通过，否则返回带不匹配场景的完整失败详情。
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
    name: c.name,
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
    const behaviorFailures = verifyAllBehaviors(constraints, engineConfig);
    const semanticFailures = await verifySemantics(doc, constraints, llm, sdkName);

    const allPassed =
      coverage.missed.length === 0 &&
      coverage.hallucinated.length === 0 &&
      behaviorFailures.length === 0 &&
      semanticFailures.length === 0;

    const observation = allPassed
      ? `第 ${round} 轮：全部通过（${constraints.length} 条约束）`
      : `第 ${round} 轮：漏提 ${coverage.missed.length}、幻觉 ${coverage.hallucinated.length}、自检失败 ${behaviorFailures.length}、语义失败 ${semanticFailures.length}`;

    const healRound: HealRound = {
      round,
      observation,
      constraintCount: 0,
      coverageMissed: coverage.missed,
      coverageHallucinated: coverage.hallucinated,
      behaviorFailures: behaviorFailures.map(({ name, reason }) => ({ name, reason })),
      semanticFailures,
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
    const llmFailures: { strategy: string; error: string }[] = [];

    // 1. 移除幻觉约束（无需 LLM）
    if (coverage.hallucinated.length > 0) {
      const hallucinatedSet = new Set(coverage.hallucinated);
      const before = constraints.length;
      constraints = constraints.filter((c) => !hallucinatedSet.has(c.target));
      healedCount += before - constraints.length;
    }

    // 2. 补提取漏掉的 API（LLM 调用）
    if (coverage.missed.length > 0) {
      try {
        const raw = await llm.chatJSON(
          healMissedPrompt(coverage.missed, doc, sdkName),
          constraintArraySchema,
          { label: 'heal_missed', temperature: 0.1, maxTokens: 8192, structuredOutput: true },
        );
        const healed = toConstraints(raw as RawConstraint[], sdkName);
        const existing = new Set(constraints.map((c) => c.target));
        for (const c of healed) {
          if (!existing.has(c.target)) {
            constraints.push(c);
            healedCount++;
          }
        }
      } catch (err) {
        const msg = errMessage(err);
        llmFailures.push({ strategy: 'heal_missed', error: msg });
        logger.warn(`heal_missed LLM 调用失败（不中断循环）：${msg.slice(0, 120)}`);
      }
    }

    // 3. 修正语义评审失败的约束（LLM 调用，带评审意见 + 文档原文）
    if (semanticFailures.length > 0) {
      try {
        const raw = await llm.chatJSON(
          healSemanticsPrompt(semanticFailures, doc, sdkName),
          constraintArraySchema,
          { label: 'heal_semantics', temperature: 0.1, maxTokens: 8192, structuredOutput: true },
        );
        const fixed = toConstraints(raw as RawConstraint[], sdkName);
        const fixedMap = new Map(fixed.map((c) => [c.target, c]));
        constraints = constraints.map((c) => {
          const replacement = fixedMap.get(c.target);
          if (!replacement || sameConstraint(c, replacement)) return c;
          healedCount++;
          return replacement;
        });
      } catch (err) {
        const msg = errMessage(err);
        llmFailures.push({ strategy: 'heal_semantics', error: msg });
        logger.warn(`heal_semantics LLM 调用失败（不中断循环）：${msg.slice(0, 120)}`);
      }
    }

    // 4. 修正引擎自检失败的约束（LLM 调用，带不匹配场景代码 + 期望/实际差异 + 文档原文）
    if (behaviorFailures.length > 0) {
      try {
        const raw = await llm.chatJSON(
          healBehaviorPrompt(behaviorFailures, doc, sdkName),
          constraintArraySchema,
          { label: 'heal_behavior', temperature: 0.1, maxTokens: 8192, structuredOutput: true },
        );
        const fixed = toConstraints(raw as RawConstraint[], sdkName);
        const fixedMap = new Map(fixed.map((c) => [c.target, c]));
        constraints = constraints.map((c) => {
          const replacement = fixedMap.get(c.target);
          if (!replacement || sameConstraint(c, replacement)) return c;
          healedCount++;
          return replacement;
        });
      } catch (err) {
        const msg = errMessage(err);
        llmFailures.push({ strategy: 'heal_behavior', error: msg });
        logger.warn(`heal_behavior LLM 调用失败（不中断循环）：${msg.slice(0, 120)}`);
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
  const finalSemanticFailures = await verifySemantics(doc, constraints, llm, sdkName);

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
      String(r.healedCount).padStart(6),
      String(r.llmFailures.length).padStart(6),
      String(r.tokensUsed).padStart(6),
      `${(r.durationMs / 1000).toFixed(1)}s`.padStart(6),
    ];
    console.log(row.join('  '));
  }
  console.log('─'.repeat(70));
  console.log(
    `合计${' '.repeat(44)}${String(totalTokens).padStart(6)}   ${(totalMs / 1000).toFixed(1)}s`,
  );
  console.log(`收敛: ${passed ? '全部通过' : '仍有残留'}（${rounds.length} 轮）\n`);
}
