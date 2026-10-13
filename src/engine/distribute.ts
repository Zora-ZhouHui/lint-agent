// 分发层：把「约束数据 + 固定引擎」拼成可直接交给 ESLint 的 flat config 文件源码。
// 产物只做接线——导入已编译的单引擎 buildUnsupportedApiConfig、读取 constraints/engine-config 数据文件，
// 不生成任何规则逻辑（引擎代码固定，严格满足「规则代码零增长」）。
// 依赖 dist 编译产物，因此按「outputDir → dist/engine」的相对路径注入 import 前缀，
// 保证 --output 落到任意目录时都能正确解析引擎。

/**
 * 生成可运行的 eslint.config.mjs 源码。
 * @param engineDirRelative output 目录到 dist/engine 的相对路径（如 '../dist/engine'）
 */
export function renderFlatConfigSource(engineDirRelative: string): string {
  const prefix = engineDirRelative.replace(/\\/g, '/');
  return `// 由 lint-agent generate 自动生成：约束数据接入单引擎，产出可直接运行的 ESLint flat config。
// 依赖：同目录 constraints.json（约束数据，必选）、engine-config.json（引擎配置，可选；缺失时 L2 条件按 onResolveFail 降级）。
// 使用：先 npm run build 编译引擎，再 npx eslint -c 本文件 <目标目录>。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnsupportedApiConfig } from '${prefix}/unsupported-api.js';
import { loadConstraints, loadEngineConfig } from '${prefix}/data-file.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineConfigPath = path.join(here, 'engine-config.json');
const engineConfig = fs.existsSync(engineConfigPath) ? loadEngineConfig(engineConfigPath) : null;
// 必须用 engine-config 的 sdkName 加载约束：selector 由 target + sdkName 机械推导，
// 传错名字时 loadConstraints 会直接抛错，而不是让规则静默永不命中。
const constraints = loadConstraints(path.join(here, 'constraints.json'), engineConfig?.sdkName);

export default [buildUnsupportedApiConfig(constraints, engineConfig)];
`;
}
