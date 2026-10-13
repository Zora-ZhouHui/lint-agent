// 单引擎：只写一个 ESLint 规则（pg/unsupported-api），运行时读一份约束数据 + 引擎配置。
// 形状 selector 预筛 → 调用点级解析（SDK 归属 = 作用域绑定、版本 = import 路径、平台 = 运行时守卫）
// → 三级校验（error/warn/skip）。
// ESLint 9 的 `context.report` 不再支持按条指定 severity，故拆成两条同名规则（error / warn）
// 分别报告对应严重度的判定结果，二者共享同一套约束与解析逻辑。
import type * as ESTree from 'estree';
import type { Linter, Scope } from 'eslint';
import type { Constraint, EngineConfig } from '../types/index.js';
import {
  decideSeverity,
  resolvePlatforms,
  resolveSdkCall,
  type PlatformResolution,
} from './resolve.js';
import { targetToShapeSelectors } from './selector.js';

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

/**
 * 由约束数据行构造规则。
 *
 * 匹配分两步（见 selector.ts targetToShapeSelectors 的说明）：
 *   1. **形状 selector 预筛**：只按调用链层级 + 模块名 / 方法名注册 visitor，不限定根标识名，
 *      因此别名导入、解构导入也能进入判定；形状 selector 由 target 机械推导，去重后共享。
 *   2. **绑定判定 + 按 SDK 相对路径分派**：resolveSdkCall 沿作用域链确认「这是不是 SDK 调用」
 *      并算出相对路径，再按路径 O(1) 取约束——因此一条 shape selector 被多条约束复用时不会误报。
 *
 * `reportSeverity` 决定这条规则只报告 error 还是 warn 判定结果（配合配置里的规则 severity）。
 */
export function createUnsupportedApiRule(
  options: UnsupportedApiOptions,
  reportSeverity: 'error' | 'warn',
): UnsupportedApiRuleModule {
  const config = options.engineConfig ?? null;
  const order = config?.order ?? [];
  // 无引擎配置时退回约定的 SDK 名（与 loadConstraints / defaultEngineConfig 一致）：
  // 绑定判定必须知道根标识叫什么，缺它规则就只能整体停摆。
  const sdkName = config?.sdkName ?? 'jue';

  const byPath = new Map<string, Constraint[]>();
  const shapeSelectors = new Set<string>();
  for (const c of options.constraints) {
    // SDK 相对路径 = target 去掉根标识（targetToSelector 保证了首段就是 sdkName）
    const relativePath = c.target.split('.').slice(1).join('.');
    const list = byPath.get(relativePath) ?? [];
    list.push(c);
    byPath.set(relativePath, list);
    for (const selector of targetToShapeSelectors(c.target)) shapeSelectors.add(selector);
  }

  return {
    meta: {
      type: 'problem',
      docs: { description: '跨端 jue SDK 挂载 API 校验（单引擎 + 数据文件 + 调用点解析）' },
      schema: [],
    },
    create(context) {
      const visitors: Record<string, (node: ESTree.Node) => void> = {};

      const visit = (node: ESTree.Node) => {
        const resolution = resolveSdkCall(node, context.sourceCode.getScope(node), sdkName);
        if (!resolution) return; // 非 SDK 调用（或形态不支持）→ 不报，防误报
        const matched = byPath.get(resolution.path);
        if (!matched) return;

        // 无引擎配置 → 平台视为解析失败（L1 空 conditions 仍无条件报 error）
        const platforms: PlatformResolution = config
          ? resolvePlatforms(node, context.sourceCode.getAncestors(node), config.guards)
          : { status: 'fail', reason: 'no-guard' };

        for (const c of matched) {
          if (decideSeverity(c, resolution.version, platforms, order) === reportSeverity) {
            context.report({ node, message: c.message });
          }
        }
      };

      for (const selector of shapeSelectors) visitors[selector] = visit;
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
