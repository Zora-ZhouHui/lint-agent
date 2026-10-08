// Reflector：判断任务是否完成
// 设计要点：优先用规则判断——"是否已提取"是确定性问题，
// 没必要花 token 问 LLM；只有状态异常（规则判断不可用）时才降级到 LLM。
import type { LLMClient } from '../llm/client.js';
import type { AgentContext, ReflectionResult } from '../types/index.js';
import { reflectionResultSchema } from '../types/index.js';
import { reflectorPrompt } from '../llm/prompts.js';
import { hasExtracted, isTaskComplete } from './executor.js';

export async function reflect(context: AgentContext, llm: LLMClient): Promise<ReflectionResult> {
  try {
    const done = isTaskComplete(context);
    return {
      done,
      reason: done ? reasonForDone(context) : '还需提取约束',
      shouldContinue: !done,
    };
  } catch {
    // 防御分支：状态异常导致规则判断不可用时，降级问 LLM
    const result = await llm.chatJSON(
      reflectorPrompt({
        constraintCount: context.constraints.length,
        failedCount: context.failures.length,
      }),
      reflectionResultSchema,
      { label: 'reflector', temperature: 0 },
    );
    return {
      done: result.done,
      reason: result.reason,
      shouldContinue: result.shouldContinue ?? !result.done,
    };
  }
}

function reasonForDone(context: AgentContext): string {
  // 提取完成但一条约束都没有：文档里没有可静态检测的约束，同样是"完成"
  if (context.constraints.length === 0 && hasExtracted(context)) {
    return '文档中没有可静态检测的跨端约束，任务结束';
  }
  return (
    `已提取 ${context.constraints.length} 条约束` +
    (context.failures.length > 0 ? `（其中 ${context.failures.length} 条最终失败，已记录）` : '')
  );
}
