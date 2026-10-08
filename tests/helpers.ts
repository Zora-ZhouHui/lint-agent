// 测试公共夹具
import type { AgentContext, Constraint, EngineConfig } from '../src/types/index.js';

export const atConstraint: Constraint = {
  name: 'no-array-at',
  selector: 'MemberExpression[property.name="at"]',
  message: '禁止 Array.prototype.at',
  conditions: [
    { kind: 'unsupported', platform: 'android' },
    { kind: 'unsupported', platform: 'ios' },
  ],
  level: 'error',
  onResolveFail: 'warn',
};

export const hasOwnConstraint: Constraint = {
  name: 'no-object-hasown',
  selector: 'CallExpression[callee.object.name="Object"][callee.property.name="hasOwn"]',
  message: '禁止 Object.hasOwn',
  conditions: [
    { kind: 'unsupported', platform: 'android' },
    { kind: 'unsupported', platform: 'ios' },
  ],
  level: 'error',
  onResolveFail: 'warn',
};

// jue 样例约束：jue.system.getSystemInfo —— iOS ≥ 2.25.0、Android ≥ 2.10.0
export const jueGetSystemInfoConstraint: Constraint = {
  name: 'no-system-getsysteminfo',
  selector:
    'CallExpression[callee.object.object.name="jue"][callee.object.property.name="system"][callee.property.name="getSystemInfo"]',
  message: 'iOS 需 jue ≥ 2.25.0、Android 需 jue ≥ 2.10.0',
  conditions: [
    { kind: 'min_version', platform: 'ios', minVersion: '2.25.0' },
    { kind: 'min_version', platform: 'android', minVersion: '2.10.0' },
  ],
  level: 'error',
  onResolveFail: 'warn',
};

export function makeEngineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    sdkName: 'jue',
    guards: {
      booleanFlags: {
        isIOS: 'ios',
        isAndroid: 'android',
        isHarmony: 'harmony',
        isH5: 'h5',
      },
      envVar: 'environment',
      envValues: { ios: 'ios', android: 'android', harmony: 'harmony', h5: 'h5' },
    },
    order: ['2.0.0', '2.5.0', '2.10.0', '2.15.0', '2.20.0', '2.25.0', '2.30.0'],
    ...overrides,
  };
}

export function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    inputDoc: '测试文档',
    constraints: [],
    currentStep: 0,
    maxSteps: 20,
    history: [],
    failures: [],
    ...overrides,
  };
}
