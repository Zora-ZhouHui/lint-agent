import { describe, expect, it, vi } from 'vitest';
import type { LLMClient } from '../src/llm/client.js';
import type { AgentContext, PlannerDecision } from '../src/types/index.js';
import { plan } from '../src/agent/planner.js';
import { makeContext } from './helpers.js';

/** 记录调用次数的假 LLM */
function scriptedLLM(decision: PlannerDecision) {
  const chatJSON = vi.fn(async () => decision);
  return { client: { chatJSON } as unknown as LLMClient, chatJSON };
}

/** 已提取过的状态（唯一合法动作是 finish） */
function extractedContext(): AgentContext {
  return makeContext({
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
}

describe('plan 快路径：确定性状态不调用 LLM', () => {
  it('auto 模式下未提取时跳过 LLM，直接给 extract_patterns', async () => {
    const { client, chatJSON } = scriptedLLM({
      thought: '先提取',
      action: 'extract_patterns',
      actionInput: {},
    });

    const result = await plan(makeContext(), client, 'auto');

    expect(chatJSON).not.toHaveBeenCalled();
    expect(result.action).toBe('extract_patterns');
    expect(result.thought).toContain('确定性决策');
  });

  it('state 模式下已提取时给 finish，不调用 LLM', async () => {
    const { client, chatJSON } = scriptedLLM({
      thought: '结束',
      action: 'finish',
      actionInput: {},
    });

    const result = await plan(extractedContext(), client, 'state');

    expect(chatJSON).not.toHaveBeenCalled();
    expect(result.action).toBe('finish');
  });
});

describe('plan llm 模式', () => {
  it('llm 模式每步都问 LLM（即使状态唯一）', async () => {
    const decision: PlannerDecision = {
      thought: '提取',
      action: 'extract_patterns',
      actionInput: {},
    };
    const { client, chatJSON } = scriptedLLM(decision);

    const result = await plan(makeContext(), client, 'llm');

    expect(chatJSON).toHaveBeenCalledTimes(1);
    expect(result).toEqual(decision);
  });

  it('LLM 决策非法时回退确定性状态机', async () => {
    // 已提取状态，唯一合法动作是 finish；LLM 却要求重新 extract
    const { client } = scriptedLLM({
      thought: '重新提取',
      action: 'extract_patterns',
      actionInput: {},
    });

    const result = await plan(extractedContext(), client, 'llm');

    expect(result.action).toBe('finish');
    expect(result.thought).toContain('不合法');
  });
});
