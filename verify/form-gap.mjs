// 形式缺口报告：把引擎自检的场景按「调用形式 × 决策」全量展开跑一遍真实 Linter，
// 统计引擎在非规范写法上的实际行为与决策轴期望的偏差，并按形式分组输出。
//
// 用途：量化「引擎的真实运行表面」与「校验体系覆盖的表面」之间的差集。
// 零 LLM：只跑真实 ESLint Linter，可离线、可进 CI。
//
// 用法：
//   npm run forms:gap                       # 用仓库固定快照
//   CONSTRAINTS_FILE=output/constraints.json npm run forms:gap
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { synthesizeScenarios, uncoveredPlatforms } from '../src/engine/behavior.js';
import { BUILTIN_FORMS, CANONICAL_FORM } from '../src/engine/forms.js';
import { buildUnsupportedApiConfig } from '../src/engine/unsupported-api.js';
import { loadConstraints } from '../src/engine/data-file.js';
import { defaultEngineConfig } from '../src/engine/default-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSTRAINTS_FILE = process.env.CONSTRAINTS_FILE
  ? path.resolve(ROOT, process.env.CONSTRAINTS_FILE)
  : path.join(ROOT, 'examples', 'expected', 'constraints.json');

const linter = new Linter({ configType: 'flat' });

/** 跑真实 Linter，把消息归约为 error / warn / ok。 */
function actualOf(code, constraint) {
  const msgs = linter.verify(code, buildUnsupportedApiConfig([constraint], defaultEngineConfig));
  if (msgs.some((m) => m.severity === 2)) return 'error';
  if (msgs.some((m) => m.severity === 1)) return 'warn';
  return 'ok';
}

const constraints = loadConstraints(CONSTRAINTS_FILE);
if (constraints.length === 0) {
  console.error('✖ 约束数据为空');
  process.exit(1);
}

const byForm = new Map();
let total = 0;
let red = 0;
/** 零覆盖端：配置缺该端守卫 → 该端一个场景都构造不出来，必须显式上报而不是让分母静默缩小 */
const uncovered = [];
for (const c of constraints) {
  const missing = uncoveredPlatforms(c, defaultEngineConfig);
  if (missing.length > 0) uncovered.push({ target: c.target, platforms: missing });
}

/** 判定一条场景的偏差类型：漏报 / 误报 / 档位错。 */
function classify(expect, actual) {
  if (expect === actual) return null;
  if (expect !== 'ok' && actual === 'ok') return 'miss'; // 该报没报：漏报
  if (expect === 'ok' && actual !== 'ok') return 'false'; // 不该报却报了：误报
  return 'severity'; // 该 error 只给 warn（或反之）：档位错，CI 不阻断
}

for (const constraint of constraints) {
  for (const s of synthesizeScenarios(constraint, defaultEngineConfig, { forms: BUILTIN_FORMS })) {
    const actual = actualOf(s.code, constraint);
    const kind = classify(s.expect, actual);
    total++;
    if (kind) red++;
    const bucket = byForm.get(s.formId) ?? {
      total: 0,
      should: 0,
      miss: 0,
      false: 0,
      severity: 0,
      samples: [],
    };
    bucket.total++;
    // 「应报场景」= 期望 error / warn 的场景；只有这些场景能测出真实拦截能力。
    // 期望 ok 的场景上，一条永不命中的规则也会"通过"——那是假通过，单列出来。
    const shouldFire = s.expect !== 'ok';
    if (shouldFire) bucket.should++;
    if (kind) {
      bucket[kind]++;
      if (bucket.samples.length < 3) {
        bucket.samples.push({
          target: constraint.target,
          scenarioId: s.id,
          expect: s.expect,
          actual,
        });
      }
    }
    byForm.set(s.formId, bucket);
  }
}

console.log(`\n约束 ${constraints.length} 条 · 场景 ${total} 个 · 形式 ${BUILTIN_FORMS.length} 种`);
console.log(`数据源：${path.relative(ROOT, CONSTRAINTS_FILE)}\n`);
console.log('形式                应报场景  实际报出   漏报   档位错   误报   拦截率');
console.log('─'.repeat(74));
for (const form of BUILTIN_FORMS) {
  const b = byForm.get(form.id);
  if (!b) continue;
  const fired = b.should - b.miss; // 应报且没有漏掉的
  const rate = b.should === 0 ? '  n/a' : `${((fired / b.should) * 100).toFixed(1).padStart(5)}%`;
  const mark = b.miss + b.severity + b.false > 0 ? '  ← 缺口' : '';
  console.log(
    `${form.id.padEnd(20)} ${String(b.should).padStart(6)} ${String(fired).padStart(8)} ${String(b.miss).padStart(6)} ${String(b.severity).padStart(7)} ${String(b.false).padStart(6)}   ${rate}${mark}`,
  );
}
console.log('─'.repeat(74));
console.log(`「拦截率」= 应报场景中引擎真的报出来的比例（漏报即未拦住）。`);
console.log(`总偏差（漏报 + 档位错 + 误报）：${red} / ${total}`);
if (uncovered.length > 0) {
  const platforms = [...new Set(uncovered.flatMap((u) => u.platforms))];
  console.log(
    `⚠ 零覆盖端：${uncovered.length} 条约束在 ${platforms.join('/')} 上没有场景` +
      '（引擎配置缺布尔守卫），未计入上面的分母',
  );
  for (const u of uncovered.slice(0, 5)) console.log(`    ${u.target}：${u.platforms.join('/')}`);
}
console.log('');

const nonCanonical = [...byForm.entries()].filter(([id]) => id !== CANONICAL_FORM.id);
const gapsOf = (b) => b.miss + b.severity + b.false;
const gaps = nonCanonical.reduce((n, [, b]) => n + gapsOf(b), 0);
if (gaps > 0) {
  console.log('非规范形式的失败明细（前 12 条）：');
  let shown = 0;
  for (const [id, b] of nonCanonical) {
    for (const s of b.samples) {
      if (shown++ >= 12) break;
      console.log(`  [${id}] ${s.target} · ${s.scenarioId} · 期望 ${s.expect} / 实际 ${s.actual}`);
    }
    if (shown >= 12) break;
  }
  console.log(
    `\n结论：引擎在 ${nonCanonical.filter(([, b]) => gapsOf(b) > 0).length} 种非规范写法上存在 ${gaps} 个缺口，` +
      `这些缺口在只用规范形式的校验里覆盖率为 0。`,
  );
} else {
  console.log('结论：所有形式均与决策轴期望一致（无形式缺口）。');
}

if (red > 0) process.exitCode = 1;
