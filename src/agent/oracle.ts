// 文档差分校验（oracle）：校验「规则对不对」，而不是「规则响不响」。
//
// 为什么需要它：引擎自检（engine/behavior.ts）的场景期望由约束数据自身推导，
// 题面与答案同源——平台/版本抄错时自检照样全绿。本模块把同一批「版本+平台双确定」
// 的场景代码交给一个 LLM 独立第二意见（oracle）：oracle 只看文档原文，看不到任何
// 提取出的约束数据，与引擎的真实 lint 结果没有任何同源信息；两边判定差分，
// 不一致即说明「数据自洽但与文档不符」。
//
// 两条独立判定链路：
//   文档 → 提取 LLM → Constraint[] → 引擎 isViolation → actual
//   文档 → oracle LLM（直判具体场景，无约束数据）       → expected
//
// 三道「不依赖换模型」的去相关加固（换模型是更进一步的一招，本模块不排除）：
//   1. **输入视角收窄**：给 oracle 的文档不是全文，而是「该 API 条目 + 全局约定前言」
//      （engine/doc-context.ts），切断与提取链共享的全文语境；
//   2. **引用先行**：oracle 必须先逐字摘录文档原句，再依据它判定；引不出即 unclear；
//   3. **引用校验**：摘录的原句必须逐字存在于它看到的片段中，否则该判定作废（幻觉引用），
//      避免「引用先行」退化成装饰。
//
// 只对 determinate 场景做差分；resolution 场景（无守卫降级 / 动态 import）的期望
// 依赖引擎自身策略，oracle 无法可比，不参与差分。
import { Linter } from 'eslint';
import type { LLMClient } from '../llm/client.js';
import type { Constraint, EngineConfig, OracleFailure, Platform } from '../types/index.js';
import { oracleVerdictArraySchema } from '../types/index.js';
import {
  severityOf,
  synthesizeScenarios,
  type EngineScenario,
  type ScenarioExpect,
} from '../engine/behavior.js';
import { buildUnsupportedApiConfig } from '../engine/unsupported-api.js';
import {
  extractApiPathFromCode,
  narrowDocToApis,
  validateCitation,
} from '../engine/doc-context.js';
import { oracleJudgePrompt, type OracleScenarioView } from '../llm/prompts.js';

/** 单批送审场景数：控制单次输出规模，避免 verdict 被截断。 */
const ORACLE_BATCH_SIZE = 12;

const PLATFORM_LABEL: Record<Platform, string> = {
  ios: 'iOS',
  android: 'Android',
  harmony: '鸿蒙',
  h5: 'H5',
};

const linter = new Linter({ configType: 'flat' });

/** 给 oracle 的文档上下文模式：收窄到相关条目（默认）或维持全文。 */
export type OracleContextMode = 'narrow' | 'full';

export interface OracleOptions {
  /**
   * 文档上下文模式：
   * - 'narrow'（默认）：只喂「该批 API 的条目 + 全局约定前言」，切断全文语境共享；
   * - 'full'：喂整篇文档（保留旧行为，用于对比或排查收窄是否切掉了依据）。
   */
  contextMode?: OracleContextMode;
  /** 引用最小长度：低于该长度的「引用」不足以支撑判定，按无效处理。 */
  minCitationLength?: number;
}

/**
 * 差分结果：除失败项与批次状态外，额外交出可观测的「加固生效情况」。
 *
 * 为什么必须显式交出这些计数：收窄若把依据切掉、或 oracle 开始编造引用，
 * 都会让「差分通过」变成假的安心。计数落到报告里，退化才看得见。
 */
export interface OracleOutcome {
  failures: OracleFailure[];
  /** 成功返回并参与判定的批次数 */
  okBatches: number;
  /** 调用 / 解析失败、被跳过的批次数 */
  failedBatches: number;
  /** oracle 判 unclear（含引用无效被降级）而被跳过的场景数 */
  unclearScenarios: number;
  /** 引用校验失败（引用了片段中不存在的原句）的场景数 */
  invalidCitations: number;
  /** 收窄时未能从场景代码提取出 API 路径、只能退回全文的场景数 */
  unresolvedTargets: number;
  /** 实际发生的上下文模式（含因缺依据而退回全文的批次） */
  contextMode: OracleContextMode;
}

/** 跑真实 ESLint，把一条约束对某场景代码的报告归约为 error / warn / ok。 */
function lintScenario(
  scenario: EngineScenario,
  constraint: Constraint,
  config: EngineConfig,
): ScenarioExpect {
  return severityOf(linter.verify(scenario.code, buildUnsupportedApiConfig([constraint], config)));
}

interface ScenarioEntry {
  constraint: Constraint;
  scenario: EngineScenario;
  actual: ScenarioExpect;
}

interface BatchEntry {
  entry: ScenarioEntry;
  /** 该场景在整轮中的全局序号（用于中性 id） */
  globalIndex: number;
}

/**
 * 文档差分：对每条约束的 determinate 场景，求 oracle 独立判定 vs 引擎真实判定，
 * 返回不一致列表 + 批次执行状态 + 加固生效计数。
 *
 * - 空约束直接返回 []，不发 LLM 请求。
 * - oracle 判 unclear（文档没说清）→ 跳过，不判失败（不拿猜测当信号）。
 * - oracle 引用无效（幻觉引用）→ 按 unclear 处理并计入 invalidCitations。
 * - oracle 遗漏某场景 → 跳过。
 * - **整批调用失败 → 计入 failedBatches**。这一点至关重要：失败批次若只被静默跳过，
 *   它与「该批全部一致」在返回值上不可区分，差分校验会退化成概率性校验
 *   （实测约 1/3 的批次会解析失败，足以把真错误整体藏起来）。
 */
export async function verifyAgainstDoc(
  doc: string,
  constraints: Constraint[],
  config: EngineConfig,
  llm: LLMClient,
  options: OracleOptions = {},
): Promise<OracleOutcome> {
  const failures: OracleFailure[] = [];
  const contextMode = options.contextMode ?? 'narrow';
  const minCitationLength = options.minCitationLength ?? 8;
  let okBatches = 0;
  let failedBatches = 0;
  let unclearScenarios = 0;
  let invalidCitations = 0;
  let unresolvedTargets = 0;

  // 1) 合成 determinate 场景并跑引擎，得到 actual
  // 只取规范形式：差分校验的职责是「数据是否忠于文档」，不是「引擎支持哪些写法」。
  // 非规范形式（别名/解构/早返回…）的期望与规范形式相同，其通过与否属于引擎缺口，
  // 由引擎自检以零 LLM 成本覆盖；放进这里只会成倍放大 LLM 成本而不增加正确性信号。
  const entries: ScenarioEntry[] = [];
  for (const constraint of constraints) {
    const scenarios = synthesizeScenarios(constraint, config).filter(
      (s) => s.kind === 'determinate' && s.formId === 'canonical',
    );
    for (const scenario of scenarios) {
      entries.push({ constraint, scenario, actual: lintScenario(scenario, constraint, config) });
    }
  }
  const outcome = (mode: OracleContextMode): OracleOutcome => ({
    failures,
    okBatches,
    failedBatches,
    unclearScenarios,
    invalidCitations,
    unresolvedTargets,
    contextMode: mode,
  });
  if (entries.length === 0) return outcome(contextMode);

  // 2) 分批求 oracle 独立判定并差分
  let usedFullDoc = contextMode === 'full';
  for (let i = 0; i < entries.length; i += ORACLE_BATCH_SIZE) {
    const batchEntries: BatchEntry[] = entries
      .slice(i, i + ORACLE_BATCH_SIZE)
      .map((entry, j) => ({ entry, globalIndex: i + j }));
    // 场景 id 用中性数字序号——不能把约束名（如 no-xxx）暴露给 oracle，
    // 否则「这条规则是禁止性的」这一提取结果会反向锚定 oracle 的独立判定。
    const views: OracleScenarioView[] = batchEntries.map(({ entry, globalIndex }) => ({
      id: `scene-${globalIndex}`,
      code: entry.scenario.code,
      version: entry.scenario.context?.version ?? '',
      platform:
        PLATFORM_LABEL[entry.scenario.context?.platform ?? 'h5'] ??
        entry.scenario.context?.platform ??
        '',
    }));

    // 输入视角收窄：只把本批场景涉及到的 API 条目 + 全局约定交给 oracle。
    // API 路径从场景代码机械提取（代码里本来就有 jue.module.method 调用），
    // 不引入任何约束数据，输入隔离不被破坏。
    let docForBatch = doc;
    if (contextMode === 'narrow') {
      const apiPaths: string[] = [];
      for (const v of views) {
        const path = extractApiPathFromCode(v.code, config.sdkName);
        if (path) apiPaths.push(path);
        else unresolvedTargets++;
      }
      const narrowed = narrowDocToApis(doc, apiPaths, config.sdkName);
      if (narrowed.fellBackToFullDoc) {
        usedFullDoc = true;
        docForBatch = doc;
      } else {
        docForBatch = narrowed.text;
      }
    }

    let verdicts: { id: string; verdict: string; cite: string; reason: string }[];
    try {
      verdicts = await llm.chatJSON(
        oracleJudgePrompt(views, docForBatch),
        oracleVerdictArraySchema,
        {
          label: 'oracle_behavior',
          temperature: 0,
          maxTokens: 8192,
          structuredOutput: true,
        },
      );
    } catch {
      // 该批 oracle 调用失败 → 跳过本批，但必须计数，交由调用方判定「本轮结论不完整」
      failedBatches++;
      continue;
    }
    okBatches++;

    const verdictById = new Map(verdicts.map((v) => [v.id, v]));
    for (const { entry, globalIndex } of batchEntries) {
      const { constraint, scenario, actual } = entry;
      const verdict = verdictById.get(`scene-${globalIndex}`);
      // oracle 遗漏 / unclear → 跳过（防评审抖动空转）
      if (!verdict || verdict.verdict === 'unclear') {
        if (verdict) unclearScenarios++;
        continue;
      }

      // 引用校验：判 error/warn/ok 必须有逐字存在的文档依据。
      // 引用无效（编造原句 / 摘录不完整）→ 该判定作废，按 unclear 处理，
      // 绝不让「编一个像样子的依据」变成通过差分的手段。
      if (!validateCitation(verdict.cite, docForBatch, minCitationLength)) {
        invalidCitations++;
        unclearScenarios++;
        continue;
      }

      if (verdict.verdict === actual) continue;

      failures.push({
        name: constraint.name,
        target: constraint.target,
        scenarioId: scenario.id,
        code: scenario.code,
        oracle: verdict.verdict as OracleFailure['oracle'],
        actual,
        oracleReason: verdict.reason || '与文档判定不一致',
      });
    }
  }

  return outcome(usedFullDoc ? 'full' : contextMode);
}
