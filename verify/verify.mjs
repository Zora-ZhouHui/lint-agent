// 端到端校验：把 Agent 提取的约束（output/constraints.json）接进单引擎 ESLint 规则，
// 对 verify/app 里的 jue SDK 真实示例代码跑一次 lint，验证约束数据真能抓到跨端违规写法。
//
// 用法：先跑 npm run generate 生成约束数据，再跑 npm run verify:lint。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { loadConstraints } from '../src/engine/data-file.js';
import { buildUnsupportedApiConfig } from '../src/engine/unsupported-api.js';
import { defaultEngineConfig } from '../src/engine/default-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSTRAINTS_FILE = path.join(ROOT, 'output', 'constraints.json');
const APP_DIR = path.join(ROOT, 'verify', 'app');

// 每个示例文件对应的违规点描述（用于覆盖率核对）
const EXPECTED_PITFALLS = [
  { file: 'version-violation.js', hint: 'iOS 低版本调用需更高版本的 API' },
  { file: 'harmony-violation.js', hint: '鸿蒙调用不支持的 API' },
];
const CLEAN_FILE = 'clean.js';

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(abs));
    else if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out.sort();
}

function main() {
  if (!fs.existsSync(CONSTRAINTS_FILE)) {
    console.error('\n✖ 没找到约束数据文件（output/constraints.json）。请先运行 npm run generate。');
    process.exit(1);
  }

  const constraints = loadConstraints(CONSTRAINTS_FILE);
  console.log(`\n加载约束 ${constraints.length} 条：`);
  for (const c of constraints) {
    console.log(`  - ${c.name}：${c.message}`);
  }

  if (constraints.length === 0) {
    console.error('\n✖ 校验失败：约束数据为空，提取阶段未产出任何可静态检测的约束。');
    process.exit(1);
  }

  // 单引擎 + 默认 jue 配置：版本与平台守卫解析均生效
  const config = buildUnsupportedApiConfig(constraints, defaultEngineConfig);

  // Linter 走 flat 配置、逐文件 verify，不需要磁盘上的 eslint.config 文件
  const linter = new Linter({ configType: 'flat' });
  const hitsByFile = new Map();
  const ruleCount = new Map();
  for (const file of walkJs(path.join(APP_DIR, 'src'))) {
    const rel = path.relative(APP_DIR, file);
    const code = fs.readFileSync(file, 'utf8');
    const msgs = linter.verify(code, config, { filename: file }).filter((m) => m.severity === 2);
    hitsByFile.set(rel, msgs);
    for (const m of msgs) {
      ruleCount.set(m.ruleId, (ruleCount.get(m.ruleId) ?? 0) + 1);
    }
  }

  let total = 0;
  console.log('\n════ 命中明细 ════');
  for (const [file, msgs] of hitsByFile) {
    if (msgs.length === 0) continue;
    console.log(`\n${file}`);
    for (const m of msgs) {
      total += 1;
      console.log(`  ${m.line}:${m.column}  ${m.message}`);
    }
  }
  if (total === 0) console.log('（无任何违规被命中）');

  console.log('\n════ 规则命中统计 ════');
  for (const [ruleId, count] of ruleCount) {
    console.log(`  ${ruleId}: ${count} 处`);
  }

  console.log('\n════ 违规点覆盖率 ════');
  let uncovered = 0;
  for (const p of EXPECTED_PITFALLS) {
    const msgs = hitsByFile.get(path.join('src', p.file)) ?? [];
    const ok = msgs.length > 0;
    if (!ok) uncovered += 1;
    console.log(`  ${ok ? '✔' : '✘'} ${p.file}（${p.hint}）：命中 ${msgs.length} 处`);
  }
  const cleanMsgs = hitsByFile.get(path.join('src', CLEAN_FILE)) ?? [];
  const cleanOk = cleanMsgs.length === 0;
  console.log(
    `  ${cleanOk ? '✔' : '✘'} ${CLEAN_FILE}（合规对照）：命中 ${cleanMsgs.length} 处（应为 0）`,
  );

  console.log(`\n总命中：${total} 处`);

  // 硬性失败条件：没约束 / 一条都没抓到 / 合规对照被误报。
  // 违规点“未命中”属于提取质量信号（见下方提示），不阻断退出码——但会明确标注。
  if (total === 0) {
    console.error('\n✖ 校验失败：没有任何违规被命中，说明提取阶段未产出有效约束。');
    process.exit(1);
  }
  if (!cleanOk) {
    console.error('\n✖ 校验失败：合规对照被误报（约束 selector 过宽或版本/平台解析偏差）。');
    process.exit(1);
  }

  if (uncovered > 0) {
    console.log(
      `\n⚠ 提示：${uncovered} 个违规点未被命中——通常不是校验脚本的问题，而是提取阶段的 selector 写偏` +
        `（如 API 名拼写错或多加了不存在的节点层）。可据此调 extract prompt。`,
    );
  }

  console.log('\n✔ 校验通过：约束数据在真实 jue 代码上抓到了违规写法，且合规对照未被误报。');
  process.exit(0);
}

main();
