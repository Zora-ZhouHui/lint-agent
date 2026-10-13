// 数据文件读写：约束（LLM 唯一产物）与引擎配置（repo 固定配置）的磁盘出入口。
// 校验统一走 Zod schema，缺数据 / 目录名非法在引擎层保守失败，这里只负责存取。
import type { Constraint, EngineConfig } from '../types/index.js';
import { constraintArraySchema, engineConfigSchema } from '../types/index.js';
import { readJSON, writeJSON } from '../utils/file.js';
import { fillSelectors, nameFromTarget, targetToSelector } from './selector.js';

export function writeConstraints(filePath: string, constraints: Constraint[]): void {
  writeJSON(filePath, constraints);
}

/**
 * selector 是由 target + sdkName 机械推导的，不允许与配置漂移。
 *
 * 漂移的典型来源：改了 `engine-config.json` 的 sdkName（例如 SDK 改名），却沿用旧的
 * constraints.json。此时 selector 里仍写着旧名字，规则**永不命中、CI 全绿、没有任何告警**
 * ——属于最危险的一类静默失效。这里 fail-closed：宁可加载即报错，也不静默失效。
 */
function assertSelectorsConsistent(constraints: Constraint[], sdkName: string): void {
  const mismatched: string[] = [];
  for (const c of constraints) {
    let expected: string | null;
    try {
      expected = targetToSelector(c.target, sdkName);
    } catch {
      // target 首段与 sdkName 不符（或段数非法）同样属于「数据与配置漂移」——
      // 这类 target 不可能由本流水线生成，必须报出来而不是跳过。
      expected = null;
    }
    if (expected === null || c.selector !== expected) mismatched.push(c.target);
  }
  if (mismatched.length > 0) {
    throw new Error(
      `约束数据的 selector 与 sdkName="${sdkName}" 不一致（${mismatched.length} 条，如 ${mismatched[0]}）。` +
        '通常是改了 engine-config.json 的 sdkName 但没重新生成 constraints.json；' +
        '这会让规则永不命中且 CI 全绿，请重新运行 generate。',
    );
  }
}

/**
 * 读盘时把两个「由 target 机械推导」的字段补齐：
 *   - `selector`：由 fillSelectors 按 config 的 sdkName 推导（缺省时填充）；
 *   - `name`：**无条件重算**。旧数据可能缺失，也可能带着 LLM 写错的 name（如整条 API
 *     路径）——name 是 judge verdict 的对齐键，不能信任磁盘上的内容。
 *
 * 逐条容错：target 与 sdkName 不符时 name 推导会抛错，此处**吞掉**，把这类数据留给
 * `assertSelectorsConsistent` 统一 fail-closed 报出（否则会先抛出一句关于 target 的
 * 内部错误，掩盖真正的原因——「sdkName 漂移」）。
 */
function deriveMechanicalFields(raw: Constraint[], sdkName: string): Constraint[] {
  const withSelectors = fillSelectors(raw, sdkName);
  return withSelectors.map((c) => {
    try {
      return { ...c, name: nameFromTarget(c.target, sdkName) };
    } catch {
      return c;
    }
  });
}

export function loadConstraints(filePath: string, sdkName = 'jue'): Constraint[] {
  const parsed = constraintArraySchema.parse(readJSON<unknown>(filePath));
  const constraints = deriveMechanicalFields(parsed as Constraint[], sdkName);
  assertSelectorsConsistent(constraints, sdkName);
  return constraints;
}

export function loadEngineConfig(filePath: string): EngineConfig {
  return engineConfigSchema.parse(readJSON<unknown>(filePath));
}

export function writeEngineConfig(filePath: string, config: EngineConfig): void {
  writeJSON(filePath, engineConfigSchema.parse(config));
}
