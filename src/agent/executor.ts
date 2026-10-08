// Executor：把 Planner 的决策分发到对应 Skill，并维护 AgentContext
import type { LLMClient } from '../llm/client.js';
import type { AgentContext, PlannerAction, PlannerDecision } from '../types/index.js';
import { extractPatterns } from '../skills/index.js';

// ---------- 状态查询（planner / reflector 也复用这些函数） ----------

/**
 * 文档是否已经尝试过提取（无论是否提取到约束）。
 * 判据用 history 而不是 context 上的新字段，避免改动 AgentContext 的公共结构。
 */
export function hasExtracted(context: AgentContext): boolean {
  return context.history.some((h) => h.action === 'extract_patterns');
}

/**
 * 待处理工作量：提取完成即无条件约束（单引擎 + 数据文件的流水线只有提取一步）。
 */
export function pendingCount(context: AgentContext): number {
  return hasExtracted(context) ? 0 : 1;
}

/**
 * 任务是否已落定：文档一旦尝试过提取即告完成（单引擎 + 数据文件方案无逐条生成/测试）。
 * Reflector 的完成判据与 finish 动作的合法性共用这一个函数，避免两处判据漂移。
 */
export function isTaskComplete(context: AgentContext): boolean {
  return hasExtracted(context);
}

// ---------- 决策合法性（设计稿要求：校验动作是否合法） ----------

export function isLegalAction(action: PlannerAction, context: AgentContext): boolean {
  switch (action) {
    case 'extract_patterns':
      // 提取模式 只有「既没提取过、也没有约束」时，`extract_patterns` 才是合法动作。
      return !hasExtracted(context) && context.constraints.length === 0;
    case 'finish':
      return isTaskComplete(context);
    default:
      return false;
  }
}

/** 当前状态下所有合法动作 */
export function legalActions(context: AgentContext): PlannerAction[] {
  const all: PlannerAction[] = ['extract_patterns', 'finish'];
  return all.filter((action) => isLegalAction(action, context));
}

/**
 * 确定性状态机：给出当前状态下的首选动作（优先级：提取 → 结束）。
 */
export function nextAction(context: AgentContext): PlannerAction {
  return legalActions(context)[0] ?? 'finish';
}

/**
 * 是否需要动用 LLM Planner。
 * 流水线全程确定性强路径（提取 → 结束），无冲突状态，恒为 false。
 */
export function needsPlanner(_context: AgentContext): boolean {
  return false;
}

// ---------- 执行 ----------

export async function execute(
  decision: PlannerDecision,
  context: AgentContext,
  llm: LLMClient,
): Promise<string> {
  switch (decision.action) {
    case 'extract_patterns':
      // 从文档里提取约束数据行并去重
      return doExtract(context, llm);
    case 'finish':
      return '所有约束已提取，任务结束';
    default:
      return `未知动作：${String(decision.action)}`;
  }
}

async function doExtract(context: AgentContext, llm: LLMClient): Promise<string> {
  if (hasExtracted(context) || context.constraints.length > 0) {
    return '约束已提取过，跳过';
  }
  const constraints = await extractPatterns(context.inputDoc, llm);
  context.constraints = constraints;
  if (constraints.length === 0) {
    return '文档中没有可静态检测的跨端约束（已判定任务完成，不再重试提取）';
  }
  return `提取到 ${constraints.length} 条约束：${constraints.map((c) => c.name).join('、')}`;
}
