import { describe, expect, it } from 'vitest';
import type { AgentStep } from '../src/types/index.js';
import {
  hasExtracted,
  isLegalAction,
  isTaskComplete,
  legalActions,
  needsPlanner,
  nextAction,
  pendingCount,
} from '../src/agent/executor.js';
import { makeContext, atConstraint } from './helpers.js';

function step(action: AgentStep['action']): AgentStep {
  return {
    step: 1,
    thought: '',
    action,
    actionInput: {},
    observation: '',
    timestamp: 0,
    durationMs: 0,
  };
}

describe('确定性状态机', () => {
  it('初始状态：唯一合法动作是 extract_patterns（finish 不合法）', () => {
    const context = makeContext();
    expect(legalActions(context)).toEqual(['extract_patterns']);
    expect(needsPlanner(context)).toBe(false);
    expect(isTaskComplete(context)).toBe(false);
    expect(pendingCount(context)).toBe(1);
  });

  it('提取后：finish 合法且任务完成', () => {
    const context = makeContext({
      constraints: [atConstraint],
      history: [step('extract_patterns')],
    });
    expect(nextAction(context)).toBe('finish');
    expect(isLegalAction('finish', context)).toBe(true);
    expect(isTaskComplete(context)).toBe(true);
    expect(pendingCount(context)).toBe(0);
    expect(needsPlanner(context)).toBe(false);
  });
});

describe('空文档不再空转（回归）', () => {
  it('提取过一次后就认为落定，extract/finish 的合法性同步翻转', () => {
    const context = makeContext({
      constraints: [],
      history: [step('extract_patterns')],
    });

    expect(hasExtracted(context)).toBe(true);
    // 关键：extract_patterns 不再合法，否则循环会反复提取直到 maxSteps
    expect(isLegalAction('extract_patterns', context)).toBe(false);
    expect(legalActions(context)).toEqual(['finish']);
    expect(isTaskComplete(context)).toBe(true);
  });

  it('没有提取记录时 extract_patterns 仍然合法', () => {
    const context = makeContext({ constraints: [] });
    expect(hasExtracted(context)).toBe(false);
    expect(isLegalAction('extract_patterns', context)).toBe(true);
    expect(isTaskComplete(context)).toBe(false);
  });
});
