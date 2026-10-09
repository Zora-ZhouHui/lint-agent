// 数据文件读写：约束（LLM 唯一产物）与引擎配置（repo 固定配置）的磁盘出入口。
// 校验统一走 Zod schema，缺数据 / 目录名非法在引擎层保守失败，这里只负责存取。
import type { Constraint, EngineConfig } from '../types/index.js';
import { constraintArraySchema, engineConfigSchema } from '../types/index.js';
import { readJSON, writeJSON } from '../utils/file.js';
import { fillSelectors } from './selector.js';

export function writeConstraints(filePath: string, constraints: Constraint[]): void {
  writeJSON(filePath, constraints);
}

export function loadConstraints(filePath: string, sdkName = 'jue'): Constraint[] {
  const raw = constraintArraySchema.parse(readJSON<unknown>(filePath));
  return fillSelectors(raw as Constraint[], sdkName);
}

export function loadEngineConfig(filePath: string): EngineConfig {
  return engineConfigSchema.parse(readJSON<unknown>(filePath));
}

export function writeEngineConfig(filePath: string, config: EngineConfig): void {
  writeJSON(filePath, engineConfigSchema.parse(config));
}
