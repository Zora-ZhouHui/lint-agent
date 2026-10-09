// 覆盖率引擎：不依赖任何手写 JSON 基线，直接从文档抽取 SDK 挂载 API 路径，
// 与生成约束的 target 做差集，报告「漏提」与「幻觉」两类提取缺口。
//
// 它是覆盖率信号（辅助人工 triage），不是绝对对错判定——文档里被标注 [跳过] 的条目也会被算进
// 「文档有、结果无」，需人工确认后归入 known-gaps。
import type { Constraint } from '../types/index.js';

/**
 * 从 markdown 文档抽取 SDK 挂载 API 全路径（如 jue.system.getSystemInfo）。
 * 要求 jue 后至少还有两级段（模块.方法），从而不会把仅提「模块名」的 [跳过] 条目
 * （如 jue.storage）或「jue SDK」这类自然语言误当成 API 全路径。
 */
export function extractApiPaths(doc: string, sdkName = 'jue'): string[] {
  const re = new RegExp(`\\b${sdkName}\\.[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)+`, 'g');
  const seen = new Set<string>();
  for (const m of doc.matchAll(re)) seen.add(m[0]);
  return [...seen];
}

/** 覆盖率报告：docApiPaths / generatedTargets 为原始集合，missed / hallucinated 为差集。 */
export interface CoverageReport {
  docApiPaths: string[];
  generatedTargets: string[];
  /** 文档有、生成结果没有（含 [跳过] 条目，需人工确认）。 */
  missed: string[];
  /** 生成结果有、文档没有（疑似幻觉）。 */
  hallucinated: string[];
}

export function computeCoverage(
  doc: string,
  constraints: Constraint[],
  sdkName = 'jue',
): CoverageReport {
  const docApiPaths = extractApiPaths(doc, sdkName);
  const generatedTargets = constraints.map((c) => c.target);
  const targetSet = new Set(generatedTargets);
  const docSet = new Set(docApiPaths);
  return {
    docApiPaths,
    generatedTargets,
    missed: docApiPaths.filter((p) => !targetSet.has(p)),
    hallucinated: generatedTargets.filter((t) => !docSet.has(t)),
  };
}
