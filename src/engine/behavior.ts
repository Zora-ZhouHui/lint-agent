// 场景合成器：给每一条约束合成一组「版本 × 平台」边界场景代码。
//
// 重要定位：本模块是【引擎自检】（通电测试），不是正确性校验——
// 场景的期望（expect）由约束数据自身推导，题面与答案同源，因此它只能回答：
//   「引擎是否按这份数据在跑」（selector / scope / 守卫 / severity 接线断没断），
// 回答不了「这份数据与文档是否相符」（平台抄错、版本抄错时这里照样自洽通过）。
// 数据正确性由 agent/oracle.ts 的文档差分（独立第二意见）校验。
//
// 与旧 synthesizeCases 的区别：不再只测 conditions[0]——每个 condition 各生成
// 阈值下/阈值上（或 unsupported 端）场景，每个未被约束提及的端各生成放行场景，
// 多端约束的第二个端不再零覆盖。
import type { Constraint, EngineConfig, Platform } from '../types/index.js';
import { PLATFORM_VALUES } from '../types/index.js';

/** 场景期望的引擎输出：error / warn / 不报。 */
export type ScenarioExpect = 'error' | 'warn' | 'ok';

export interface EngineScenario {
  /** 场景标识（约束内唯一），如 min-ios-below / unsupported-harmony / pass-h5 */
  id: string;
  /** 可直接喂给 Linter 的代码 */
  code: string;
  /** 期望引擎输出（自检断言用；禁止喂给 oracle LLM） */
  expect: ScenarioExpect;
  /**
   * determinate：版本与平台都静态确定（有 import 版本 + 有具体端守卫），
   *   走完整 isViolation 判定，可与文档 oracle 的独立判定差分。
   * resolution：无守卫降级 / 动态 import 跳过等解析分支，期望依赖引擎自身策略，
   *   只用于引擎自检，不参与文档差分（oracle 不知道引擎的降级策略，不可比）。
   */
  kind: 'determinate' | 'resolution';
  /** 人读说明（如「iOS 2.22.0 < 2.25.0 应拦截」） */
  why: string;
  /** determinate 场景的版本与端（供 oracle 视图渲染，resolution 场景为 null） */
  context: { version: string; platform: Platform } | null;
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
 * 天然构成违规场景，且不会与真实版本目录名冲突（取代裸魔法值 '1.9.9'）。
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
 * 为一条约束合成全部引擎自检场景：
 *
 * - level='warn'：命中即 warn，不做版本/平台判定 → 单个 warn 场景。
 * - conditions 空（L1 全禁）：无条件 error → 单个 error 场景。
 * - 其余（L2）：
 *   - 每个 min_version(p, V)：(p, 低于 V) → error；(p, V) → ok。
 *   - 每个 unsupported(p)：(p, 最新版) → error。
 *   - 每个未被约束提及的端：(该端, 最新版) → ok（全量非条件端，平台张冠李戴时
 *     oracle 差分正是靠这些场景抓误报）。
 *   - resolution 场景：无守卫（按 onResolveFail 降级）。
 *
 * 配置中缺少某端布尔守卫时，该端 determinate 场景无法合成，直接跳过（不硬造）。
 */
export function synthesizeScenarios(
  constraint: Constraint,
  config: EngineConfig,
): EngineScenario[] {
  const call = `${constraint.target}();`;
  const newest = latest(config);

  if (constraint.level === 'warn') {
    return [
      {
        id: 'warn-any',
        code: render(call, newest, null),
        expect: 'warn',
        kind: 'resolution',
        why: 'warn 级约束命中即提醒，不做版本/平台判定',
        context: null,
      },
    ];
  }

  if (constraint.conditions.length === 0) {
    return [
      {
        id: 'forbid-all',
        code: render(call, newest, null),
        expect: 'error',
        kind: 'resolution',
        why: '空 conditions = 全端无条件禁用，任何版本/端都应拦截',
        context: null,
      },
    ];
  }

  const scenarios: EngineScenario[] = [];
  const mentioned = new Set<Platform>();

  for (const c of constraint.conditions) {
    mentioned.add(c.platform);
    const flag = flagFor(config, c.platform);
    if (!flag) continue; // 配置缺该端守卫 → determinate 场景无法构造，交给非条件端/降级侧覆盖

    if (c.kind === 'min_version') {
      const below = versionBelow(c.minVersion, config.order);
      scenarios.push({
        id: `min-${c.platform}-below`,
        code: render(call, below, flag),
        expect: 'error',
        kind: 'determinate',
        why: `${c.platform} 端 ${below} < 最低版本 ${c.minVersion}，应拦截`,
        context: { version: below, platform: c.platform },
      });
      scenarios.push({
        id: `min-${c.platform}-at`,
        code: render(call, c.minVersion, flag),
        expect: 'ok',
        kind: 'determinate',
        why: `${c.platform} 端 ${c.minVersion} 恰好满足最低版本，应放行`,
        context: { version: c.minVersion, platform: c.platform },
      });
    } else {
      scenarios.push({
        id: `unsupported-${c.platform}`,
        code: render(call, newest, flag),
        expect: 'error',
        kind: 'determinate',
        why: `${c.platform} 端完全不支持，最新版 ${newest} 也应拦截`,
        context: { version: newest, platform: c.platform },
      });
    }
  }

  // 非条件端：约束没提的端一律视为可用（最新版应放行）——每个都测，不漏端。
  for (const p of PLATFORM_VALUES) {
    if (mentioned.has(p)) continue;
    const flag = flagFor(config, p);
    if (!flag) continue;
    scenarios.push({
      id: `pass-${p}`,
      code: render(call, newest, flag),
      expect: 'ok',
      kind: 'determinate',
      why: `约束未限制 ${p} 端，最新版 ${newest} 应放行`,
      context: { version: newest, platform: p },
    });
  }

  // resolution 场景（只用于引擎自检，不进文档差分）：
  // 无守卫 → 平台不可解析 → 按 onResolveFail 显式降级（warn / skip）。
  // 注：动态路径（await import() / 模板字符串 import 源）无法用合法静态代码构造
  // （模板字符串作 import 源本身即语法错误），其 skip 分支由 resolve.test.ts 在
  // AST 层直接覆盖，不在行为场景中构造。
  scenarios.push({
    id: 'noguard-resolve-fail',
    code: render(call, newest, null),
    expect: constraint.onResolveFail === 'warn' ? 'warn' : 'ok',
    kind: 'resolution',
    why: `无平台守卫时平台解析失败，应按 onResolveFail=${constraint.onResolveFail} 降级`,
    context: null,
  });

  return scenarios;
}
