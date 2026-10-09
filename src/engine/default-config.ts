// 默认引擎运行时配置：jue 绑定名 + 四端守卫映射 + 版本序清单。
// 与样例文档（examples/input/cross-platform-pitfalls.md）及测试夹具（tests/helpers.ts）对齐，
// 供 generate 首次生成 engine-config.json 时兜底，用户可用 config 命令显著覆盖。
import type { EngineConfig } from '../types/index.js';

export const defaultEngineConfig: EngineConfig = {
  sdkName: 'jue',
  guards: {
    booleanFlags: { isIOS: 'ios', isAndroid: 'android', isHarmony: 'harmony', isH5: 'h5' },
    envVar: 'environment',
    envValues: { ios: 'ios', android: 'android', harmony: 'harmony', h5: 'h5' },
  },
  order: [
    '2.0.0',
    '2.5.0',
    '2.6.0',
    '2.8.0',
    '2.10.0',
    '2.12.0',
    '2.15.0',
    '2.16.0',
    '2.18.0',
    '2.20.0',
    '2.22.0',
    '2.25.0',
    '2.28.0',
    '2.30.0',
    '2.32.0',
    '2.35.0',
    '2.40.0',
    '2.42.0',
    '2.45.0',
    '2.50.0',
  ],
};
