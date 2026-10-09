// 一次性工具：为固定快照（examples/expected/constraints.json）回填 evidence 字段。
// 背景：Constraint 新增 evidence（文档原文字句引用）后，历史快照没有该字段。
// 与其全量重跑 generate（约束内容会随 LLM 变化），不如只对现有快照补 evidence——
// 逐条定位 target 所在文档章节，让 LLM 逐字摘录支撑句，并校验引用确实存在于该章节。
//
// 用法：npm run snapshot:backfill-evidence
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadDotEnv } from '../src/utils/env.js';
import { LLMClient, loadLLMConfigFromEnv } from '../src/llm/client.js';
import { loadConstraints, writeConstraints } from '../src/engine/data-file.js';
import { splitSections } from '../src/skills/extract-patterns.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, 'examples', 'expected', 'constraints.json');
const DOC = path.join(ROOT, 'examples', 'input', 'cross-platform-pitfalls.md');
const BATCH_SIZE = 20;

const evidenceSchema = z.array(
  z.object({ name: z.string().min(1), evidence: z.string().min(1) }),
);

/** 正则转义（target 含 . 等元字符）。 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 定位 target 的定义章节（evidence 应从这里摘录）：
 * 1. 标题含 target（`### 24. jue.network.get [硬校验]`）——定义章节，优先；
 * 2. 正文词边界匹配——避免 `jue.network.get` 撞上 `jue.network.getNetworkType` 这类子串前缀；
 * 3. 返回 null → 退回全文作为锚。
 * 不能用裸 includes：迁移提及（「改用 jue.xxx」）会让首次命中落在错误章节。
 */
function findAnchorSection(target, sections) {
  const esc = escapeRegExp(target);
  return (
    sections.find((s) => new RegExp(`^#{2,4}\\s+\\d+\\.\\s+${esc}(\\s|$|\\[)`, 'm').test(s)) ??
    sections.find((s) => new RegExp(`${esc}(?![A-Za-z0-9_])`).test(s)) ??
    null
  );
}

async function main() {
  loadDotEnv(ROOT);
  const doc = fs.readFileSync(DOC, 'utf8');
  const constraints = loadConstraints(SNAPSHOT);
  const sections = splitSections(doc);
  const llm = new LLMClient(loadLLMConfigFromEnv());

  console.log(`快照约束 ${constraints.length} 条，文档章节 ${sections.length} 块\n`);

  // 已有合法 evidence 的条目跳过——脚本可安全重跑，只补失败/为空的
  const todo = constraints.filter((c) => {
    if (!c.evidence) return true;
    const anchor = findAnchorSection(c.target, sections) ?? doc;
    if (anchor.includes(c.evidence)) return false;
    console.warn(`⚠ ${c.name}：既有 evidence 未通过原文校验，重新回填`);
    return true;
  });
  if (todo.length < constraints.length) {
    console.log(`跳过已回填 ${constraints.length - todo.length} 条，待处理 ${todo.length} 条\n`);
  }
  if (todo.length === 0) {
    console.log('全部约束已有合法 evidence，无需回填');
    return;
  }

  // 为一批约束回填 evidence：给 LLM 每条约束的 target 所在章节，要求逐字摘录
  async function backfillBatch(batch) {
    const lines = batch.map((c) => {
      const section = findAnchorSection(c.target, sections) ?? doc;
      return `- name: ${c.name}\n  target: ${c.target}\n  所在章节：\n${section}`;
    });
    const out = await llm.chatJSON(
      [
        {
          role: 'system',
          content: [
            '你是文档审计员。对下面每条约束，从其「所在章节」中逐字摘录支撑该约束的那句话作为 evidence。',
            '要求：',
            '- evidence 必须能在该章节中逐字找到（原样复制，禁止改写、概括、拼接）',
            '- 优先摘录包含版本阈值 / 平台标注的那句话',
            '- 每条输入约束输出一个 { name, evidence } 对象，name 一一对应',
            '只输出 JSON 数组。',
          ].join('\n'),
        },
        { role: 'user', content: lines.join('\n\n') },
      ],
      evidenceSchema,
      { label: 'backfill_evidence', temperature: 0, maxTokens: 4096, structuredOutput: true },
    );
    return out;
  }

  let filled = 0;
  let failed = 0;
  for (let i = 0; i < constraints.length; i += BATCH_SIZE) {
    const batch = constraints.slice(i, i + BATCH_SIZE);
    let out = [];
    try {
      out = await backfillBatch(batch);
    } catch (err) {
      console.error(`⚠ 第 ${i}-${i + batch.length} 条回填失败：${err.message}`);
      failed += batch.length;
      continue;
    }
    const byName = new Map(out.map((e) => [e.name, e.evidence]));
    for (const c of batch) {
      const evidence = byName.get(c.name);
      // 防伪证：evidence 必须逐字出现在 target 的定义章节（找不到定义章节时退回全文校验）
      const anchor = findAnchorSection(c.target, sections) ?? doc;
      if (evidence && anchor.includes(evidence)) {
        c.evidence = evidence;
        filled++;
      } else {
        console.warn(
          `⚠ ${c.name}：evidence 未通过原文校验（${evidence ? '引用不在章节内' : '未返回'}）`,
        );
        failed++;
      }
    }
  }

  writeConstraints(SNAPSHOT, constraints);
  console.log(
    `\n完成：成功回填 ${filled} 条，失败 ${failed} 条 → ${path.relative(ROOT, SNAPSHOT)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
