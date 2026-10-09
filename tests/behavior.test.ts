import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import { synthesizeCases } from '../src/engine/behavior.js';
import { buildUnsupportedApiConfig } from '../src/engine/unsupported-api.js';
import { defaultEngineConfig } from '../src/engine/default-config.js';
import type { Constraint } from '../src/types/index.js';
import { jueGetSystemInfoConstraint } from './helpers.js';

const linter = new Linter({ configType: 'flat' });

function errorCount(code: string, c: Constraint): number {
  const msgs = linter.verify(code, buildUnsupportedApiConfig([c], defaultEngineConfig));
  return msgs.filter((m) => m.severity === 2).length;
}

describe('synthesizeCases（自动合成 fire / not-fire 代码）', () => {
  it('min_version：低于阈值 → fire，最新版本 → not-fire', () => {
    const { fire, notFire } = synthesizeCases(jueGetSystemInfoConstraint, defaultEngineConfig);
    expect(errorCount(fire, jueGetSystemInfoConstraint)).toBeGreaterThan(0);
    expect(notFire).not.toBeNull();
    expect(errorCount(notFire as string, jueGetSystemInfoConstraint)).toBe(0);
  });

  it('unsupported：该端 fire，其它端 not-fire', () => {
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
    const { fire, notFire } = synthesizeCases(c, defaultEngineConfig);
    expect(fire).toContain('isHarmony');
    expect(errorCount(fire, c)).toBeGreaterThan(0);
    // notFire 落在非 harmony 端（isH5 / isAndroid / isIOS），应 0 报
    expect(notFire).not.toBeNull();
    expect(errorCount(notFire as string, c)).toBe(0);
  });

  it('L1 空 conditions → 只有 fire，无 not-fire', () => {
    const c: Constraint = { ...jueGetSystemInfoConstraint, conditions: [] };
    const { fire, notFire } = synthesizeCases(c, defaultEngineConfig);
    expect(notFire).toBeNull();
    expect(errorCount(fire, c)).toBeGreaterThan(0);
  });

  it('warn 级 → 只有 fire（命中即 warn），无 not-fire', () => {
    const c: Constraint = { ...jueGetSystemInfoConstraint, level: 'warn', conditions: [] };
    const { fire, notFire } = synthesizeCases(c, defaultEngineConfig);
    expect(notFire).toBeNull();
    // warn 级 fire 应产生至少一条消息（severity=1）
    const msgs = linter.verify(fire, buildUnsupportedApiConfig([c], defaultEngineConfig));
    expect(msgs.length).toBeGreaterThan(0);
  });
});
