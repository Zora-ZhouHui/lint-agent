import { describe, expect, it } from 'vitest';
import type { ZodType, ZodTypeDef } from 'zod';
import { LLMClient } from '../src/llm/client.js';
import type { ChatOptions, Constraint, Message } from '../src/types/index.js';
import { extractConstraints } from '../src/agent/extract.js';
import { Tracer } from '../src/agent/trace.js';
import { jueGetSystemInfoConstraint } from './helpers.js';

/** 脚本化 LLM：提取阶段返回预设约束，或按需抛错。 */
class ScriptedLLM extends LLMClient {
  constructor(private constraints: Constraint[] = [jueGetSystemInfoConstraint]) {
    super({ provider: 'openai', model: 'test', apiKey: 'test', maxRetries: 0, timeoutMs: 1000 });
  }

  override async chatJSON<T>(
    _messages: Message[],
    _schema: ZodType<T, ZodTypeDef, unknown>,
    options?: ChatOptions,
  ): Promise<T> {
    if (options?.label === 'extract_patterns') {
      return this.constraints as T;
    }
    throw new Error(`未预期的 chatJSON 调用：${options?.label}`);
  }
}

describe('extractConstraints（确定性提取，无 planner/reflector 循环）', () => {
  it('成功提取约束并落盘单步 trace', async () => {
    const llm = new ScriptedLLM();
    const tracer = new Tracer('/tmp/lint-agent-test-trace.jsonl');

    const result = await extractConstraints('文档内容', llm, { tracer });

    expect(result.constraints).toHaveLength(1);
    expect(result.error).toBeUndefined();
    expect(tracer.all).toHaveLength(1);
    expect(tracer.all[0].tokensUsed).not.toBeUndefined();
  }, 30000);

  it('空文档不报错，返回空约束', async () => {
    const llm = new ScriptedLLM([]);

    const result = await extractConstraints('只有一条无法静态检测的约定', llm, {
      tracer: new Tracer('/tmp/lint-agent-test-trace.jsonl'),
    });

    expect(result.constraints).toHaveLength(0);
    expect(result.error).toBeUndefined();
  }, 30000);

  it('提取抛错时带 error 返回，不中断', async () => {
    class FailingLLM extends LLMClient {
      constructor() {
        super({
          provider: 'openai',
          model: 'test',
          apiKey: 'test',
          maxRetries: 0,
          timeoutMs: 1000,
        });
      }
      override async chatJSON<T>(): Promise<T> {
        throw new Error('boom');
      }
    }
    const llm = new FailingLLM();

    const result = await extractConstraints('文档', llm, {
      tracer: new Tracer('/tmp/lint-agent-test-trace.jsonl'),
    });

    expect(result.constraints).toHaveLength(0);
    expect(result.error).toBe('boom');
  }, 30000);
});
