// 测试公共夹具
import type { Constraint, EngineConfig } from '../src/types/index.js';
import { defaultEngineConfig } from '../src/engine/default-config.js';

// jue 样例约束：jue.system.getSystemInfo —— iOS ≥ 2.25.0、Android ≥ 2.10.0
export const jueGetSystemInfoConstraint: Constraint = {
  name: 'no-system-getsysteminfo',
  target: 'jue.system.getSystemInfo',
  selector:
    'CallExpression[callee.object.object.name="jue"][callee.object.property.name="system"][callee.property.name="getSystemInfo"]',
  message: 'iOS 需 jue ≥ 2.25.0、Android 需 jue ≥ 2.10.0',
  conditions: [
    { kind: 'min_version', platform: 'ios', minVersion: '2.25.0' },
    { kind: 'min_version', platform: 'android', minVersion: '2.10.0' },
  ],
  level: 'error',
  onResolveFail: 'warn',
  evidence: 'iOS 需 jue ≥ 2.25.0，Android 需 jue ≥ 2.10.0。低于阈值改用静态字段兜底。',
};

/** 默认 jue 引擎配置（唯一真相源在 defaultEngineConfig），可叠加覆盖。 */
export function makeEngineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return { ...defaultEngineConfig, ...overrides };
}
