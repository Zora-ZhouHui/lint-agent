import { describe, expect, it } from 'vitest';
import { coversPlatforms, matchConstraint, platformsOf } from '../src/cli/commands/eval.js';
import type { Constraint, ExpectedRule } from '../src/types/index.js';

function constraint(overrides: Partial<Constraint>): Constraint {
  return {
    name: 'no-fetch-directly',
    selector: 'CallExpression[callee.name="fetch"]',
    message: '禁止 fetch',
    conditions: [],
    level: 'error',
    onResolveFail: 'warn',
    ...overrides,
  };
}

const expected: ExpectedRule = {
  name: 'no-fetch-directly',
  target: 'fetch',
  platforms: ['h5', 'harmony'],
};

describe('platformsOf（从 conditions 推导覆盖端）', () => {
  it('空 conditions → 全端', () => {
    expect(platformsOf(constraint({ conditions: [] })).sort()).toEqual([
      'android',
      'h5',
      'harmony',
      'ios',
    ]);
  });

  it('有 conditions → 取平台并集', () => {
    expect(
      platformsOf(
        constraint({
          conditions: [
            { kind: 'unsupported', platform: 'ios' },
            { kind: 'min_version', platform: 'android', minVersion: '2.6.0' },
          ],
        }),
      ).sort(),
    ).toEqual(['android', 'ios']);
  });
});

describe('matchConstraint 语义匹配', () => {
  it('名字一致且平台超集 → 命中', () => {
    expect(matchConstraint(constraint({ conditions: [] }), expected)).toBe(true);
  });

  it('名字不一致 → 不命中', () => {
    expect(matchConstraint(constraint({ name: 'no-fetch' }), expected)).toBe(false);
  });

  it('漏掉期望平台 → 不命中', () => {
    expect(
      matchConstraint(
        constraint({ conditions: [{ kind: 'unsupported', platform: 'h5' }] }),
        expected,
      ),
    ).toBe(false);
  });
});

describe('coversPlatforms', () => {
  it('超集覆盖 → true', () => {
    expect(coversPlatforms(['h5', 'android', 'ios', 'harmony'], ['h5', 'harmony'])).toBe(true);
  });
  it('漏标 → false', () => {
    expect(coversPlatforms(['h5'], ['h5', 'harmony'])).toBe(false);
  });
});
