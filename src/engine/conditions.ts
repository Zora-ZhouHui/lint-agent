// 条件判定引擎（纯函数，无 ESLint 依赖），跨端约束的「合不合法」判定在这里实现一次。
// 关键设计：违反 ⇔ 候选运行端集合内，存在某个端该约束未满足。
import type { Condition, Platform } from '../types/index.js';

/**
 * 版本比较（可插拔，与条件建模 / 引擎 / schema 解耦）。
 * jue SDK 是 clone 到项目目录的私有文件夹，「版本」即 SDK 目录名，无 npm semver，
 * 因此不做 semver 解析、不做字典序，而是查「SDK 目录名 → 序号」有序清单。
 * 返回值 < 0 表示 actual 早于 / 低于 minVersion（不可用）。
 *
 * 健壮性：`actual` 或 `minVersion` 不在清单里时（目录名写错 / 清单缺项），
 * 保守返回 -1（判违规）——绝不让 indexOf 返回 -1 被当成「最旧」而误判为可用，避免漏报。
 */
export function compare(actual: string, minVersion: string, order: string[]): number {
  const ai = order.indexOf(actual);
  const mi = order.indexOf(minVersion);
  if (ai < 0 || mi < 0) return -1;
  return ai - mi;
}

/** isViolation 的输入：调用点解析出的实际版本 + 候选运行端集合 + 版本序清单。 */
export interface ViolationInput {
  actualVersion: string;
  platforms: Platform[];
  order: string[];
}

/**
 * 判定一条约束在「调用点实际版本 + 候选运行端集合」下是否违反。
 * - conditions 空 → 无条件全禁（L1），一律报。
 * - 逐端检查候选端集合：该端存在约束条件且未满足（unsupported / 版本过低）即违反。
 * - 约束没提某个候选端 → 该端视为可用。
 * - min_version 下 `actualVersion` 或 `minVersion` 不在 `order` 清单 → 保守违规（compare < 0）。
 */
export function isViolation(conditions: Condition[], input: ViolationInput): boolean {
  if (conditions.length === 0) return true;

  return input.platforms.some((p) => {
    const c = conditions.find((x) => x.platform === p);
    if (!c) return false; // 约束没提这个端 → 视为可用
    if (c.kind === 'unsupported') return true;
    return compare(input.actualVersion, c.minVersion, input.order) < 0;
  });
}
