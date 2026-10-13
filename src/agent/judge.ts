// 语义评审器（LLM-as-judge，忠实度评审）：引擎自检只能证明「引擎按数据在跑」（selector /
// 解析 / severity 接线），证明不了「数据忠于文档」——minVersion 抄错、platform 写偏、
// level 标错时自检照样全绿。这里用 LLM 对照文档原文逐条评审约束忠实度
// （conditions / level / evidence / target）。
// 另有更强的文档差分（agent/oracle.ts，eval --semantic）：oracle 看不到约束数据、
// 直判具体场景代码，与引擎真实判定差分，消除本评审「看着数据评数据」的锚定偏差。
import type { LLMClient } from '../llm/client.js';
import type { CheckOutcome, Constraint, SemanticFailure } from '../types/index.js';
import { semanticVerdictArraySchema } from '../types/index.js';
import { narrowDocToApis } from '../engine/doc-context.js';
import { judgeSemanticsPrompt, type JudgeConstraintView } from '../llm/prompts.js';

/** 单批评审的约束条数：控制单次输出规模，避免 verdict 被截断。 */
const JUDGE_BATCH_SIZE = 20;

/**
 * 语义评审：约束数据 vs 文档原文，返回不忠实约束的失败列表 + 批次执行状态。
 * - 按批送审（每批 JUDGE_BATCH_SIZE 条），verdict 经 Zod 校验。
 * - 文档按批收窄成「本批约束的 API 条目 + 全局约定前言」：评审同样存在「看着数据评数据」
 *   的锚定偏差，收窄输入可切断与提取链共享的全文语境（见 engine/doc-context.ts）。
 *   拿不到依据时退回全文，绝不因切片缺失把真问题洗成「无法判断」。
 * - 单批调用 / 解析异常不中断流程，但**必须计入 failedBatches**：否则
 *   「一批都没成功」与「全部忠实」在返回值上完全一致，校验器会静默退化。
 * - 空约束直接返回，不发 LLM 请求。
 */
export async function verifySemantics(
  doc: string,
  constraints: Constraint[],
  llm: LLMClient,
  sdkName = 'jue',
): Promise<CheckOutcome<SemanticFailure>> {
  const failures: SemanticFailure[] = [];
  let okBatches = 0;
  let failedBatches = 0;
  if (constraints.length === 0) return { failures, okBatches, failedBatches };

  for (let i = 0; i < constraints.length; i += JUDGE_BATCH_SIZE) {
    const batch = constraints.slice(i, i + JUDGE_BATCH_SIZE);
    const views: JudgeConstraintView[] = batch.map((c) => ({
      name: c.name,
      target: c.target,
      evidence: c.evidence,
      conditions: c.conditions,
      level: c.level,
    }));
    // 输入视角收窄：只把本批约束涉及的文档条目交给评审
    const narrowed = narrowDocToApis(
      doc,
      batch.map((c) => c.target),
      sdkName,
    );
    const docForBatch = narrowed.fellBackToFullDoc ? doc : narrowed.text;
    try {
      const verdicts = await llm.chatJSON(
        judgeSemanticsPrompt(views, docForBatch, sdkName),
        semanticVerdictArraySchema,
        { label: 'judge_semantics', temperature: 0, maxTokens: 8192, structuredOutput: true },
      );
      okBatches++;
      // verdict 按 name 对齐（约束 name 唯一）；评审遗漏的条目不判失败，避免评审抖动引发空转修正
      const verdictByName = new Map(verdicts.map((v) => [v.name, v]));
      for (const c of batch) {
        const verdict = verdictByName.get(c.name);
        if (verdict && !verdict.ok) {
          failures.push({ name: c.name, target: c.target, issue: verdict.issue || '与文档不符' });
        }
      }
    } catch {
      // 本批失败：不中断主链路，但计入 failedBatches，由调用方决定是否判定为「结论不完整」
      failedBatches++;
    }
  }
  return { failures, okBatches, failedBatches };
}
