// Agent 主循环：Planner → Executor → Reflector 的循环
// 防死循环（关键要求 4）：maxSteps 硬上限 + Reflector 规则判断收敛
import type { LLMClient } from '../llm/client.js';
import type { AgentContext, PlannerMode } from '../types/index.js';
import { Tracer } from './trace.js';
import { plan } from './planner.js';
import { execute, nextAction } from './executor.js';
import { reflect } from './reflector.js';

export interface AgentLoopOptions {
  maxSteps: number;
  /** Planner 决策模式，默认 auto（确定性状态机，不调用 LLM） */
  plannerMode?: PlannerMode;
  /** 传入则实时打印每一步并在结束时调用 save()；循环内部默认也会打印 */
  tracer?: Tracer;
}

export async function runAgentLoop(
  doc: string,
  llm: LLMClient,
  options: AgentLoopOptions,
): Promise<AgentContext> {
  const context: AgentContext = {
    inputDoc: doc,
    constraints: [],
    currentStep: 0,
    maxSteps: options.maxSteps,
    history: [],
    failures: [],
  };
  const tracer = options.tracer ?? new Tracer();

  while (context.currentStep < context.maxSteps) {
    context.currentStep += 1;
    const stepStart = Date.now();
    const tokensBefore = llm.getTotalTokens();

    let decision;
    try {
      decision = await plan(context, llm, options.plannerMode ?? 'auto');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      decision = {
        thought: `planner 不可用（${msg.slice(0, 120)}），使用确定性决策`,
        action: nextAction(context),
        actionInput: {},
      };
      console.warn(`⚠ planner 失败，已回退确定性决策：${decision.action}`);
    }

    // b. executor 执行动作（单步失败不中断循环：记录后由 planner 重新决策，self-heal）
    let observation: string;
    try {
      observation = await execute(decision, context, llm);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      observation = `执行出错：${msg}`;
      context.failures.push(`${decision.action} 执行失败：${msg.slice(0, 300)}`);
    }

    // c. 记录 trace 并实时打印，每步落盘（可恢复）
    const step = {
      step: context.currentStep,
      thought: decision.thought,
      action: decision.action,
      actionInput: decision.actionInput,
      observation,
      timestamp: Date.now(),
      durationMs: Date.now() - stepStart,
      tokensUsed: llm.getTotalTokens() - tokensBefore,
    };
    context.history.push(step);
    tracer.append(step);
    tracer.save();
    tracer.printStep(step);

    const reflection = await reflect(context, llm);

    // e. done 则 break
    if (!reflection.shouldContinue) {
      console.log(`\nReflector：${reflection.reason}`);
      break;
    }
  }

  if (context.currentStep >= context.maxSteps && context.history.length >= context.maxSteps) {
    console.warn(`\n⚠ 已达最大步数上限（${context.maxSteps}），强制结束`);
  }

  return context;
}
