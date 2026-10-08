// Skill：从文档提取跨端约束数据行（Constraint[]）
import type { LLMClient } from '../llm/client.js';
import type { Constraint } from '../types/index.js';
import { constraintArraySchema } from '../types/index.js';
import { extractPatternsPrompt } from '../llm/prompts.js';

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

/**
 * 从自然语言文档中提取可静态检测的跨端约束。
 * - 文档按 ## 章节分批送入 LLM：单章节约 10 条约束，规避一次装不下全部约束导致输出被 max_tokens 截断。
 * - LLM 输出经 chatJSON 内部做 JSON 提取 + Zod 校验。
 * - 跨批按 name 去重（保留首次出现，避免 LLM 幻觉出重复变体）。
 */
export async function extractPatterns(doc: string, llm: LLMClient): Promise<Constraint[]> {
  const chunks = splitSections(doc);
  const all: Constraint[] = [];

  for (const chunk of chunks) {
    const constraints = await llm.chatJSON(
      extractPatternsPrompt(chunk),
      constraintArraySchema,
      // 单批输出远小于 8192；过高 max_tokens 亦受 deepseek-chat 输出上限约束。
      { label: 'extract_patterns', temperature: 0.1, maxTokens: 8192 },
    );
    all.push(...constraints);
  }

  const seen = new Map<string, Constraint>();
  for (const constraint of all) {
    if (!seen.has(constraint.name)) {
      seen.set(constraint.name, constraint);
    }
  }
  return [...seen.values()];
}
