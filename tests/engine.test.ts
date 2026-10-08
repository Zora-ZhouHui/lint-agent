import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import { compare, isViolation, type ViolationInput } from '../src/engine/conditions.js';
import { buildUnsupportedApiConfig } from '../src/engine/unsupported-api.js';
import type { Condition } from '../src/types/index.js';
import { jueGetSystemInfoConstraint, makeEngineConfig } from './helpers.js';

const ORDER = ['2.0.0', '2.5.0', '2.10.0', '2.15.0', '2.20.0', '2.25.0', '2.30.0'];

function input(overrides: Partial<ViolationInput> = {}): ViolationInput {
  return { actualVersion: '2.10.0', platforms: ['ios', 'android'], order: ORDER, ...overrides };
}

describe('compare（SDK 目录名有序清单）', () => {
  it('相等 → 0（可用）', () => {
    expect(compare('2.6.0', '2.6.0', ['2.4.0', '2.5.0', '2.6.0'])).toBe(0);
  });

  it('更旧 → 负数（不可用）', () => {
    expect(compare('2.5.0', '2.6.0', ['2.4.0', '2.5.0', '2.6.0'])).toBeLessThan(0);
  });

  it('更新 → 正数（可用）', () => {
    expect(compare('2.7.0', '2.6.0', ['2.4.0', '2.5.0', '2.6.0', '2.7.0'])).toBeGreaterThan(0);
  });

  it('未知目录名 → 保守判违规（不把 indexOf -1 误判为最旧）', () => {
    expect(compare('not-a-dir', '2.6.0', ['2.4.0', '2.6.0'])).toBeLessThan(0);
    expect(compare('2.6.0', 'not-a-dir', ['2.4.0', '2.6.0'])).toBeLessThan(0);
  });
});

describe('isViolation（候选端集合逐端判定）', () => {
  it('空 conditions → 无条件全禁（L1）', () => {
    expect(isViolation([], input())).toBe(true);
  });

  it('unsupported 命中候选端 → 违规', () => {
    const cond: Condition[] = [{ kind: 'unsupported', platform: 'ios' }];
    expect(isViolation(cond, input())).toBe(true);
  });

  it('约束只提 harmony，候选端不含 harmony → 不违规', () => {
    const cond: Condition[] = [{ kind: 'unsupported', platform: 'harmony' }];
    expect(isViolation(cond, input())).toBe(false);
  });

  it('min_version 低于最小版本 → 违规', () => {
    const cond: Condition[] = [{ kind: 'min_version', platform: 'ios', minVersion: '2.25.0' }];
    expect(isViolation(cond, input({ actualVersion: '2.20.0' }))).toBe(true);
  });

  it('min_version 等于 / 高于实际版本 → 不违规', () => {
    const cond: Condition[] = [{ kind: 'min_version', platform: 'ios', minVersion: '2.10.0' }];
    expect(isViolation(cond, input({ actualVersion: '2.10.0' }))).toBe(false);
    expect(isViolation(cond, input({ actualVersion: '2.15.0' }))).toBe(false);
  });

  it('实际版本未知（不在清单）→ 保守违规', () => {
    const cond: Condition[] = [{ kind: 'min_version', platform: 'ios', minVersion: '2.10.0' }];
    expect(isViolation(cond, input({ actualVersion: '2.9.0' }))).toBe(true);
  });
});

describe('unsupported-api 引擎（Linter 集成，三级校验）', () => {
  const linter = new Linter({ configType: 'flat' });
  const engineConfig = makeEngineConfig();

  function verify(code: string) {
    return linter.verify(
      code,
      buildUnsupportedApiConfig([jueGetSystemInfoConstraint], engineConfig),
    );
  }

  it('版本/平台解析成功且违规 → error（severity 2）', () => {
    const msgs = verify(`
      import jue from 'src/jue/2.20.0';
      if (isIOS) {
        jue.system.getSystemInfo();
      }
    `);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(2);
    expect(msgs[0].ruleId).toBe('pg/unsupported-api');
  });

  it('版本满足阈值 → 不报', () => {
    const msgs = verify(`
      import jue from 'src/jue/2.25.0';
      if (isIOS) {
        jue.system.getSystemInfo();
      }
    `);
    expect(msgs).toHaveLength(0);
  });

  it('Android 分支低于阈值 → error', () => {
    const msgs = verify(`
      import jue from 'src/jue/2.5.0';
      if (isAndroid) {
        jue.system.getSystemInfo();
      }
    `);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(2);
  });

  it('无平台守卫 → 降级 warn（onResolveFail）', () => {
    const msgs = verify(`
      import jue from 'src/jue/2.20.0';
      jue.system.getSystemInfo();
    `);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(1);
    expect(msgs[0].ruleId).toBe('pg/unsupported-api-warn');
  });

  it('无 import（全局注入）→ 降级 warn', () => {
    const msgs = verify(`
      if (isIOS) {
        jue.system.getSystemInfo();
      }
    `);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(1);
  });

  it('else 分支补集：非 ios 端不违背 ios 阈值 → 不报', () => {
    const config = buildUnsupportedApiConfig([jueGetSystemInfoConstraint], engineConfig);
    const code = `
import jue from 'src/jue/2.25.0';
if (isIOS) {
  jue.system.getSystemInfo();
} else {
  jue.system.getSystemInfo();
}
`;
    // iOS 满足阈值（不报）；else 分支补集为其余三端，约束只提 iOS/Android 阈值，其中
    // Android 2.25.0 ≥ 2.10.0 满足、h5/harmony 未约束 → 0 报。
    expect(linter.verify(code, config)).toHaveLength(0);
  });

  it('无引擎配置 + 空条件（L1）→ 仍报 error', () => {
    const config = buildUnsupportedApiConfig(
      [
        {
          name: 'no-foo',
          selector: 'CallExpression[callee.name="foo"]',
          message: 'x',
          conditions: [],
          level: 'error',
          onResolveFail: 'warn',
        },
      ],
      null,
    );
    const msgs = linter.verify('foo();', config);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(2);
  });

  it('无引擎配置 + 非空条件 → 降级 warn（不静默漏报）', () => {
    const config = buildUnsupportedApiConfig([jueGetSystemInfoConstraint], null);
    const msgs = linter.verify('jue.system.getSystemInfo();', config);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(1);
  });
});
