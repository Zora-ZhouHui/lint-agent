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
// 只对 determinate 场景做差分；resolution 场景（无守卫降级 / 动态 import）的期望
// 依赖引擎自身策略，oracle 无法可比，不参与差分。
import { Linter } from 'eslint';
import type { LLMClient } from '../llm/client.js';
import type { Constraint, EngineConfig, OracleFailure, Platform } from '../types/index.js';
import { oracleVerdictArraySchema } from '../types/index.js';
import {
  synthesizeScenarios,
  type EngineScenario,
  type ScenarioExpect,
} from '../engine/behavior.js';
import { buildUnsupportedApiConfig } from '../engine/unsupported-api.js';
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

/** 跑真实 ESLint，把一条约束对某场景代码的报告归约为 error / warn / ok。 */
function lintScenario(
  scenario: EngineScenario,
  constraint: Constraint,
  config: EngineConfig,
): ScenarioExpect {
  const msgs = linter.verify(scenario.code, buildUnsupportedApiConfig([constraint], config));
  if (msgs.some((m) => m.severity === 2)) return 'error';
  if (msgs.some((m) => m.severity === 1)) return 'warn';
  return 'ok';
}

interface ScenarioEntry {
  constraint: Constraint;
  scenario: EngineScenario;
  actual: ScenarioExpect;
}

/**
 * 文档差分：对每条约束的 determinate 场景，求 oracle 独立判定 vs 引擎真实判定，
 * 返回不一致列表。
 *
 * - 空约束直接返回 []，不发 LLM 请求。
 * - oracle 判 unclear（文档没说清）→ 跳过，不判失败（不拿猜测当信号）。
 * - oracle 遗漏某场景 / 该批调用失败 → 跳过该场景/该批（增强信号不阻塞主链路）。
 */
export async function verifyAgainstDoc(
  doc: string,
  constraints: Constraint[],
  config: EngineConfig,
  llm: LLMClient,
): Promise<OracleFailure[]> {
  // 1) 合成 determinate 场景并跑引擎，得到 actual
  const entries: ScenarioEntry[] = [];
  for (const constraint of constraints) {
    const scenarios = synthesizeScenarios(constraint, config).filter(
      (s) => s.kind === 'determinate',
    );
    for (const scenario of scenarios) {
      entries.push({ constraint, scenario, actual: lintScenario(scenario, constraint, config) });
    }
  }
  if (entries.length === 0) return [];

  const failures: OracleFailure[] = [];

  // 2) 分批求 oracle 独立判定并差分
  for (let i = 0; i < entries.length; i += ORACLE_BATCH_SIZE) {
    const batchEntries = entries.slice(i, i + ORACLE_BATCH_SIZE);
    // 场景 id 用中性数字序号——不能把约束名（如 no-xxx）暴露给 oracle，
    // 否则「这条规则是禁止性的」这一提取结果会反向锚定 oracle 的独立判定。
    const views: OracleScenarioView[] = batchEntries.map(({ scenario }, j) => ({
      id: `scene-${i + j}`,
      code: scenario.code,
      version: scenario.context?.version ?? '',
      platform:
        PLATFORM_LABEL[scenario.context?.platform ?? 'h5'] ?? scenario.context?.platform ?? '',
    }));

    let verdicts: { id: string; verdict: string; reason: string }[];
    try {
      verdicts = await llm.chatJSON(oracleJudgePrompt(views, doc), oracleVerdictArraySchema, {
        label: 'oracle_behavior',
        temperature: 0,
        maxTokens: 8192,
        structuredOutput: true,
      });
    } catch {
      // 该批 oracle 调用失败 → 跳过本批，不阻塞主链路
      continue;
    }

    const verdictById = new Map(verdicts.map((v) => [v.id, v]));
    for (let j = 0; j < batchEntries.length; j++) {
      const { constraint, scenario, actual } = batchEntries[j];
      const verdict = verdictById.get(`scene-${i + j}`);
      // oracle 遗漏 / unclear → 跳过（防评审抖动空转）
      if (!verdict || verdict.verdict === 'unclear') continue;
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

  return failures;
}
