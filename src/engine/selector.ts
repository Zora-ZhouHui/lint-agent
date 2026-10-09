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
