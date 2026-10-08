// 单引擎：只写一个 ESLint 规则（pg/unsupported-api），运行时读一份约束数据 + 引擎配置。
// selector 匹配 → 调用点级解析（版本 = import 路径、平台 = 运行时守卫）→ 三级校验（error/warn/skip）。
// ESLint 9 的 `context.report` 不再支持按条指定 severity，故拆成两条同名规则（error / warn）
// 分别报告对应严重度的判定结果，二者共享同一套约束与解析逻辑。
import type * as ESTree from 'estree';
import type { Linter, Scope } from 'eslint';
import type { Constraint, EngineConfig } from '../types/index.js';
import { decideSeverity, findRootIdentifier, resolvePlatforms, resolveVersion } from './resolve.js';

export const RULE_NAME = 'unsupported-api';
export const WARN_RULE_NAME = 'unsupported-api-warn';

// eslint 各版本 RuleModule 类型导出路径不一致，用本地结构类型（只声明引擎实际用到的字段）。
export interface UnsupportedApiRuleModule {
  meta: { type: 'problem'; docs: { description: string }; schema: [] };
  create: (context: UnsupportedApiContext) => Record<string, (node: ESTree.Node) => void>;
}

export interface UnsupportedApiContext {
  sourceCode: {
    getScope(node: ESTree.Node): Scope.Scope;
    getAncestors(node: ESTree.Node): ESTree.Node[];
  };
  report: (descriptor: { node: ESTree.Node; message: string }) => void;
}

export interface UnsupportedApiOptions {
  constraints: Constraint[];
  engineConfig?: EngineConfig | null;
}

/** 单条约束在命中节点上的最终判定：report error / report warn / 不报。 */
function evaluateConstraint(
  constraint: Constraint,
  node: ESTree.Node,
  context: UnsupportedApiContext,
  config: EngineConfig | null,
  order: string[],
): 'error' | 'warn' | null {
  // 无引擎配置 → 版本/平台均视为解析失败（L1 空 conditions 仍无条件报 error）
  if (!config) {
    return decideSeverity(
      constraint,
      { status: 'fail', reason: 'no-import' },
      { status: 'fail', reason: 'no-guard' },
      order,
    );
  }

  const root = findRootIdentifier(node);
  // selector 未命中 jue 根标识（防御：跳过，避免误报）
  if (!root || root.name !== config.sdkName) {
    return null;
  }

  const version = resolveVersion(root, context.sourceCode.getScope(root));
  const platforms = resolvePlatforms(node, context.sourceCode.getAncestors(node), config.guards);
  return decideSeverity(constraint, version, platforms, order);
}

/**
 * 由约束数据行构造规则：按 selector 分组（同一 selector 的多条约束合并进一个 visitor），
 * `reportSeverity` 决定这条规则只报告 error 还是 warn 判定结果（配合配置里的规则 severity）。
 */
export function createUnsupportedApiRule(
  options: UnsupportedApiOptions,
  reportSeverity: 'error' | 'warn',
): UnsupportedApiRuleModule {
  const bySelector = new Map<string, Constraint[]>();
  for (const c of options.constraints) {
    const list = bySelector.get(c.selector) ?? [];
    list.push(c);
    bySelector.set(c.selector, list);
  }
  const config = options.engineConfig ?? null;
  const order = config?.order ?? [];

  return {
    meta: {
      type: 'problem',
      docs: { description: '跨端 jue SDK 挂载 API 校验（单引擎 + 数据文件 + 调用点解析）' },
      schema: [],
    },
    create(context) {
      const visitors: Record<string, (node: ESTree.Node) => void> = {};
      for (const [selector, list] of bySelector) {
        visitors[selector] = (node) => {
          for (const c of list) {
            if (evaluateConstraint(c, node, context, config, order) === reportSeverity) {
              context.report({ node, message: c.message });
            }
          }
        };
      }
      return visitors;
    },
  };
}

/**
 * 组装一个可直接交给 Linter / flat config 的配置：
 * - `pg/unsupported-api`：报告 error 判定（硬校验违规）
 * - `pg/unsupported-api-warn`：报告 warn 判定（降级提示 / 天生提醒类）
 */
export function buildUnsupportedApiConfig(
  constraints: Constraint[],
  engineConfig?: EngineConfig | null,
): Linter.Config {
  return {
    plugins: {
      pg: {
        rules: {
          [RULE_NAME]: createUnsupportedApiRule({ constraints, engineConfig }, 'error'),
          [WARN_RULE_NAME]: createUnsupportedApiRule({ constraints, engineConfig }, 'warn'),
        },
      },
    },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      [`pg/${RULE_NAME}`]: 'error',
      [`pg/${WARN_RULE_NAME}`]: 'warn',
    },
  } as unknown as Linter.Config;
}
