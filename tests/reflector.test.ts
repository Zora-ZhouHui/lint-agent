import { describe, expect, it } from 'vitest';
import type { AgentStep } from '../src/types/index.js';
import { reflect } from '../src/agent/reflector.js';
import { makeContext, atConstraint } from './helpers.js';

const llm = {} as never; // 规则判断路径不触达 LLM

function extractStep(): AgentStep {
  return {
    step: 1,
    thought: '',
    action: 'extract_patterns',
    actionInput: {},
    observation: '',
    timestamp: 0,
    durationMs: 0,
  };
}

describe('reflect 规则判断优先', () => {
  it('未提取 → 未完成', async () => {
    const result = await reflect(makeContext(), llm);
    expect(result.done).toBe(false);
    expect(result.shouldContinue).toBe(true);
  });

  it('文档里没有可提取约束（已提取过）→ 完成，且不空转', async () => {
    const context = makeContext({ constraints: [], history: [extractStep()] });
    const result = await reflect(context, llm);
    expect(result.done).toBe(true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toContain('没有可静态检测');
  });

  it('已提取到多条约束 → 完成', async () => {
    const context = makeContext({
      constraints: [atConstraint],
      history: [extractStep()],
    });
    const result = await reflect(context, llm);
    expect(result.done).toBe(true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toContain('已提取 1 条约束');
  });

  it('有失败记录 → reason 提及失败数', async () => {
    const context = makeContext({
      constraints: [atConstraint],
      history: [extractStep()],
      failures: ['extract_patterns 执行失败：boom'],
    });
    const result = await reflect(context, llm);
    expect(result.done).toBe(true);
    expect(result.reason).toContain('1 条最终失败');
  });
});
