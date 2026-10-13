import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Linter } from 'eslint';
import { compare, isViolation, type ViolationInput } from '../src/engine/conditions.js';
import { buildUnsupportedApiConfig } from '../src/engine/unsupported-api.js';
import { loadConstraints } from '../src/engine/data-file.js';
import { nameFromTarget } from '../src/engine/selector.js';
import { constraintArraySchema } from '../src/types/index.js';
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
    // target 必须是合法的 SDK 挂载路径：匹配由 target 机械推导的形状 selector 驱动，
    // 手写 selector 不再参与匹配（见 engine/selector.ts targetToShapeSelectors）。
    // 无 engineConfig 时 SDK 名退回约定值 'jue'，绑定判定仍识别规范名调用。
    const config = buildUnsupportedApiConfig(
      [{ ...jueGetSystemInfoConstraint, conditions: [] }],
      null,
    );
    const msgs = linter.verify('jue.system.getSystemInfo();', config);
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

describe('SDK 调用识别（别名导入 / 解构导入 / 防误报）', () => {
  const linter = new Linter({ configType: 'flat' });
  const config = buildUnsupportedApiConfig([jueGetSystemInfoConstraint], makeEngineConfig());

  it('别名导入：import J from .../jue/V → J.system.getSystemInfo() 照常命中', () => {
    const code = `import J from './jue/2.6.0';\nif (isIOS) {\n  J.system.getSystemInfo();\n}\n`;
    const msgs = linter.verify(code, config);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(2);
  });

  it('解构导入：const { system } = jue → system.getSystemInfo() 照常命中', () => {
    const code = `import jue from './jue/2.6.0';\nconst { system } = jue;\nif (isIOS) {\n  system.getSystemInfo();\n}\n`;
    const msgs = linter.verify(code, config);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(2);
  });

  it('解构重命名：const { system: sys } = jue → sys.getSystemInfo() 也能命中', () => {
    const code = `import jue from './jue/2.6.0';\nconst { system: sys } = jue;\nif (isIOS) {\n  sys.getSystemInfo();\n}\n`;
    expect(linter.verify(code, config)).toHaveLength(1);
  });

  it('别名 + 非 SDK 同名写法不误报（绑定必须能证明来自 SDK 目录）', () => {
    // myLib 不是从 jue 目录导入的 → 同形调用不得被拦
    const code = `import myLib from './vendor/myLib/1.0.0';\nif (isIOS) {\n  myLib.system.getSystemInfo();\n}\n`;
    expect(linter.verify(code, config)).toHaveLength(0);
  });

  it('解构自非 SDK 对象不误报', () => {
    const code = `import other from './other';\nconst { system } = other;\nif (isIOS) {\n  system.getSystemInfo();\n}\n`;
    expect(linter.verify(code, config)).toHaveLength(0);
  });

  it('未声明的同名根标识不误报', () => {
    const code = `if (isIOS) {\n  whatever.system.getSystemInfo();\n}\n`;
    expect(linter.verify(code, config)).toHaveLength(0);
  });

  it('版本仍按调用点解析：别名新旧版本共存时各自判定', () => {
    const code =
      `import JNew from './jue/2.30.0';\n` +
      `import JOld from './jue/2.6.0';\n` +
      `if (isIOS) {\n  JNew.system.getSystemInfo();\n  JOld.system.getSystemInfo();\n}\n`;
    const msgs = linter.verify(code, config);
    // 2.30.0 满足 iOS ≥ 2.25.0 放行；2.6.0 不满足 → 只报 1 条
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe(2);
  });
});

describe('loadConstraints（selector 与 sdkName 一致性断言）', () => {
  it('sdkName 漂移 → 加载即报错，而不是让规则静默永不命中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-agent-'));
    try {
      const file = join(dir, 'constraints.json');
      // selector 是按 jue 推导的，却用 sdkName='sdk' 加载 → 必须 fail-closed
      writeFileSync(file, JSON.stringify([jueGetSystemInfoConstraint]));
      expect(() => loadConstraints(file, 'sdk')).toThrow(/selector 与 sdkName/);
      expect(() => loadConstraints(file, 'jue')).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('name 由 target 机械推导（不再由 LLM 产出）', () => {
  it('nameFromTarget 产出 no-<module>-<method>，与历史产物约定一致', () => {
    expect(nameFromTarget('jue.system.getSystemInfo', 'jue')).toBe('no-system-getsysteminfo');
    expect(nameFromTarget('jue.router.navigateTo', 'jue')).toBe('no-router-navigateto');
    // 2 段路径也支持
    expect(nameFromTarget('jue.login', 'jue')).toBe('no-login');
  });

  it('不同 target 必得不同 name（name 是 judge verdict 的对齐键，不能撞）', () => {
    // 真实文档里存在这种「同方法名、不同模块」的 API —— 用方法名本身当 name 就会撞
    const targets = [
      'jue.system.getNetworkType',
      'jue.network.getNetworkType',
      'jue.system.getClipboard',
      'jue.clipboard.getClipboardData',
    ];
    const names = targets.map((t) => nameFromTarget(t, 'jue'));
    expect(new Set(names).size).toBe(targets.length);
  });

  it('target 与 sdkName 不符时抛错（由调用方决定如何 fail-closed）', () => {
    expect(() => nameFromTarget('sdk.system.getSystemInfo', 'jue')).toThrow(/必须以 jue 开头/);
  });

  it('loadConstraints 会用 target 重算 name —— 磁盘上的错 name 不作数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-agent-name-'));
    try {
      const file = join(dir, 'constraints.json');
      // 模拟旧数据里 name 与 target 不一致（历史产物/人工编辑都可能造成）
      writeFileSync(
        file,
        JSON.stringify([{ ...jueGetSystemInfoConstraint, name: 'wrong-name-from-disk' }]),
      );
      const [c] = loadConstraints(file, 'jue');
      // 读盘后必须被纠正为推导值，否则 judge verdict 对齐会整体错位
      expect(c.name).toBe('no-system-getsysteminfo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('name 不属于 LLM 输出契约：模型多输出的 name 被剥离，由推导值取代', () => {
    // 这是本次修复的核心。真实失效形态：LLM 把 name 填成 API 路径（违反 kebab-case）。
    // 旧实现在这里因 Zod 校验失败 → 整批补提取作废 → 9 条漏提三轮修不回来。
    // 今 name 已从 LLM 输出 schema 移除，非法值既不参与校验也不会落盘。
    const parsed = constraintArraySchema.parse([
      {
        name: 'jue.system.getSystemInfo', // 模型多输出的脏字段
        target: 'jue.system.getSystemInfo',
        message: 'm',
        conditions: [],
      },
    ]);
    expect(parsed[0]).not.toHaveProperty('name');
    // 推导后得到合法且稳定的标识
    expect(nameFromTarget(parsed[0].target, 'jue')).toBe('no-system-getsysteminfo');
  });

  it('loadConstraints 容忍缺失 name（旧快照兼容）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-agent-noname-'));
    try {
      const file = join(dir, 'constraints.json');
      const { name: _drop, ...withoutName } = jueGetSystemInfoConstraint;
      writeFileSync(file, JSON.stringify([withoutName]));
      const [c] = loadConstraints(file, 'jue');
      expect(c.name).toBe('no-system-getsysteminfo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
