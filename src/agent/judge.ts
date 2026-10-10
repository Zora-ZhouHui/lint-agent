// 语义评审器（LLM-as-judge，忠实度评审）：引擎自检只能证明「引擎按数据在跑」（selector /
// 解析 / severity 接线），证明不了「数据忠于文档」——minVersion 抄错、platform 写偏、
// level 标错时自检照样全绿。这里用 LLM 对照文档原文逐条评审约束忠实度
// （conditions / level / evidence / target）。
// 另有更强的文档差分（agent/oracle.ts，eval --semantic）：oracle 看不到约束数据、
// 直判具体场景代码，与引擎真实判定差分，消除本评审「看着数据评数据」的锚定偏差。
import type { LLMClient } from '../llm/client.js';
import type { Constraint, SemanticFailure } from '../types/index.js';
import { semanticVerdictArraySchema } from '../types/index.js';
import { judgeSemanticsPrompt, type JudgeConstraintView } from '../llm/prompts.js';

/** 单批评审的约束条数：控制单次输出规模，避免 verdict 被截断。 */
const JUDGE_BATCH_SIZE = 20;

/**
 * 语义评审：约束数据 vs 文档原文，返回不忠实约束的失败列表。
 * - 按批送审（每批 JUDGE_BATCH_SIZE 条），verdict 经 Zod 校验。
 * - 评审失败（LLM 调用/解析异常）不中断流程，返回空列表并交由上层日志提示——
 *   语义评审是增强信号，不能让它反过来阻塞主链路。
 * - 空约束直接返回 []，不发 LLM 请求。
 */
export async function verifySemantics(
  doc: string,
  constraints: Constraint[],
  llm: LLMClient,
  sdkName = 'jue',
): Promise<SemanticFailure[]> {
  if (constraints.length === 0) return [];

  const failures: SemanticFailure[] = [];
  for (let i = 0; i < constraints.length; i += JUDGE_BATCH_SIZE) {
    const batch = constraints.slice(i, i + JUDGE_BATCH_SIZE);
    const views: JudgeConstraintView[] = batch.map((c) => ({
      name: c.name,
      target: c.target,
      evidence: c.evidence,
      conditions: c.conditions,
      level: c.level,
    }));
    try {
      const verdicts = await llm.chatJSON(
        judgeSemanticsPrompt(views, doc, sdkName),
        semanticVerdictArraySchema,
        { label: 'judge_semantics', temperature: 0, maxTokens: 8192, structuredOutput: true },
      );
      // verdict 按 name 对齐（约束 name 唯一）；评审遗漏的条目不判失败，避免评审抖动引发空转修正
      const verdictByName = new Map(verdicts.map((v) => [v.name, v]));
      for (const c of batch) {
        const verdict = verdictByName.get(c.name);
        if (verdict && !verdict.ok) {
          failures.push({ name: c.name, target: c.target, issue: verdict.issue || '与文档不符' });
        }
      }
    } catch {
      // 评审调用失败 → 本批跳过，保持主链路可用
    }
  }
  return failures;
}
