// selector 生成器：从 target（SDK 挂载 API 路径）机械推导 esquery selector。
// 纯字符串变换，无 ESLint / LLM 依赖——selector 不再由 LLM 产出，杜绝层级写错。
import type { Constraint } from '../types/index.js';

/**
 * 从 target（SDK 挂载 API 路径）机械推导 esquery selector。
 * target 段数决定 AST 层级，一层不多一层不少：
 * - 2 段（jue.method）→ CallExpression[callee.object.name="jue"][callee.property.name="method"]
 * - 3 段（jue.module.method）→ CallExpression[callee.object.object.name="jue"][callee.object.property.name="module"][callee.property.name="method"]
 * - 其他段数 → 抛错（jue 挂载 API 最多 3 段）
 */
export function targetToSelector(target: string, sdkName: string): string {
  const segments = target.split('.');
  if (segments.length < 2) {
    throw new Error(`target 段数不足（至少 2 段 ${sdkName}.method）：${target}`);
  }
  if (segments[0] !== sdkName) {
    throw new Error(`target 必须以 ${sdkName} 开头：${target}`);
  }

  const method = segments[segments.length - 1];

  if (segments.length === 2) {
    return `CallExpression[callee.object.name="${sdkName}"][callee.property.name="${method}"]`;
  }

  if (segments.length === 3) {
    const mod = segments[1];
    return `CallExpression[callee.object.object.name="${sdkName}"][callee.object.property.name="${mod}"][callee.property.name="${method}"]`;
  }

  throw new Error(`target 段数非法（仅支持 2 或 3 段，jue 挂载 API 最多 3 段）：${target}`);
}

/** 批量填充 selector（对缺少 selector 的约束做机械推导）。 */
export function fillSelectors(constraints: Constraint[], sdkName: string): Constraint[] {
  return constraints.map((c) => ({
    ...c,
    selector: c.selector ?? targetToSelector(c.target, sdkName),
  }));
}

/**
 * 从 target（SDK 挂载 API 路径）机械推导人读标识 name。
 *
 * 为什么必须推导而不是让 LLM 产出：`name` 只是 `target` 的人读投影，没有独立信息量，
 * 却同时充当 **judge verdict 的对齐键**。实测到的真实失效是：LLM 在 `heal_missed` 里
 * 稳定地把 `name` 填成 API 路径（`"name":"jue.router.navigateTo"`），违反 kebab-case
 * 的 Zod 校验，导致**整批补提取作废**——一次运行 9 条漏提三轮全部修不回来。
 *
 * 这与 selector 曾经的问题是同一类（LLM 做一件本可机械推导的事却做错），因此用同一
 * 种解法：由 target 推导，杜绝该类错误。推导规则 `no-<module>-<method>`（如
 * `jue.system.getSystemInfo` → `no-system-getsysteminfo`）与历史产物 100% 一致。
 *
 * 唯一性由构造保证：`target` 已由提取层的去重 + 冲突检测保证唯一，而本函数是纯函数，
 * 故不同 target 必得不同 name（其中也依赖「target 三段路径的尾段即方法名」这一约定，
 * 与 targetToSelector 一致）。
 */
export function nameFromTarget(target: string, sdkName: string): string {
  const segments = target.split('.');
  if (segments.length < 2) {
    throw new Error(`target 段数不足（至少 2 段 ${sdkName}.method）：${target}`);
  }
  if (segments[0] !== sdkName) {
    throw new Error(`target 必须以 ${sdkName} 开头：${target}`);
  }
  return `no-${segments.slice(1).join('-').toLowerCase()}`;
}

/**
 * 生成「形状 selector」：与 targetToSelector 的区别是**不限定根标识名**。
 *
 * 为什么需要：`import J from '.../jue/V'; J.mod.method()`（别名导入）与
 * `const { mod } = jue; mod.method()`（解构导入）在 AST 上的根标识都不是 sdkName，
 * 写死 `name="sdkName"` 的 selector 会让规则**连匹配都进不去**——静默漏报，
 * 比降级 warn 更危险。
 *
 * 因此匹配拆成两步：
 *   1. selector 只做「形状」预筛（调用链层级 + 模块名 / 方法名）；
 *   2. SDK 归属由 resolveSdkCall 沿作用域链判定（import 绑定 / 解构来源）。
 * 两步都是确定性代码，LLM 写错 AST 层级那一类问题依然不可能发生。
 *
 * 段数非法的 target 返回空数组（由 targetToSelector 负责报错）。
 */
export function targetToShapeSelectors(target: string): string[] {
  const segments = target.split('.');
  if (segments.length < 2 || segments.length > 3) return [];

  const method = segments[segments.length - 1];
  if (segments.length === 2) {
    return [
      // 规范 / 别名：X.method()
      `CallExpression[callee.object.type="Identifier"][callee.property.name="${method}"]`,
      // 解构：method()
      `CallExpression[callee.name="${method}"]`,
    ];
  }

  const mod = segments[1];
  return [
    // 规范 / 别名：X.mod.method()
    `CallExpression[callee.object.object.type="Identifier"][callee.object.property.name="${mod}"][callee.property.name="${method}"]`,
    // 解构：mod.method()（本地名可能被重命名，交给绑定判定，故 selector 不限定名）
    `CallExpression[callee.object.type="Identifier"][callee.property.name="${method}"]`,
  ];
}
