// 调用点级解析器（版本 = import 路径、平台 = 运行时守卫）+ 三级校验 severity 决策。
// 这里的判定逻辑都是「纯函数 + 明确输入」，版本解析依赖 ESLint scope（jue 绑定 → import 源），
// 平台解析只依赖 ESTree 节点与守卫配置，均可独立单测。
import type * as ESTree from 'estree';
import type { Scope } from 'eslint';
import type { Constraint, Platform } from '../types/index.js';
import { PLATFORM_VALUES } from '../types/index.js';
import { isViolation } from './conditions.js';

// ---------- 守卫配置（取自 EngineConfig.guards） ----------

export type GuardConfig = {
  booleanFlags: Record<string, Platform>;
  envVar: string;
  envValues: Record<string, Platform>;
};

// ---------- 解析结果类型 ----------

/** 版本解析结果。ok=成功；skip=版本不可静态提取（动态路径）；fail=解析失败降级。 */
export type VersionResolution =
  | { status: 'ok'; version: string }
  | { status: 'skip'; reason: 'dynamic' }
  | { status: 'fail'; reason: 'no-import' | 'no-version' };

/** 平台解析结果。ok=得到候选端集合；fail=解析失败降级（无守卫 / 守卫形态不识别）。 */
export type PlatformResolution =
  { status: 'ok'; platforms: Platform[] } | { status: 'fail'; reason: 'no-guard' | 'unrecognized' };

// ---------- 版本解析（纯字符串 + scope） ----------

/**
 * 从 import 路径静态串提取末尾目录名作为版本（约定 `import jue from '.../jue/<版本>'`）。
 * 末尾段含数字才视为版本（如 `2.25.0`），否则返回 null（如裸说明符 'jue'）。
 */
export function extractVersionFromPath(source: string): string | null {
  const segments = source.split(/[\\/]/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last || !/\d/.test(last)) return null;
  return last;
}

/**
 * 从根标识（如 jue）出发，用 ESLint scope 追其 ImportBinding，取 import 源字面量。
 * - 静态 `import jue from '.../jue/<V>'` → ok + 版本 V
 * - 模板字符串 import 源（含表达式，bundler 扩展语法）→ skip（版本不可静态提取）
 * - 无 ImportBinding（全局注入 / `const jue = await import(...)` / 别名）→ fail no-import
 * - import 但路径末尾无版本 → fail no-version
 */
export function resolveVersion(root: ESTree.Identifier, scope: Scope.Scope): VersionResolution {
  let current: Scope.Scope | null = scope;
  while (current) {
    const variable = current.set.get(root.name);
    if (variable) {
      const importDef = variable.defs.find((d) => d.type === 'ImportBinding');
      if (!importDef) return { status: 'fail', reason: 'no-import' };
      // ImportDeclaration.source 类型标注为 Literal，但 bundler 扩展语法下可能是 TemplateLiteral
      const sourceNode = importDef.parent.source as ESTree.Node;
      // 模板字符串 import 源：版本依赖运行时变量，无法静态提取
      if (sourceNode.type === 'TemplateLiteral') {
        return { status: 'skip', reason: 'dynamic' };
      }
      if (sourceNode.type === 'Literal' && typeof sourceNode.value === 'string') {
        const version = extractVersionFromPath(sourceNode.value);
        return version ? { status: 'ok', version } : { status: 'fail', reason: 'no-version' };
      }
      return { status: 'fail', reason: 'no-import' };
    }
    current = current.upper;
  }
  return { status: 'fail', reason: 'no-import' };
}

/**
 * 从命中节点取出最左根标识（jue.xxx、jue.module.method 的根）。
 * 只处理 identifier / 成员访问 / 调用 / 可选链包裹，非这些形态返回 null。
 */
export function findRootIdentifier(node: ESTree.Node): ESTree.Identifier | null {
  let current: ESTree.Node = node;
  if (current.type === 'CallExpression' || current.type === 'NewExpression') {
    current = current.callee;
  }
  for (;;) {
    if (current.type === 'ChainExpression') {
      current = current.expression;
      continue;
    }
    if (current.type === 'MemberExpression') {
      current = current.object;
      continue;
    }
    break;
  }
  return current.type === 'Identifier' ? current : null;
}

// ---------- 平台解析（守卫 → 候选端集合） ----------

type GuardInference =
  | { kind: 'positive'; platforms: Platform[] } // 守卫为真 ⇔ 端 ∈ platforms
  | { kind: 'negative'; platforms: Platform[] } // 守卫为真 ⇔ 端 ∉ platforms（取反 / !==）
  | { kind: 'unrecognized' };

function union(a: Platform[], b: Platform[]): Platform[] {
  return [...new Set([...a, ...b])];
}

/** 全集（四端）减去给定集合，即「非此端」补集。 */
export function complement(platforms: Platform[]): Platform[] {
  const set = new Set(platforms);
  return PLATFORM_VALUES.filter((p) => !set.has(p));
}

/**
 * 判定单个布尔表达式（IfStatement.test）对应的平台语义。
 * 支持：布尔 flag `isIOS` / `!isIOS`、字符串 `environment === 'ios'` / `!==`、多值 `||` 并集。
 * `&&` 交集属后续增强，首版按 unrecognized 处理。
 */
export function inferGuardPlatforms(test: ESTree.Node, guards: GuardConfig): GuardInference {
  if (test.type === 'Identifier') {
    const platform = guards.booleanFlags[test.name];
    return platform ? { kind: 'positive', platforms: [platform] } : { kind: 'unrecognized' };
  }

  if (test.type === 'UnaryExpression' && test.operator === '!') {
    const inner = inferGuardPlatforms(test.argument, guards);
    if (inner.kind === 'positive') return { kind: 'negative', platforms: inner.platforms };
    if (inner.kind === 'negative') return { kind: 'positive', platforms: inner.platforms };
    return { kind: 'unrecognized' };
  }

  if (
    test.type === 'BinaryExpression' &&
    (test.operator === '===' ||
      test.operator === '==' ||
      test.operator === '!==' ||
      test.operator === '!=')
  ) {
    if (test.left.type === 'Identifier' && test.left.name === guards.envVar) {
      const value = (test.right as ESTree.Literal).value;
      if (test.right.type === 'Literal' && typeof value === 'string') {
        const platform = guards.envValues[value];
        if (platform) {
          const negative = test.operator === '!==' || test.operator === '!=';
          return negative
            ? { kind: 'negative', platforms: [platform] }
            : { kind: 'positive', platforms: [platform] };
        }
      }
    }
    if (test.right.type === 'Identifier' && test.right.name === guards.envVar) {
      const value = (test.left as ESTree.Literal).value;
      if (test.left.type === 'Literal' && typeof value === 'string') {
        const platform = guards.envValues[value];
        if (platform) {
          const negative = test.operator === '!==' || test.operator === '!=';
          return negative
            ? { kind: 'negative', platforms: [platform] }
            : { kind: 'positive', platforms: [platform] };
        }
      }
    }
    return { kind: 'unrecognized' };
  }

  if (test.type === 'LogicalExpression' && test.operator === '||') {
    const left = inferGuardPlatforms(test.left, guards);
    const right = inferGuardPlatforms(test.right, guards);
    if (left.kind === 'positive' && right.kind === 'positive') {
      return { kind: 'positive', platforms: union(left.platforms, right.platforms) };
    }
    if (left.kind === 'negative' && right.kind === 'negative') {
      return { kind: 'negative', platforms: union(left.platforms, right.platforms) };
    }
    return { kind: 'unrecognized' };
  }

  return { kind: 'unrecognized' };
}

/**
 * 沿 AST 祖先找「最近一层」平台守卫（IfStatement），推断候选运行端集合。
 * - 识别布尔 flag / environment 字符串 / 取反 / else 分支（补集）。
 * - 无守卫或守卫形态不识别 → fail（交由 severity 决策降级）。
 * 首版只取最近一层守卫，多层嵌套守卫组合（交集）属后续增强。
 *
 * `ancestors` 为 ESLint `getAncestors` 结果（自外向内，末位为直接父节点）。
 */
export function resolvePlatforms(
  node: ESTree.Node,
  ancestors: ESTree.Node[],
  guards: GuardConfig,
): PlatformResolution {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (ancestor.type !== 'IfStatement') continue;

    const inference = inferGuardPlatforms(ancestor.test, guards);
    if (inference.kind === 'unrecognized') {
      return { status: 'fail', reason: 'unrecognized' };
    }

    // 判断命中节点落在 consequent（守卫为真）还是 alternate（else / 守卫为假）分支。
    const child = i + 1 < ancestors.length ? ancestors[i + 1] : node;
    const inElse = ancestor.alternate != null && ancestor.alternate === child;

    // negated XOR inElse：true 表示最终取「非此端」补集。
    const shouldComplement = (inference.kind === 'negative') !== inElse;
    const platforms = shouldComplement ? complement(inference.platforms) : inference.platforms;
    return { status: 'ok', platforms };
  }
  return { status: 'fail', reason: 'no-guard' };
}

// ---------- 三级校验 severity 决策 ----------

/**
 * 根据约束级别与版本/平台解析结果，决定最终 report 的严重度（null = 不报）。
 * 见 docs/design.md §6：
 * - level='warn'（天生提醒类）→ 命中即 warn，不做版本/平台判定
 * - level='error' 且版本、平台均解析成功且违规 → error
 * - level='error' 但版本不可静态提取（dynamic）→ 静默跳过（无法判定）
 * - level='error' 其余解析失败 → onResolveFail：'warn' → warn，'skip' → 不报
 */
export function decideSeverity(
  constraint: Constraint,
  version: VersionResolution,
  platform: PlatformResolution,
  order: string[],
): 'error' | 'warn' | null {
  if (constraint.level === 'warn') return 'warn';

  // L1 无条件全禁：不需要版本/平台解析，直接 error。
  if (constraint.conditions.length === 0) return 'error';

  if (version.status === 'skip') return null;

  if (version.status === 'ok' && platform.status === 'ok') {
    const violation = isViolation(constraint.conditions, {
      actualVersion: version.version,
      platforms: platform.platforms,
      order,
    });
    return violation ? 'error' : null;
  }

  return constraint.onResolveFail === 'warn' ? 'warn' : null;
}
