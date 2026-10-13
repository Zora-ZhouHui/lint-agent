// 覆盖率引擎：不依赖任何手写 JSON 基线，直接从文档抽取 SDK 挂载 API 路径，
// 与生成约束的 target 做差集，报告「漏提」与「幻觉」两类提取缺口。
//
// 文档中标注 [跳过] 的 API 是预期不提取的，已从 missed 中排除，单独列入 skippedInDoc。
import type { Constraint } from '../types/index.js';

/**
 * 从 markdown 文档抽取 SDK 挂载 API 全路径（如 jue.system.getSystemInfo）。
 * 要求 jue 后至少还有两级段（模块.方法），从而不会把仅提「模块名」的 [跳过] 条目
 * （如 jue.storage）或「jue SDK」这类自然语言误当成 API 全路径。
 *
 * 排除只出现在反引号行内代码（`code`）内的路径——这些通常是文档占位符
 * （如 `jue.module.method`），不是真实 API。真实 API 在节标题或正文裸文本中
 * 至少出现一次。
 */
export function extractApiPaths(doc: string, sdkName = 'jue'): string[] {
  const re = new RegExp(`\\b${sdkName}\\.[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)+`, 'g');
  const all = new Set<string>();
  for (const m of doc.matchAll(re)) all.add(m[0]);

  // 剥掉反引号行内代码后再匹配，得到「裸文本中出现的」路径集合
  const stripped = doc.replace(/`[^`]*`/g, '');
  const plain = new Set<string>();
  for (const m of stripped.matchAll(re)) plain.add(m[0]);

  // 只保留至少在裸文本中出现过一次的路径
  return [...all].filter((p) => plain.has(p));
}

/** markdown 条目标题行，如 `### 23. jue.network.request [硬校验]`。 */
const HEADING_RE = /^#{2,4}\s*\d+\.\s/;

/**
 * 从文档中抽取标了 [跳过] 的 API 路径（这些是预期不提取的，不计入漏提）。
 *
 * 两条规则，缺一不可：
 * 1. **只看条目标题行**。[跳过] 的语义是「这个条目不该被提取」，正文 / 图例里的
 *    `[跳过]` 字样（如格式说明）不代表任何 API。
 * 2. **同名 API 若在别处是硬校验 / 提示条目，则不算跳过**。文档里同一路径可能同时
 *    出现在「硬校验」条目和另一个「[跳过]」条目（如 jue.network.request 既有
 *    全端版本门槛，又有并发上限的语义约束）。若按 API 名整体划入跳过，这条真 API
 *    就会在覆盖率里双向隐身：漏提不报、编造也不报。
 */
export function extractSkippedApiPaths(doc: string, sdkName = 'jue'): string[] {
  const re = new RegExp(`\\b${sdkName}\\.[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)+`, 'g');
  const skipped = new Set<string>();
  const asserted = new Set<string>();
  for (const line of doc.split('\n')) {
    if (!HEADING_RE.test(line)) continue;
    const paths = [...line.matchAll(re)].map((m) => m[0]);
    const target = line.includes('[跳过]') ? skipped : asserted;
    for (const p of paths) target.add(p);
  }
  return [...skipped].filter((p) => !asserted.has(p));
}

/** 覆盖率报告：docApiPaths / generatedTargets 为原始集合，missed / hallucinated 为差集。 */
export interface CoverageReport {
  docApiPaths: string[];
  generatedTargets: string[];
  /** 文档有、生成结果没有（已排除 [跳过] 条目，属于真漏提）。 */
  missed: string[];
  /** 生成结果有、文档没有（疑似幻觉）。 */
  hallucinated: string[];
  /** 文档中标注 [跳过] 的 API 路径（预期不提取，已从 missed 中排除）。 */
  skippedInDoc: string[];
}

/**
 * 计算文档与生成约束中语法是否完整。
 * missed 已排除 [跳过] 条目——这些是文档有意不提取的 API，不算漏提。
 */
export function computeCoverage(
  doc: string,
  constraints: Constraint[],
  sdkName = 'jue',
): CoverageReport {
  const docApiPaths = extractApiPaths(doc, sdkName);
  const skippedInDoc = extractSkippedApiPaths(doc, sdkName);
  const skippedSet = new Set(skippedInDoc);
  const generatedTargets = constraints.map((c) => c.target);
  const targetSet = new Set(generatedTargets);
  const docSet = new Set(docApiPaths);
  return {
    docApiPaths,
    generatedTargets,
    missed: docApiPaths.filter((p) => !targetSet.has(p) && !skippedSet.has(p)),
    hallucinated: generatedTargets.filter((t) => !docSet.has(t)),
    skippedInDoc,
  };
}
