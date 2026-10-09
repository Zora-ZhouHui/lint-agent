// 行为用例合成器：给每一条约束自动生成「触发 / 不触发」两段可 lint 代码。
// 不依赖手写 JSON，也不依赖 LLM——只读约束数据行 + 引擎配置，按条件原语拼出必命中/必放行的代码，
// 用于端到端验证「生成的规则真的会 fire（且不会误报）」。这是 eval 的 baseline-diff 测不到的那一半。
import type { Constraint, EngineConfig, Platform } from '../types/index.js';
import { PLATFORM_VALUES } from '../types/index.js';

export interface BehaviorCase {
  /** 必命中：该代码被该约束的 error 规则报出（severity=2，warn 级除外）。 */
  fire: string;
  /** 必放行：该代码不被 error 规则报出；null 表示该约束无 not-fire 用例（全禁 / 天生 warn）。 */
  notFire: string | null;
}

/** 端 → 布尔守卫变量名（如 ios → isIOS），依据 engineConfig.guards.booleanFlags 反查。 */
function flagFor(config: EngineConfig, platform: Platform): string | null {
  const entry = Object.entries(config.guards.booleanFlags).find(([, p]) => p === platform);
  return entry ? entry[0] : null;
}

/** 清单里最「新」的版本（≥ 所有阈值，用于让 min_version 分支放行、unsupported 分支命中）。 */
function latest(config: EngineConfig): string {
  return config.order[config.order.length - 1] ?? '9.9.9';
}

/**
 * 取严格低于 minVersion 的版本；若 minVersion 不在清单或已是最低（该阈值在已知版本空间内
 * 不存在违规点），退回清单外目录名 `<minVersion>.pre`——compare 对清单外目录名保守判违规，
 * 天然构成 fire 用例，且不会与真实版本目录名冲突（取代裸魔法值 '1.9.9'）。
 */
function versionBelow(minVersion: string, order: string[]): string {
  const idx = order.indexOf(minVersion);
  return idx > 0 ? order[idx - 1] : `${minVersion}.pre`;
}

/** 生成一段可 lint 代码：import 带版本 → （可选）平台守卫 → 调用目标 API。 */
function render(call: string, version: string, flag: string | null): string {
  const importLine = `import jue from './jue/${version}';`;
  if (!flag) return `${importLine}\n${call}\n`;
  return `${importLine}\nif (${flag}) {\n  ${call}\n}\n`;
}

/**
 * 合成一条约束的 fire / not-fire 用例：
 * - level='warn'：命中即 warn，不做版本/平台判定 → 只有 fire，无 not-fire。
 * - conditions 空（L1 全禁）：无条件 error → 只有 fire，无 not-fire。
 * - 其余：fire 取第一条条件对应的端 + 必违规版本；not-fire 找一个「最新版本下可用」的端。
 */
export function synthesizeCases(constraint: Constraint, config: EngineConfig): BehaviorCase {
  const call = `${constraint.target}();`;

  if (constraint.level === 'warn') {
    return { fire: render(call, latest(config), null), notFire: null };
  }
  if (constraint.conditions.length === 0) {
    return { fire: render(call, latest(config), null), notFire: null };
  }

  const first = constraint.conditions[0];
  const fireFlag = flagFor(config, first.platform);
  const fireVersion =
    first.kind === 'min_version' ? versionBelow(first.minVersion, config.order) : latest(config);
  const fire = render(call, fireVersion, fireFlag);

  let notFire: string | null = null;
  for (const p of PLATFORM_VALUES) {
    const unsupported = constraint.conditions.some(
      (c) => c.kind === 'unsupported' && c.platform === p,
    );
    if (unsupported) continue;
    const flag = flagFor(config, p);
    if (!flag) continue;
    notFire = render(call, latest(config), flag);
    break;
  }

  return { fire, notFire };
}
