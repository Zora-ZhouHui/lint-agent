import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import {
  severityOf,
  synthesizeScenarios,
  uncoveredPlatforms,
  unverifiedMinVersions,
} from '../src/engine/behavior.js';
import { buildUnsupportedApiConfig } from '../src/engine/unsupported-api.js';
import { defaultEngineConfig } from '../src/engine/default-config.js';
import type { Constraint } from '../src/types/index.js';
import { jueGetSystemInfoConstraint } from './helpers.js';

const linter = new Linter({ configType: 'flat' });

type Tri = 'error' | 'warn' | 'ok';

function lintActual(code: string, c: Constraint): Tri {
  const msgs = linter.verify(code, buildUnsupportedApiConfig([c], defaultEngineConfig));
  if (msgs.some((m) => m.severity === 2)) return 'error';
  if (msgs.some((m) => m.severity === 1)) return 'warn';
  return 'ok';
}

describe('synthesizeScenarios（引擎自检场景合成）', () => {
  it('多端 min_version：每个 condition 都有阈值下/阈值上场景（旧实现只测 conditions[0] 的回归保护）', () => {
    const scenarios = synthesizeScenarios(jueGetSystemInfoConstraint, defaultEngineConfig);
    const ids = scenarios.map((s) => s.id);

    // fixture 含 ios 2.25.0 + android 2.10.0 两条条件，两个端都必须被覆盖
    expect(ids).toContain('min-ios-below');
    expect(ids).toContain('min-ios-at');
    expect(ids).toContain('min-android-below');
    expect(ids).toContain('min-android-at');
    // 未被约束提及的端各有放行场景
    expect(ids).toContain('pass-harmony');
    expect(ids).toContain('pass-h5');
    // resolution 分支（无守卫降级；动态 import skip 无法用合法代码构造，见 behavior.ts 注释）
    expect(ids).toContain('noguard-resolve-fail');
    expect(ids).not.toContain('dynamic-version-skip');

    // 每个场景的真实 lint 结果必须与期望一致（引擎按数据执行）
    for (const s of scenarios) {
      expect(lintActual(s.code, jueGetSystemInfoConstraint)).toBe(s.expect);
    }

    // 阈值下版本取清单前一项（2.25.0 → 2.22.0；2.10.0 → 2.8.0）
    const iosBelow = scenarios.find((s) => s.id === 'min-ios-below')!;
    expect(iosBelow.code).toContain('./jue/2.22.0');
    expect(iosBelow.code).toContain('isIOS');
    const androidAt = scenarios.find((s) => s.id === 'min-android-at')!;
    expect(androidAt.code).toContain('./jue/2.10.0');
    expect(androidAt.code).toContain('isAndroid');
  });

  it('unsupported：该端最新版也应拦截，其它端逐端放行', () => {
    const c: Constraint = {
      name: 'no-media-getcamera-harmony',
      target: 'jue.media.getCamera',
      selector: 'CallExpression[callee.object.object.name="jue"]',
      message: '鸿蒙不支持 getCamera',
      conditions: [{ kind: 'unsupported', platform: 'harmony' }],
      level: 'error',
      onResolveFail: 'warn',
      evidence: '鸿蒙 ArkTS 不支持',
    };
    const scenarios = synthesizeScenarios(c, defaultEngineConfig);
    const ids = scenarios.map((s) => s.id);

    expect(ids).toContain('unsupported-harmony');
    expect(ids).toContain('pass-ios');
    expect(ids).toContain('pass-android');
    expect(ids).toContain('pass-h5');

    for (const s of scenarios) {
      expect(lintActual(s.code, c)).toBe(s.expect);
    }
    const harmony = scenarios.find((s) => s.id === 'unsupported-harmony')!;
    expect(harmony.code).toContain('isHarmony');
    expect(harmony.expect).toBe('error');
  });

  it('L1 空 conditions → 单个全禁场景，任何版本/端都 error', () => {
    const c: Constraint = { ...jueGetSystemInfoConstraint, conditions: [] };
    const scenarios = synthesizeScenarios(c, defaultEngineConfig);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe('forbid-all');
    expect(lintActual(scenarios[0].code, c)).toBe('error');
  });

  it('warn 级 → 单个 warn 场景，不区分版本/平台', () => {
    const c: Constraint = { ...jueGetSystemInfoConstraint, level: 'warn', conditions: [] };
    const scenarios = synthesizeScenarios(c, defaultEngineConfig);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe('warn-any');
    expect(lintActual(scenarios[0].code, c)).toBe('warn');
  });

  it('onResolveFail=skip：无守卫场景期望 ok（跳过不报）', () => {
    const c: Constraint = { ...jueGetSystemInfoConstraint, onResolveFail: 'skip' };
    const scenarios = synthesizeScenarios(c, defaultEngineConfig);
    const noguard = scenarios.find((s) => s.id === 'noguard-resolve-fail')!;
    expect(noguard.expect).toBe('ok');
    expect(lintActual(noguard.code, c)).toBe('ok');
  });

  it('内层守卫形态不认识时继续向外找平台守卫（嵌套 if 不再整体降级）', () => {
    const c = jueGetSystemInfoConstraint;
    // if (isIOS) { if (ready) { ... } } —— 内层 ready 不认识，但运行端仍是 iOS
    const code = `import jue from './jue/2.22.0';\nif (isIOS) {\n  if (ready) {\n    jue.system.getSystemInfo();\n  }\n}\n`;
    expect(lintActual(code, c)).toBe('error');
  });

  it('阈值等于版本清单最低项 → 不构造清单外假版本（.pre）', () => {
    const lowest = defaultEngineConfig.order[0];
    const c: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'min_version', platform: 'ios', minVersion: lowest }],
    };
    const scenarios = synthesizeScenarios(c, defaultEngineConfig);
    const ids = scenarios.map((s) => s.id);

    // 不再伪造清单外的 `<minVersion>.pre`（它会与文档判定必然分歧，制造假阳性）
    expect(scenarios.some((s) => s.code.includes('.pre'))).toBe(false);
    // 阈值已是清单最低项 → 已知版本空间内不存在更低的合法版本，不硬造违规场景
    expect(ids).not.toContain('min-ios-below');
    // 阈值上场景仍保留，其余场景照常自洽
    expect(ids).toContain('min-ios-at');
    for (const s of scenarios) {
      expect(lintActual(s.code, c)).toBe(s.expect);
    }
  });

  it('配置缺某端布尔守卫 → 该端 determinate 场景不硬造，其余场景仍自洽', () => {
    const config = {
      ...defaultEngineConfig,
      guards: {
        booleanFlags: { isAndroid: 'android', isHarmony: 'harmony', isH5: 'h5' },
        envVar: 'environment',
        envValues: defaultEngineConfig.guards.envValues,
      },
    } as const;
    const scenarios = synthesizeScenarios(jueGetSystemInfoConstraint, { ...config });
    const ids = scenarios.map((s) => s.id);
    expect(ids).not.toContain('min-ios-below');
    expect(ids).toContain('min-android-below');
    // 无守卫降级场景仍在（warn 策略）
    const noguard = scenarios.find((s) => s.id === 'noguard-resolve-fail')!;
    expect(noguard.expect).toBe('warn');
  });
});

describe('uncoveredPlatforms（零覆盖端必须显式上报）', () => {
  it('配置缺某端守卫 → 该端被列为零覆盖', () => {
    const config = {
      ...defaultEngineConfig,
      guards: {
        ...defaultEngineConfig.guards,
        booleanFlags: { isIOS: 'ios', isAndroid: 'android', isH5: 'h5' },
      },
    } as typeof defaultEngineConfig;
    const missing = uncoveredPlatforms(jueGetSystemInfoConstraint, config);
    expect(missing).toEqual(['harmony']);
    // 守卫齐全时不报零覆盖
    expect(uncoveredPlatforms(jueGetSystemInfoConstraint, defaultEngineConfig)).toEqual([]);
  });

  it('minVersion 不在版本清单 → 显式上报（否则自检失败归因错误、且该约束未被正向验证）', () => {
    const bad: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'min_version', platform: 'ios', minVersion: '2.6.1' }],
    };
    const problems = unverifiedMinVersions([bad], defaultEngineConfig);
    expect(problems).toEqual([
      {
        name: jueGetSystemInfoConstraint.name,
        target: jueGetSystemInfoConstraint.target,
        platform: 'ios',
        minVersion: '2.6.1',
      },
    ]);

    // 关键：清单外版本下「阈值下」场景根本生成不出来——该约束在已知版本空间内
    // 一条「该拦」的场景都没有，因此必须靠这条归因检查补上，而不能只看自检通过率。
    const ids = synthesizeScenarios(bad, defaultEngineConfig).map((s) => s.id);
    expect(ids).not.toContain('min-ios-below');
    expect(ids).toContain('min-ios-at');
  });

  it('minVersion 在清单内 → 不上报；清单最低项也不上报（只是无更低版本可构造）', () => {
    expect(unverifiedMinVersions([jueGetSystemInfoConstraint], defaultEngineConfig)).toEqual([]);
    const atLowest: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'min_version', platform: 'ios', minVersion: '2.0.0' }],
    };
    expect(unverifiedMinVersions([atLowest], defaultEngineConfig)).toEqual([]);
  });

  it('unsupported 条件不参与版本清单检查', () => {
    const c: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'unsupported', platform: 'harmony' }],
    };
    expect(unverifiedMinVersions([c], defaultEngineConfig)).toEqual([]);
  });

  it('severityOf 是唯一的 error/warn/ok 归约口径（原先三处逐字重复）', () => {
    // 该函数同时决定「自检实际输出」与「差分实际输出」，两处必须永远一致
    expect(severityOf([])).toBe('ok');
    expect(severityOf([{ severity: 1, message: 'w' } as never])).toBe('warn');
    expect(severityOf([{ severity: 2, message: 'e' } as never])).toBe('error');
    // 同时出现时以 error 优先（更严重者胜出）
    expect(
      severityOf([{ severity: 1, message: 'w' } as never, { severity: 2, message: 'e' } as never]),
    ).toBe('error');
  });

  it('warn 级与 L1 全禁不按端展开 → 不存在端覆盖问题', () => {
    const warnLevel: Constraint = { ...jueGetSystemInfoConstraint, level: 'warn' };
    const l1: Constraint = { ...jueGetSystemInfoConstraint, conditions: [] };
    expect(uncoveredPlatforms(warnLevel, defaultEngineConfig)).toEqual([]);
    expect(uncoveredPlatforms(l1, defaultEngineConfig)).toEqual([]);
  });
});
