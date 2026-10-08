// config 命令：生成引擎运行时配置（单引擎 + 数据文件的「分发层」最小版）
// 引擎配置是 repo 级固定配置：jue 绑定名 + 平台守卫映射 + 版本序清单，这里提供 CLI 收敛为 JSON 数据文件。
import path from 'node:path';
import { Command } from 'commander';
import type { Platform } from '../../types/index.js';
import { PLATFORM_VALUES, engineConfigSchema } from '../../types/index.js';
import { writeJSON } from '../../utils/file.js';

interface ConfigOptions {
  sdkName: string;
  flag: string[];
  envVar: string;
  envValue: string[];
  order: string[];
  output: string;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function parsePlatform(value: string): Platform {
  if (!(PLATFORM_VALUES as readonly string[]).includes(value)) {
    throw new Error(`平台取值非法：${value}（可选：${PLATFORM_VALUES.join(' | ')}）`);
  }
  return value as Platform;
}

/** 把 ["key=value"] 解析为 { key: value } */
function parsePairs(entries: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of entries) {
    const eq = raw.indexOf('=');
    if (eq === -1) throw new Error(`格式应为 key=value，收到：${raw}`);
    out[raw.slice(0, eq).trim()] = raw.slice(eq + 1).trim();
  }
  return out;
}

/** 校验并收敛值域为 Platform 的 key=value 映射（booleanFlags / envValues） */
function parsePlatformMap(entries: string[]): Record<string, Platform> {
  const out: Record<string, Platform> = {};
  for (const [key, value] of Object.entries(parsePairs(entries))) {
    out[key] = parsePlatform(value);
  }
  return out;
}

export const configCommand = new Command('config')
  .description('生成引擎运行时配置 JSON（jue 绑定名 + 平台守卫映射 + 版本序清单）')
  .option('--sdk-name <name>', '追踪的导入绑定名，如 jue', 'jue')
  .option('--flag <name=platform>', '布尔平台守卫映射，如 isIOS=ios（可重复）', collect, [])
  .option('--env-var <name>', '字符串环境变量名，如 environment', 'environment')
  .option('--env-value <value=platform>', 'envVar 取值 → 端映射，如 ios=ios（可重复）', collect, [])
  .option('--order <v1,v2,...>', 'jue 版本序清单（越靠后越新，逗号分隔，可重复）', collect, [])
  .option('--output <file>', '输出路径', 'output/engine-config.json')
  .action((opts: ConfigOptions) => {
    const config = {
      sdkName: opts.sdkName,
      guards: {
        booleanFlags: parsePlatformMap(opts.flag),
        envVar: opts.envVar,
        envValues: parsePlatformMap(opts.envValue),
      },
      order: opts.order.flatMap((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    };
    // 数据校验防线①：配置结构必须过 schema，未知字段/空项在此暴露
    const validated = engineConfigSchema.parse(config);
    const outPath = path.resolve(opts.output);
    writeJSON(outPath, validated);
    console.log(`引擎配置已生成：${outPath}`);
    console.log(JSON.stringify(validated, null, 2));
  });
