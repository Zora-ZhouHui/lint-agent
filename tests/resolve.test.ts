import { describe, expect, it } from 'vitest';
import type * as ESTree from 'estree';
import {
  complement,
  decideSeverity,
  extractVersionFromPath,
  inferGuardPlatforms,
  resolvePlatforms,
} from '../src/engine/resolve.js';
import type { Constraint } from '../src/types/index.js';
import { makeEngineConfig } from './helpers.js';

// ---------- 极简 ESTree 节点构造（仅类型/必要字段，运行时无依赖） ----------
const ident = (name: string) => ({ type: 'Identifier', name }) as unknown as ESTree.Identifier;
const lit = (value: string) =>
  ({ type: 'Literal', value, raw: JSON.stringify(value) }) as unknown as ESTree.Literal;
const unary = (operator: string, argument: ESTree.Node) =>
  ({ type: 'UnaryExpression', operator, argument, prefix: true }) as unknown as ESTree.Node;
const bin = (operator: string, left: ESTree.Node, right: ESTree.Node) =>
  ({ type: 'BinaryExpression', operator, left, right }) as unknown as ESTree.Node;
const logical = (operator: string, left: ESTree.Node, right: ESTree.Node) =>
  ({ type: 'LogicalExpression', operator, left, right }) as unknown as ESTree.Node;
const block = () => ({ type: 'BlockStatement', body: [] }) as unknown as ESTree.BlockStatement;
const call = () => ({ type: 'CallExpression', callee: ident('jue') }) as unknown as ESTree.Node;

const guards = makeEngineConfig().guards;

// ---------- 约束基座 ----------
function constraint(overrides: Partial<Constraint>): Constraint {
  return {
    name: 'no-x',
    target: 'jue.x',
    selector: 'x',
    message: 'x',
    conditions: [{ kind: 'min_version', platform: 'ios', minVersion: '2.25.0' }],
    level: 'error',
    onResolveFail: 'warn',
    evidence: 'iOS 需 jue ≥ 2.25.0',
    ...overrides,
  };
}

describe('extractVersionFromPath（import 路径 → 版本目录名）', () => {
  it('取路径末尾目录名', () => {
    expect(extractVersionFromPath('src/jue/2.25.0')).toBe('2.25.0');
    expect(extractVersionFromPath('@pkg/jue/2.10.0')).toBe('2.10.0');
  });

  it('末尾段不是版本（无数字）→ null', () => {
    expect(extractVersionFromPath('jue')).toBeNull();
    expect(extractVersionFromPath('../libs/jue/index')).toBeNull();
  });

  it('空串 → null', () => {
    expect(extractVersionFromPath('')).toBeNull();
  });
});

describe('complement（四端全集取补）', () => {
  it('补集去掉给定端', () => {
    expect(complement(['ios']).sort()).toEqual(['android', 'h5', 'harmony']);
    expect(complement(['ios', 'android']).sort()).toEqual(['h5', 'harmony']);
    expect(complement([])).toHaveLength(4);
  });
});

describe('inferGuardPlatforms（守卫测试 → 正/负平台集合）', () => {
  it('布尔 flag 真值 → 正集合', () => {
    expect(inferGuardPlatforms(ident('isIOS'), guards)).toEqual({
      kind: 'positive',
      platforms: ['ios'],
    });
  });

  it('布尔 flag 取反 → 负集合', () => {
    expect(inferGuardPlatforms(unary('!', ident('isIOS')), guards)).toEqual({
      kind: 'negative',
      platforms: ['ios'],
    });
  });

  it('environment === 字符串 → 正集合', () => {
    expect(inferGuardPlatforms(bin('===', ident('environment'), lit('ios')), guards)).toEqual({
      kind: 'positive',
      platforms: ['ios'],
    });
  });

  it('environment !== 字符串 → 负集合', () => {
    expect(inferGuardPlatforms(bin('!==', ident('environment'), lit('ios')), guards)).toEqual({
      kind: 'negative',
      platforms: ['ios'],
    });
  });

  it('多值 || 并集 → 正集合', () => {
    expect(
      inferGuardPlatforms(
        logical(
          '||',
          bin('===', ident('environment'), lit('ios')),
          bin('===', ident('environment'), lit('android')),
        ),
        guards,
      ),
    ).toEqual({ kind: 'positive', platforms: ['ios', 'android'] });
  });

  it('未知变量 / && 交集 → unrecognized', () => {
    expect(inferGuardPlatforms(ident('foo'), guards)).toEqual({ kind: 'unrecognized' });
    expect(inferGuardPlatforms(logical('&&', ident('isIOS'), ident('flag')), guards)).toEqual({
      kind: 'unrecognized',
    });
  });
});

describe('resolvePlatforms（祖先守卫 → 候选端集合）', () => {
  it('consequent 分支 → 该端', () => {
    const consequent = block();
    const ifStmt = {
      type: 'IfStatement',
      test: ident('isIOS'),
      consequent,
      alternate: null,
    } as unknown as ESTree.IfStatement;
    expect(resolvePlatforms(call(), [ifStmt, consequent], guards)).toEqual({
      status: 'ok',
      platforms: ['ios'],
    });
  });

  it('else 分支 → 补集（其余三端）', () => {
    const alternate = block();
    const ifStmt = {
      type: 'IfStatement',
      test: ident('isIOS'),
      consequent: block(),
      alternate,
    } as unknown as ESTree.IfStatement;
    const result = resolvePlatforms(call(), [ifStmt, alternate], guards);
    expect(result.status).toBe('ok');
    expect(result).toMatchObject({ status: 'ok' });
    if (result.status === 'ok')
      expect(result.platforms.sort()).toEqual(['android', 'h5', 'harmony']);
  });

  it('无守卫 → fail no-guard', () => {
    expect(resolvePlatforms(call(), [], guards)).toEqual({ status: 'fail', reason: 'no-guard' });
  });

  it('守卫形态不识别 → fail unrecognized', () => {
    const consequent = block();
    const ifStmt = {
      type: 'IfStatement',
      test: ident('foo'),
      consequent,
      alternate: null,
    } as unknown as ESTree.IfStatement;
    expect(resolvePlatforms(call(), [ifStmt, consequent], guards)).toEqual({
      status: 'fail',
      reason: 'unrecognized',
    });
  });
});

describe('decideSeverity（三级校验）', () => {
  const order = makeEngineConfig().order;

  it('level=warn → 一律 warn', () => {
    const c = constraint({ level: 'warn' });
    expect(
      decideSeverity(
        c,
        { status: 'fail', reason: 'no-import' },
        { status: 'fail', reason: 'no-guard' },
        order,
      ),
    ).toBe('warn');
  });

  it('空 conditions（L1）→ error（无需解析）', () => {
    const c = constraint({ conditions: [] });
    expect(
      decideSeverity(
        c,
        { status: 'fail', reason: 'no-import' },
        { status: 'fail', reason: 'no-guard' },
        order,
      ),
    ).toBe('error');
  });

  it('解析成功且违规 → error', () => {
    expect(
      decideSeverity(
        constraint({}),
        { status: 'ok', version: '2.20.0' },
        { status: 'ok', platforms: ['ios'] },
        order,
      ),
    ).toBe('error');
  });

  it('解析成功且不违规 → null（不报）', () => {
    expect(
      decideSeverity(
        constraint({}),
        { status: 'ok', version: '2.25.0' },
        { status: 'ok', platforms: ['ios'] },
        order,
      ),
    ).toBeNull();
  });

  it('版本不可静态提取（dynamic）→ 静默跳过', () => {
    const c = constraint({ onResolveFail: 'warn' });
    expect(
      decideSeverity(
        c,
        { status: 'skip', reason: 'dynamic' },
        { status: 'ok', platforms: ['ios'] },
        order,
      ),
    ).toBeNull();
  });

  it('解析失败 + onResolveFail=warn → warn', () => {
    expect(
      decideSeverity(
        constraint({}),
        { status: 'fail', reason: 'no-import' },
        { status: 'ok', platforms: ['ios'] },
        order,
      ),
    ).toBe('warn');
  });

  it('解析失败 + onResolveFail=skip → 不报', () => {
    const c = constraint({ onResolveFail: 'skip' });
    expect(
      decideSeverity(
        c,
        { status: 'fail', reason: 'no-import' },
        { status: 'ok', platforms: ['ios'] },
        order,
      ),
    ).toBeNull();
  });
});
