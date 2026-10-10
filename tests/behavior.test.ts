import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import { synthesizeScenarios } from '../src/engine/behavior.js';
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
