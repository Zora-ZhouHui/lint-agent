// 文档上下文收窄（换输入视角）：把「整篇文档」换成「该 API 的条目 + 全局约定前言」。
//
// 为什么需要它（这是打破同源最便宜的一招，不需要换模型）：
// 提取链与复判链看的是同一份全文、同一套语境，容易顺着同样的语感做出**同向误读**
// ——抄错「鸿蒙」成「iOS」时，复判端也可能认同，差分静默通过。
// 把复判端的输入从全文收窄到「与本条 API 直接相关的片段」，切断了共享的全文语境；
// 再强制它**先逐字引用原文、再判定**，把判定变成「引用 → 判定」两步：
//   - 引不出来 → 说明它没有从文档读到依据，必须判 unclear，而不是猜一个 verdict；
//   - 引出来的原句若在提供的片段里根本不存在（幻觉引用），该判定作废。
//
// 本模块是纯函数、零 LLM，不依赖任何 LLM / ESLint。

import type { Constraint } from '../types/index.js';

/** 一个 API 条目：标题行 + 正文（到下一个同级/更高级标题为止）。 */
export interface DocSection {
  /** 标题行里的完整 API 路径，如 jue.system.getSystemInfo */
  apiPath: string;
  /** 标题文本（不含 `###` 前缀） */
  title: string;
  /** 该条目的完整文本（标题行 + 正文），保留原文换行 */
  body: string;
}

/** 收窄结果：给复判端的文档内容 + 可观测的匹配状态。 */
export interface NarrowedDoc {
  /** 前言（全局约定）+ 命中条目；未命中任何条目时退回全文 */
  text: string;
  /** 实际命中的 API 路径 */
  matched: string[];
  /** 请求了但文档里找不到对应条目的 API 路径 */
  unmatched: string[];
  /** 是否退回了全文（unmatched 非空时为 true，宁可给多也不给错） */
  fellBackToFullDoc: boolean;
}

/** 条目标题行，如 `### 23. jue.network.request [硬校验]`。 */
const SECTION_HEADING_RE = /^#{2,4}\s*\d+\.\s+\S/;

/** 前言边界：第一个条目标题之前的内容（全局约定都在这里）。 */
function findPreamble(doc: string): string {
  const lines = doc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADING_RE.test(lines[i])) return lines.slice(0, i).join('\n').trimEnd();
  }
  return '';
}

/**
 * 把一个标题行里的 API 路径抠出来。
 * 标题形如 `### 1. jue.system.getSystemInfo [硬校验]`，取 `jue.` 开头的最长路径段。
 */
export function apiPathFromHeading(heading: string, sdkName = 'jue'): string | null {
  const re = new RegExp(`\\b${sdkName}\\.[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)+`);
  const m = heading.match(re);
  return m ? m[0] : null;
}

/**
 * 把文档切成「前言 + 一组 API 条目」。
 *
 * 为什么只按标题切、不做跨条目依赖展开：文档的实际结构是「一条目一个 API」，
 * 版本/平台约束都写在该条目正文里，因此切片是精确的。若某条目确实依赖另一条目
 * （如「改用 jue.network.getNetworkType」这类迁移建议），那属于**参照**而非**约束来源**，
 * 对应的 API 自己另有条目；真出现依赖缺口时，收窄会通过 `unmatched` 暴露出来，
 * 而不是静默给出错误片段。
 */
export function parseDocSections(doc: string, sdkName = 'jue'): DocSection[] {
  const lines = doc.split('\n');
  const all: DocSection[] = [];
  let current: { apiPath: string | null; title: string; start: number } | null = null;

  const flush = (endExclusive: number): void => {
    if (!current) return;
    all.push({
      apiPath: current.apiPath ?? '',
      title: current.title,
      body: lines.slice(current.start, endExclusive).join('\n').trimEnd(),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SECTION_HEADING_RE.test(line)) continue;
    flush(i); // 结算上一个条目（到本行之前）
    current = {
      apiPath: apiPathFromHeading(line, sdkName),
      title: line.replace(/^#+\s*/, '').trim(),
      start: i,
    };
  }
  flush(lines.length);

  // 标题里有 API 路径的才是 API 条目（分组标题、无路径的说明条目不参与收窄）
  return all.filter((s) => s.apiPath !== '');
}

/**
 * 从「合成场景代码」机械提取被调用的 SDK 挂载 API 路径。
 *
 * 为什么从代码提取而不是直接用约束的 target：复判端的输入契约就是「只看文档 + 代码」。
 * 既然代码里本来就有 `jue.module.method()`，从中提取不额外泄露任何约束信息，
 * 也不破坏输入隔离。提取不到时返回 null，调用方退回全文（保守优先）。
 *
 * 取「最长匹配」：`jue.storage.setSync` 与 `jue.storage.set` 同时出现时取更长的那个。
 */
export function extractApiPathFromCode(code: string, sdkName = 'jue'): string | null {
  const re = new RegExp(`\\b${sdkName}(?:\\.[a-zA-Z_$][\\w$]*)+`, 'g');
  let best: string | null = null;
  for (const m of code.matchAll(re)) {
    if (!best || m[0].length > best.length) best = m[0];
  }
  return best;
}

/**
 * 按 API 路径**精确**命中条目。
 *
 * 刻意不做「同模块放宽」（如 `jue.media.previewImage` 落到 `jue.media.getCamera` 的条目）：
 * A 的规则不能由 B 的文档背书，把邻居条目喂过去等于给复判端一个错误的依据来源。
 * 精确命不中就走 `narrowDocToApis` 的退回全文路径，宁可给多、不可给错。
 *
 * 同名多节必须全部保留（如 `### 23. jue.network.request [硬校验]` 与
 * `### 33. jue.network.request 并发上限控制 [跳过]`）：只留一节会把另一节里的
 * 约束依据切掉，复判端会因「看不到」而误判 evidence 编造、level 标错。
 */
function matchSections(sections: DocSection[], apiPaths: string[]): DocSection[] {
  const wanted = new Set(apiPaths);
  return sections.filter((s) => wanted.has(s.apiPath));
}

/**
 * 收窄文档：只保留前言 + 指定 API 的条目。
 *
 * - `apiPaths` 为空 → 直接返回全文（无从收窄，保守）。
 * - 任一 API 在文档里找不到条目 → **退回全文**（宁可给多、不可给错：收窄若把依据切掉了，
 *   复判端会因「看不到」而误判 unclear，把真错误洗成「无法判断」）。
 */
export function narrowDocToApis(doc: string, apiPaths: string[], sdkName = 'jue'): NarrowedDoc {
  const wanted = [...new Set(apiPaths.filter(Boolean))];
  if (wanted.length === 0) {
    return { text: doc, matched: [], unmatched: [], fellBackToFullDoc: true };
  }

  const sections = parseDocSections(doc, sdkName);
  const picked = matchSections(sections, wanted);
  const matchedPaths = new Set(picked.map((s) => s.apiPath));
  const unmatched = wanted.filter((p) => !matchedPaths.has(p));

  if (picked.length === 0 || unmatched.length > 0) {
    return { text: doc, matched: [...matchedPaths], unmatched, fellBackToFullDoc: true };
  }

  const preamble = findPreamble(doc);
  const text = [preamble, '', ...picked.map((s) => s.body)].filter(Boolean).join('\n\n');
  return { text, matched: [...matchedPaths], unmatched: [], fellBackToFullDoc: false };
}

/** 归一化：折叠空白后比较，容忍换行/全半角空格差异。 */
function normalizeForCitation(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 校验复判端引用的原句是否**逐字存在**于它看到的文档片段中。
 *
 * 为什么必须有这道校验：要求「先引原句」这件事，如果没有校验，LLM 会直接编一句
 * 看起来像文档的话——于是「引用先行」退化成装饰，反而给了虚假的可信感。
 * 引用不存在 → 该条判定作废（按 unclear 处理），绝不当成有效信号。
 *
 * 归一化后比较：文档里的换行/缩进不应让正确的引用被判为幻觉。
 * 空引用（未提供 cite 字段）一律判无效——没引用就没有依据。
 */
export function validateCitation(citation: unknown, docText: string, minLength = 8): boolean {
  if (typeof citation !== 'string') return false;
  const cite = normalizeForCitation(citation);
  if (cite.length < minLength) return false;
  return normalizeForCitation(docText).includes(cite);
}

/** 从约束数组取 target 列表（收窄 judge 输入用）。 */
export function targetsOf(constraints: Constraint[]): string[] {
  return constraints.map((c) => c.target);
}
