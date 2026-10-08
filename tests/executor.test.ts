import { describe, expect, it, vi } from 'vitest';
import type { PlannerDecision } from '../src/types/index.js';
import { execute } from '../src/agent/executor.js';
import { makeContext, atConstraint } from './helpers.js';

// mock 掉 Skill，聚焦 executor 的状态维护逻辑
vi.mock('../src/skills/index.js', () => ({
  extractPatterns: vi.fn(async () => [atConstraint]),
}));

const llm = {} as never;

describe('execute', () => {
  it('extract_patterns 更新 context.constraints', async () => {
    const context = makeContext();
    const decision: PlannerDecision = { thought: '', action: 'extract_patterns', actionInput: {} };
    const observation = await execute(decision, context, llm);
    expect(context.constraints).toHaveLength(1);
    expect(observation).toContain('提取到 1 条约束');
  });

  it('已提取过则跳过且不重复提取', async () => {
    const context = makeContext({
      constraints: [atConstraint],
      history: [
        {
          step: 1,
          thought: '',
          action: 'extract_patterns',
          actionInput: {},
          observation: '',
          timestamp: 0,
          durationMs: 0,
        },
      ],
    });
    const decision: PlannerDecision = { thought: '', action: 'extract_patterns', actionInput: {} };
    const observation = await execute(decision, context, llm);
    expect(observation).toContain('已提取过');
  });

  it('finish 返回结束观察', async () => {
    const context = makeContext({
      constraints: [atConstraint],
      history: [
        {
          step: 1,
          thought: '',
          action: 'extract_patterns',
          actionInput: {},
          observation: '',
          timestamp: 0,
          durationMs: 0,
        },
      ],
    });
    const decision: PlannerDecision = { thought: '', action: 'finish', actionInput: {} };
    expect(await execute(decision, context, llm)).toContain('任务结束');
  });
});
