// Planner：ReAct 式决策（thought → action → actionInput）。
//
// 单引擎 + 数据文件方案后，流水线只剩 提取 → 结束 的确定性强路径，
// 没有需要 LLM 权衡的冲突状态（needsPlanner 恒 false），因此 state / auto 模式都直接走状态机；
// 仅 llm 模式保留"每步都问 LLM"的原始 ReAct 行为（决策非法时仍回退状态机）。
import type { LLMClient } from '../llm/client.js';
import type { AgentContext, PlannerDecision, PlannerMode } from '../types/index.js';
import { plannerDecisionSchema } from '../types/index.js';
import { plannerPrompt } from '../llm/prompts.js';
import { isLegalAction, legalActions, needsPlanner, nextAction } from './executor.js';

/** 给出确定性决策（不调用 LLM） */
export function deterministicDecision(context: AgentContext): PlannerDecision {
  const action = nextAction(context);
  const legal = legalActions(context);
  const scope =
    legal.length > 1 ? `当前有 ${legal.length} 个合法动作，按优先级` : '当前状态唯一合法动作是';
  return {
    thought: `${scope} ${action}，采用确定性决策（未调用 planner LLM）`,
    action,
    actionInput: {},
  };
}

export async function plan(
  context: AgentContext,
  llm: LLMClient,
  mode: PlannerMode = 'auto',
): Promise<PlannerDecision> {
  // 快路径：纯状态机模式，或 auto 模式下当前状态不需要 LLM 权衡
  if (mode === 'state' || (mode === 'auto' && !needsPlanner(context))) {
    return deterministicDecision(context);
  }

  const decision = await llm.chatJSON(
    plannerPrompt({
      constraintCount: context.constraints.length,
      failedCount: context.failures.length,
    }),
    plannerDecisionSchema,
    { label: 'planner', temperature: 0 },
  );

  if (isLegalAction(decision.action, context)) {
    return decision;
  }

  // LLM 给出了当前状态不允许的动作（如已提取却要求重新提取）
  return {
    thought: `${decision.thought}（动作 ${decision.action} 在当前状态下不合法，已回退到确定性决策）`,
    action: nextAction(context),
    actionInput: {},
  };
}
