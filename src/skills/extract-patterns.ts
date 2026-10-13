// Skill：从文档提取跨端约束数据行（Constraint[]）
import type { LLMClient } from '../llm/client.js';
import type { Constraint, ConstraintConflict } from '../types/index.js';
import { constraintArraySchema } from '../types/index.js';
import { extractPatternsPrompt } from '../llm/prompts.js';
import { nameFromTarget, targetToSelector } from '../engine/selector.js';

/**
 * 按 markdown 二级标题（##）把文档切成若干章节块，供分批提取。
 * - 首个 ## 之前的「一级标题 + 引言」并入第一块，不单独成块，避免发出无约束的空请求。
 * - 无 ## 标题的文档整体作为单块；空文档返回 []。
 */
export function splitSections(doc: string): string[] {
  const text = doc.trim();
  if (!text) return [];

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let seenSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (seenSection) {
        chunks.push(current.join('\n'));
        current = [];
      }
      seenSection = true;
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  return chunks;
}

/** 提取产物：约束列表 + 同 target 但数据行冲突的条目（跨章节矛盾，需人工裁决）。 */
export interface ExtractPatternsResult {
  constraints: Constraint[];
  conflicts: ConstraintConflict[];
}

/**
 * 检测同 target 冲突：target 是约束的确定性身份，出现「同名不同据」说明文档内部
 * 存在跨章节矛盾（如 A 章说 iOS ≥ 2.10、B 章说 ≥ 2.12）——去重策略保留首次出现，
 * 但矛盾必须显式上报，不能静默吞掉。
 */
export function findConflicts(raw: Constraint[]): ConstraintConflict[] {
  const byTarget = new Map<string, Constraint[]>();
  for (const c of raw) {
    const list = byTarget.get(c.target) ?? [];
    list.push(c);
    byTarget.set(c.target, list);
  }
  const conflicts: ConstraintConflict[] = [];
  for (const [target, variants] of byTarget) {
    if (variants.length < 2) continue;
    const first = variants[0];
    const diverged = variants.some(
      (v) =>
        v.level !== first.level ||
        v.onResolveFail !== first.onResolveFail ||
        JSON.stringify(v.conditions) !== JSON.stringify(first.conditions),
    );
    if (diverged) conflicts.push({ target, variants });
  }
  return conflicts;
}

/**
 * 从自然语言文档中提取可静态检测的跨端约束。
 * - 文档按 ## 章节分批送入 LLM：单章节约 10 条约束，规避一次装不下全部约束导致输出被 max_tokens 截断。
 * - LLM 输出经 chatJSON 内部做 JSON 提取 + Zod 校验。
 * - 跨批按 target 去重（保留首次出现，避免 LLM 幻觉出重复变体）；去重同时检测同 target 冲突。
 */
export async function extractPatterns(
  doc: string,
  llm: LLMClient,
  sdkName = 'jue',
): Promise<ExtractPatternsResult> {
  const chunks = splitSections(doc);
  const all: Constraint[] = [];

  for (const chunk of chunks) {
    const raw = await llm.chatJSON(
      extractPatternsPrompt(chunk, sdkName),
      constraintArraySchema,
      // 单批输出远小于 8192；过高 max_tokens 亦受 deepseek-chat 输出上限约束。
      { label: 'extract_patterns', temperature: 0.1, maxTokens: 8192, structuredOutput: true },
    );
    // selector 与 name 均由 target 机械推导，不依赖 LLM 输出
    // （selector 杜绝 AST 层级写错；name 杜绝 kebab-case 写错导致整批作废）
    for (const c of raw) {
      all.push({
        name: nameFromTarget(c.target, sdkName),
        target: c.target,
        selector: targetToSelector(c.target, sdkName),
        message: c.message,
        conditions: c.conditions,
        level: c.level,
        onResolveFail: c.onResolveFail,
        evidence: c.evidence,
      });
    }
  }

  const seen = new Map<string, Constraint>();
  for (const constraint of all) {
    if (!seen.has(constraint.target)) {
      seen.set(constraint.target, constraint);
    }
  }
  return { constraints: [...seen.values()], conflicts: findConflicts(all) };
}
