// 确定性提取：文档 → Constraint[]。全程只有 extractPatterns 一次 LLM 调用，
// 没有 planner / reflector / 状态机循环——提取完成即结束。失败不中断，落盘 trace 后带 error 交回上层。
import type { LLMClient } from '../llm/client.js';
import type { AgentStep, Constraint, ConstraintConflict } from '../types/index.js';
import { extractPatterns } from '../skills/extract-patterns.js';
import { Tracer } from './trace.js';

export interface ExtractionOptions {
  /** 追踪的导入绑定名（如 'jue'），决定提取 selector 的根标识。 */
  sdkName?: string;
  tracer?: Tracer;
}

export interface ExtractionResult {
  constraints: Constraint[];
  /** 同 target 但数据行冲突（跨章节矛盾），保留首次出现的同时显式上报。 */
  conflicts: ConstraintConflict[];
  /** 提取失败原因；成功为 undefined。 */
  error?: string;
  durationMs: number;
}

export async function extractConstraints(
  doc: string,
  llm: LLMClient,
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const sdkName = options.sdkName ?? 'jue';
  const tracer = options.tracer ?? new Tracer();
  const started = Date.now();
  const tokensBefore = llm.getTotalTokens();

  let constraints: Constraint[] = [];
  let conflicts: ConstraintConflict[] = [];
  let error: string | undefined;
  let observation: string;

  try {
    const result = await extractPatterns(doc, llm, sdkName);
    constraints = result.constraints;
    conflicts = result.conflicts;
    const conflictNote = conflicts.length > 0 ? `，⚠ ${conflicts.length} 组同 target 冲突` : '';
    observation = constraints.length
      ? `提取到 ${constraints.length} 条约束${conflictNote}`
      : '文档中没有可静态检测的跨端约束';
    for (const conflict of conflicts) {
      observation += `\n  ⚠ 冲突 ${conflict.target}：${conflict.variants.length} 个数据行不一致（保留首次出现）`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    observation = `提取失败：${error.slice(0, 300)}`;
  }

  const step: AgentStep = {
    step: 1,
    observation,
    timestamp: Date.now(),
    durationMs: Date.now() - started,
    tokensUsed: llm.getTotalTokens() - tokensBefore,
  };
  tracer.append(step);
  tracer.save();
  tracer.printStep(step);

  return { constraints, conflicts, error, durationMs: Date.now() - started };
}
