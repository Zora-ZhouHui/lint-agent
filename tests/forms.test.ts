import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import type * as ESTree from 'estree';
import { synthesizeScenarios } from '../src/engine/behavior.js';
import {
  BUILTIN_FORMS,
  CANONICAL_FORM,
  NON_CANONICAL_FORMS,
  type CallFormContext,
} from '../src/engine/forms.js';
import { defaultEngineConfig } from '../src/engine/default-config.js';
import { jueGetSystemInfoConstraint } from './helpers.js';

const linter = new Linter({ configType: 'flat' });

/** 沿成员访问链自内向外收集标识符名，如 jue.system.getSystemInfo() → ['jue','system','getSystemInfo']。 */
function calleeChain(callee: ESTree.Node): string[] {
  const parts: string[] = [];
  let cur: ESTree.Node | undefined = callee;
  while (cur) {
    if (cur.type === 'Identifier') {
      parts.unshift(cur.name);
      cur = undefined;
    } else if (
      cur.type === 'MemberExpression' &&
      !cur.computed &&
      cur.property.type === 'Identifier'
    ) {
      parts.unshift(cur.property.name);
      cur = cur.object;
    } else {
      break;
    }
  }
  return parts;
}

interface CodeFacts {
  version: string | null;
  chain: string[];
  guardFlag: string | null;
}

/**
 * 用真实 ESLint 解析代码，抽出「语义事实」：import 版本、调用标识符链、平台守卫变量。
 * 形式只允许改变根标识与语句组织方式，这三者必须与规范形式保持等价。
 */
function analyze(code: string): CodeFacts {
  const facts: CodeFacts = { version: null, chain: [], guardFlag: null };
  const rule = {
    meta: { schema: [] },
    create(_context: unknown) {
      return {
        ImportDeclaration(node: ESTree.ImportDeclaration) {
          const src = String(node.source.value);
          facts.version = src.split('/').filter(Boolean).pop() ?? null;
        },
        CallExpression(node: ESTree.CallExpression) {
          if (facts.chain.length === 0) facts.chain = calleeChain(node.callee);
        },
        IfStatement(node: ESTree.IfStatement) {
          const t = node.test;
          if (t.type === 'Identifier') facts.guardFlag ??= t.name;
          else if (
            t.type === 'UnaryExpression' &&
            t.operator === '!' &&
            t.argument.type === 'Identifier'
          )
            facts.guardFlag ??= t.argument.name;
        },
      };
    },
  };
  const config = {
    plugins: { probe: { rules: { facts: rule } } },
    rules: { 'probe/facts': 'error' },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  } as unknown as Linter.Config;
  linter.verify(code, config);
  return facts;
}

/**
 * 语义键：版本 + SDK 相对路径 + 平台守卫。
 * SDK 相对路径取调用标识符链的**末 N 位**（N = target 去掉 sdkName 后的段数），
 * 从而对「根标识是否为 jue」不敏感——正是各形式允许变化的部分。
 */
function semKey(
  code: string,
  target: string,
): { version: string | null; path: string; guard: string | null } {
  const n = target.split('.').length - 1;
  const f = analyze(code);
  return { version: f.version, path: f.chain.slice(-n).join('.'), guard: f.guardFlag };
}

const CTX: CallFormContext = {
  target: 'jue.system.getSystemInfo',
  version: '2.25.0',
  flag: 'isIOS',
};

describe('CallForm（调用形式目录）', () => {
  it('规范形式必须与历史骨架逐字一致（产物与既有测试依赖它）', () => {
    expect(CANONICAL_FORM.render(CTX)).toBe(
      "import jue from './jue/2.25.0';\nif (isIOS) {\n  jue.system.getSystemInfo();\n}\n",
    );
    expect(CANONICAL_FORM.render({ ...CTX, flag: null })).toBe(
      "import jue from './jue/2.25.0';\njue.system.getSystemInfo();\n",
    );
  });

  it('same 形式与规范形式语义等价：版本 / SDK 相对路径 / 平台守卫三者一致', () => {
    const expected = { version: '2.25.0', path: 'system.getSystemInfo', guard: 'isIOS' };
    expect(semKey(CANONICAL_FORM.render(CTX) as string, CTX.target)).toEqual(expected);

    for (const form of NON_CANONICAL_FORMS.filter((f) => f.resolution === 'same')) {
      const code = form.render(CTX);
      expect(code, `${form.id} 应适用于带守卫的上下文`).not.toBeNull();
      expect(semKey(code as string, CTX.target), `${form.id} 语义必须与规范形式一致`).toEqual(
        expected,
      );
    }
  });

  it('无守卫上下文：早返回形式不适用（返回 null），其余形式仍语义等价', () => {
    const flagless: CallFormContext = { ...CTX, flag: null };
    const expected = { version: '2.25.0', path: 'system.getSystemInfo', guard: null };
    expect(semKey(CANONICAL_FORM.render(flagless) as string, CTX.target)).toEqual(expected);

    for (const form of NON_CANONICAL_FORMS.filter((f) => f.resolution === 'same')) {
      const code = form.render(flagless);
      if (code === null) continue;
      expect(semKey(code, CTX.target), `${form.id} 在无守卫上下文仍须语义等价`).toEqual(expected);
    }
    expect(BUILTIN_FORMS.find((f) => f.id === 'early-return')?.render(flagless)).toBeNull();
  });

  it('两段路径（jue.method）也能被所有适用形式正确渲染', () => {
    const ctx: CallFormContext = { target: 'jue.vibrate', version: '2.6.0', flag: 'isAndroid' };
    const expected = { version: '2.6.0', path: 'vibrate', guard: 'isAndroid' };
    for (const form of BUILTIN_FORMS) {
      const code = form.render(ctx);
      if (code === null) continue;
      expect(semKey(code, ctx.target), form.id).toEqual(expected);
    }
  });
});

describe('synthesizeScenarios 的形式展开', () => {
  it('默认只展开规范形式（保持历史行为与产物稳定）', () => {
    const scenarios = synthesizeScenarios(jueGetSystemInfoConstraint, defaultEngineConfig);
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.every((s) => s.formId === 'canonical')).toBe(true);
    expect(scenarios.every((s) => !s.id.includes('@'))).toBe(true);
  });

  it('传入 forms 后：决策集合不变，且同一决策下各形式 expect 完全一致', () => {
    const base = synthesizeScenarios(jueGetSystemInfoConstraint, defaultEngineConfig);
    const expanded = synthesizeScenarios(jueGetSystemInfoConstraint, defaultEngineConfig, {
      forms: BUILTIN_FORMS,
    });
    const strip = (id: string) => id.split('@')[0];

    // 决策集合必须与规范形式一一对应（不多不少）
    expect(new Set(expanded.map((s) => strip(s.id)))).toEqual(new Set(base.map((s) => s.id)));

    // 同一决策下，所有形式的 expect 必须相同——形式不参与期望计算
    const byDecision = new Map<string, Set<string>>();
    for (const s of expanded) {
      const set = byDecision.get(strip(s.id)) ?? new Set<string>();
      set.add(s.expect);
      byDecision.set(strip(s.id), set);
    }
    for (const [decision, expects] of byDecision) {
      expect(expects.size, `${decision} 下各形式的期望出现了分歧`).toBe(1);
    }

    // 早返回形式对无守卫的 resolution 场景不适用 → 总数少于 决策数 × 形式数
    expect(expanded.length).toBeLessThan(base.length * BUILTIN_FORMS.length);
    expect(expanded.length).toBeGreaterThan(base.length);
  });

  it('展开不改变规范形式场景的代码与期望（向后兼容）', () => {
    const base = synthesizeScenarios(jueGetSystemInfoConstraint, defaultEngineConfig);
    const expanded = synthesizeScenarios(jueGetSystemInfoConstraint, defaultEngineConfig, {
      forms: BUILTIN_FORMS,
    });
    for (const b of base) {
      const same = expanded.find((s) => s.id === b.id);
      expect(same, `规范形式场景 ${b.id} 展开后应原样保留`).toBeDefined();
      expect(same?.code).toBe(b.code);
      expect(same?.expect).toBe(b.expect);
      expect(same?.formId).toBe('canonical');
    }
  });
});

describe('形式目录的完整性约束', () => {
  it('每个形式都有唯一 id 与非空说明，resolution 取值合法', () => {
    const ids = BUILTIN_FORMS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of BUILTIN_FORMS) {
      expect(f.description.length).toBeGreaterThan(0);
      expect(['same', 'degraded']).toContain(f.resolution);
    }
  });

  it('规范形式位于目录首位且 resolution 为 same', () => {
    expect(BUILTIN_FORMS[0].id).toBe('canonical');
    expect(CANONICAL_FORM.resolution).toBe('same');
  });
});
