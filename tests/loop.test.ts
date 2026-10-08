import { describe, expect, it } from 'vitest';
import type { ZodType, ZodTypeDef } from 'zod';
import { LLMClient } from '../src/llm/client.js';
import type { ChatOptions, Constraint, Message } from '../src/types/index.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { Tracer } from '../src/agent/trace.js';
import { hasOwnConstraint } from './helpers.js';

/**
 * 集成测试：脚本化 LLM 跑通完整循环
 * extract_patterns → 提取约束 → Reflector 判完成 → 结束
 */
class ScriptedLLM extends LLMClient {
  /** planner 被调用（或尝试调用）的次数——用于断言快路径确实省下了 LLM 调用 */
  plannerCalls = 0;

  constructor(private constraints: Constraint[] = [hasOwnConstraint]) {
    super({ provider: 'openai', model: 'test', apiKey: 'test', maxRetries: 0, timeoutMs: 1000 });
  }

  override async chatJSON<T>(
    _messages: Message[],
    _schema: ZodType<T, ZodTypeDef, unknown>,
    options?: ChatOptions,
  ): Promise<T> {
    if (options?.label === 'planner') {
      this.plannerCalls += 1;
      return {} as T;
    }
    if (options?.label === 'extract_patterns') {
      return this.constraints as T;
    }
    throw new Error(`未预期的 chatJSON 调用：${options?.label}`);
  }
}

describe('runAgentLoop 集成', () => {
  it('完整跑通：提取约束后 Reflector 判完成，单步收敛', async () => {
    const llm = new ScriptedLLM();
    const tracer = new Tracer('/tmp/lint-agent-test-trace.jsonl');

    const context = await runAgentLoop('文档内容', llm, {
      maxSteps: 10,

      tracer,
    });

    expect(context.constraints).toHaveLength(1);
    expect(context.failures).toHaveLength(0);
    expect(context.history.map((h) => h.action)).toEqual(['extract_patterns']);
    expect(context.history.every((h) => h.tokensUsed !== undefined)).toBe(true);
    // 快路径：整条流水线无冲突，一次 planner LLM 都不该调用
    expect(llm.plannerCalls).toBe(0);
  }, 30000);

  it('文档中没有可提取约束时收敛为 1 步，而不是空转到 maxSteps', async () => {
    const llm = new ScriptedLLM([]); // 提取结果为空数组
    const tracer = new Tracer('/tmp/lint-agent-test-trace.jsonl');

    const context = await runAgentLoop('只有一条无法静态检测的约定', llm, {
      maxSteps: 20,

      tracer,
    });

    expect(context.constraints).toHaveLength(0);
    expect(context.history).toHaveLength(1);
    expect(context.history[0].action).toBe('extract_patterns');
    expect(context.failures).toHaveLength(0);
    expect(llm.plannerCalls).toBe(0);
  }, 30000);
});
