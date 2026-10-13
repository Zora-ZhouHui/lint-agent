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
import type { Linter } from 'eslint';
import type { Constraint, EngineConfig, Platform, UnverifiedMinVersion } from '../types/index.js';
import { PLATFORM_VALUES } from '../types/index.js';
import { CANONICAL_FORM, type CallForm } from './forms.js';

/** 场景期望的引擎输出：error / warn / 不报。 */
export type ScenarioExpect = 'error' | 'warn' | 'ok';

/**
 * 把真实 Linter 的消息归约为 error / warn / ok 三态。
 *
 * 这是**场景期望与实际输出的唯一比较口径**，此前在 agent/oracle.ts、
 * agent/self-heal.ts、cli/commands/eval.ts 各有一份逐字相同的实现——
 * 三处任一处改了 severity 归约规则（例如未来把 fixable 或 suggestion 也算进来），
 * 就会让「自检通过」与「差分一致」的判定悄悄分叉。统一到这里。
 */
export function severityOf(msgs: Linter.LintMessage[]): ScenarioExpect {
  if (msgs.some((m) => m.severity === 2)) return 'error';
  if (msgs.some((m) => m.severity === 1)) return 'warn';
  return 'ok';
}

export interface EngineScenario {
  /** 场景标识（约束内唯一），如 min-ios-below / unsupported-harmony / pass-h5 */
  id: string;
  /**
   * 渲染该场景所用的调用形式 id（见 engine/forms.ts）。
   * 规范形式为 'canonical'；其它形式后缀在 id 上（如 min-ios-below@alias-import）。
   * 决策轴算出的 expect 对同一决策下的所有形式都相同——形式不参与期望计算。
   */
  formId: string;
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
 * 取严格低于 minVersion 的版本；若该阈值已是清单最低项，则**不存在**更低的合法版本，返回 null。
 *
 * 为什么不再退回清单外的假版本 `<minVersion>.pre`：假版本不在 order 清单里，引擎的
 * compare 对清单外目录名保守判违规（error），而 oracle 按文档读「2.0.0.pre ≥ 2.0.0」
 * 判放行（ok）——两条链路必然分歧，每次 eval 都稳定产出一批假阳性。
 * 阈值等于最低版本意味着该约束在已知版本空间内不可违反，这一点应当被显式呈现，
 * 而不是靠伪造一个版本把它「测出来」。
 */
function versionBelow(minVersion: string, order: string[]): string | null {
  const idx = order.indexOf(minVersion);
  return idx > 0 ? order[idx - 1] : null;
}

/**
 * 本约束在哪些端上「零覆盖」——即引擎配置里缺该端布尔守卫，导致这一端一个 determinate
 * 场景都构造不出来。
 *
 * 为什么要单独暴露：缺守卫时场景会被静默跳过，分母跟着缩小，报告照样显示
 * 「85/85 通过（共 N 个场景）」。这是「某端其实一个场景都没跑」被掩盖的路径。
 */
export function uncoveredPlatforms(constraint: Constraint, config: EngineConfig): Platform[] {
  // warn 级与 L1 全禁不按端展开，不存在端维度覆盖问题
  if (constraint.level === 'warn' || constraint.conditions.length === 0) return [];
  return PLATFORM_VALUES.filter((p) => flagFor(config, p) === null);
}

/**
 * 找出所有 `minVersion` 不在版本清单 `config.order` 里的约束。
 *
 * 为什么必须单独、显式地上报，而不是等引擎自检去失败：
 *
 * `compare()` 对清单外版本**保守返回 -1（判违规）**，所以 `min-<端>-at` 场景
 * （actual 恰等于 minVersion）会「期望放行、实际拦截」而自检失败——也就是说这个
 * 缺陷**不会静默漏过**。但失败信息的归因是错的：报告会显示「场景 min-ios-at
 * 期望 ok 实际 error」，把排查方向引向 selector / 接线 / 解析，而真正的原因只有两个：
 *   (a) 文档引入了版本清单里没有的新版本（要改 engine-config.json 的 order 清单）；
 *   (b) LLM 把版本号抄错了（要改约束数据）。
 *
 * 另外 `min-<端>-below`（该拦的场景）在清单外版本下**根本生成不出来**
 * （`versionBelow` 返回 null），该约束在已知版本空间里等于一条都没有被正向验证过。
 *
 * 因此这里做一次零 LLM 的确定性归因，把「哪条约束、哪一端、哪个版本」直接摆出来，
 * 并让人一眼知道该改数据还是该改配置。
 */
export function unverifiedMinVersions(
  constraints: Constraint[],
  config: EngineConfig,
): UnverifiedMinVersion[] {
  const out: UnverifiedMinVersion[] = [];
  for (const c of constraints) {
    for (const cond of c.conditions) {
      if (cond.kind !== 'min_version') continue;
      if (config.order.includes(cond.minVersion)) continue;
      out.push({
        name: c.name,
        target: c.target,
        platform: cond.platform,
        minVersion: cond.minVersion,
      });
    }
  }
  return out;
}

/** 场景展开选项。 */
export interface ScenarioOptions {
  /**
   * 参与展开的调用形式（见 engine/forms.ts）。
   * 默认只含规范形式——保持历史行为与产物稳定；传入 BUILTIN_FORMS
   * 即按「决策轴 × 形式轴」确定性展开，用于观测引擎在非规范写法上的真实行为。
   */
  forms?: readonly CallForm[];
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
  options: ScenarioOptions = {},
): EngineScenario[] {
  const forms = options.forms ?? [CANONICAL_FORM];
  const newest = latest(config);

  /**
   * 把一条「决策」（哪个版本 / 哪个端 / 期望什么）展开成每个适用形式各一个场景。
   * 期望由这里给出、形式只负责渲染代码——这是「覆盖率可枚举」的前提：
   * 同一决策下的所有形式共享同一个 expect，因此场景数 = 决策数 × 适用形式数。
   */
  const emit = (
    baseId: string,
    decision: {
      expect: ScenarioExpect;
      kind: EngineScenario['kind'];
      why: string;
      context: EngineScenario['context'];
      version: string;
      flag: string | null;
    },
  ): EngineScenario[] => {
    const out: EngineScenario[] = [];
    for (const form of forms) {
      const code = form.render({
        target: constraint.target,
        version: decision.version,
        flag: decision.flag,
      });
      if (code === null) continue; // 该形式不适用于本上下文（如无守卫时的早返回）
      out.push({
        id: form.id === CANONICAL_FORM.id ? baseId : `${baseId}@${form.id}`,
        formId: form.id,
        code,
        expect: decision.expect,
        kind: decision.kind,
        why: decision.why,
        context: decision.context,
      });
    }
    return out;
  };

  if (constraint.level === 'warn') {
    return emit('warn-any', {
      expect: 'warn',
      kind: 'resolution',
      why: 'warn 级约束命中即提醒，不做版本/平台判定',
      context: null,
      version: newest,
      flag: null,
    });
  }

  if (constraint.conditions.length === 0) {
    return emit('forbid-all', {
      expect: 'error',
      kind: 'resolution',
      why: '空 conditions = 全端无条件禁用，任何版本/端都应拦截',
      context: null,
      version: newest,
      flag: null,
    });
  }

  const scenarios: EngineScenario[] = [];
  const mentioned = new Set<Platform>();

  for (const c of constraint.conditions) {
    mentioned.add(c.platform);
    const flag = flagFor(config, c.platform);
    if (!flag) continue; // 配置缺该端守卫 → determinate 场景无法构造，交给非条件端/降级侧覆盖

    if (c.kind === 'min_version') {
      const below = versionBelow(c.minVersion, config.order);
      // below 为 null：该阈值已是版本清单最低项，没有更低的合法版本可构造违规场景。
      // 不伪造清单外版本（见 versionBelow 注释），该约束在已知版本空间内不可违反。
      if (below !== null) {
        scenarios.push(
          ...emit(`min-${c.platform}-below`, {
            expect: 'error',
            kind: 'determinate',
            why: `${c.platform} 端 ${below} < 最低版本 ${c.minVersion}，应拦截`,
            context: { version: below, platform: c.platform },
            version: below,
            flag,
          }),
        );
      }
      scenarios.push(
        ...emit(`min-${c.platform}-at`, {
          expect: 'ok',
          kind: 'determinate',
          why: `${c.platform} 端 ${c.minVersion} 恰好满足最低版本，应放行`,
          context: { version: c.minVersion, platform: c.platform },
          version: c.minVersion,
          flag,
        }),
      );
    } else {
      scenarios.push(
        ...emit(`unsupported-${c.platform}`, {
          expect: 'error',
          kind: 'determinate',
          why: `${c.platform} 端完全不支持，最新版 ${newest} 也应拦截`,
          context: { version: newest, platform: c.platform },
          version: newest,
          flag,
        }),
      );
    }
  }

  // 非条件端：约束没提的端一律视为可用（最新版应放行）——每个都测，不漏端。
  for (const p of PLATFORM_VALUES) {
    if (mentioned.has(p)) continue;
    const flag = flagFor(config, p);
    if (!flag) continue;
    scenarios.push(
      ...emit(`pass-${p}`, {
        expect: 'ok',
        kind: 'determinate',
        why: `约束未限制 ${p} 端，最新版 ${newest} 应放行`,
        context: { version: newest, platform: p },
        version: newest,
        flag,
      }),
    );
  }

  // resolution 场景（只用于引擎自检，不进文档差分）：
  // 无守卫 → 平台不可解析 → 按 onResolveFail 显式降级（warn / skip）。
  // 注：动态路径（await import() / 模板字符串 import 源）无法用合法静态代码构造
  // （模板字符串作 import 源本身即语法错误），其 skip 分支由 resolve.test.ts 在
  // AST 层直接覆盖，不在行为场景中构造。
  scenarios.push(
    ...emit('noguard-resolve-fail', {
      expect: constraint.onResolveFail === 'warn' ? 'warn' : 'ok',
      kind: 'resolution',
      why: `无平台守卫时平台解析失败，应按 onResolveFail=${constraint.onResolveFail} 降级`,
      context: null,
      version: newest,
      flag: null,
    }),
  );

  return scenarios;
}
