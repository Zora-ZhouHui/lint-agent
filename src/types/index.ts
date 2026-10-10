import { z } from 'zod';

// ---------- 基础类型 ----------

/**
 * 受影响的端（唯一真相源）。
 * 收敛为 DSL 跨端的四个目标运行时：H5 / Android / iOS / 鸿蒙。
 */
export const PLATFORM_VALUES = ['h5', 'android', 'ios', 'harmony'] as const;

export type Platform = (typeof PLATFORM_VALUES)[number];

// ---------- 文档提取：跨端约束（纯数据行） ----------

/**
 * 条件（L1/L2/L3 统一载体）：
 * - `unsupported`：某端完全不可用
 * - `min_version`：某端 ≥ minVersion 才可用（SDK 目录名，见 EngineConfig.order）
 *
 * 未来新增语义条件（import/类型/作用域）只扩 Condition，不动引擎。
 */
export type Condition =
  | { kind: 'unsupported'; platform: Platform }
  | { kind: 'min_version'; platform: Platform; minVersion: string };

/**
 * 校验级别（决定「命中即如何报」）：
 * - `error`：硬规则 —— 版本/平台均解析成功且违规时报 error
 * - `warn`：天生提醒类（如废弃迁移提示）—— 命中即 warn，不做版本/平台判定
 */
export type Level = 'error' | 'warn';

/** 版本/平台解析失败时的降级策略：降级为 warn，或直接跳过（不报）。 */
export type ResolveFail = 'warn' | 'skip';

/**
 * 一条约束 = 一行数据（LLM 唯一产物，不再生成规则代码）：
 * - `conditions: []` → 无条件全禁（L1）
 * - 平台/版本数据行 → L2
 * - 语义数据行 → 未来 L3
 */
export interface Constraint {
  name: string; // 人读标识，kebab-case（展示 / 消息）
  target: string; // 确定性身份标识：SDK 挂载 API 路径，如 jue.system.getSystemInfo（去重与评估匹配键）
  selector: string; // esquery AST selector，精确匹配违规节点
  message: string; // 违规时报告给开发者的提示语
  conditions: Condition[];
  level: Level; // 硬校验（error）/ 天生提醒（warn）
  onResolveFail: ResolveFail; // 解析失败时的降级（error 级别时生效）
  /** 文档原文字句引用（支撑该约束的出处），供人工审计与 LLM-as-judge 语义校验锚定 */
  evidence: string;
}

/** 语义校验（LLM-as-judge）失败项：约束与文档原文不符的具体问题。 */
export interface SemanticFailure {
  name: string;
  target: string;
  issue: string;
}

/** 同 target 冲突：同一 API 存在多个不一致的数据行（跨章节矛盾，需人工裁决）。 */
export interface ConstraintConflict {
  target: string;
  variants: Constraint[];
}

/**
 * 文档差分失败：oracle（只看文档的独立 LLM 判定）与引擎对同一场景代码的真实 lint
 * 结果不一致。期望不来自约束自身，因此能抓「数据自洽但与文档不符」（平台/版本抄错）。
 */
export interface OracleFailure {
  name: string;
  target: string;
  /** 场景标识（对应 EngineScenario.id） */
  scenarioId: string;
  /** 场景代码（同时喂给 oracle 与引擎，保证两边判的是同一段代码） */
  code: string;
  /** oracle 依据文档给出的独立判定：error / warn / ok */
  oracle: 'error' | 'warn' | 'ok';
  /** 引擎对该场景的真实 lint 结果：error / warn / ok */
  actual: 'error' | 'warn' | 'ok';
  /** oracle 判定理由（引用文档依据） */
  oracleReason: string;
}

/** 行为校验（引擎自检）失败详情：带场景代码与期望/实际差异，供 heal prompt 回喂完整上下文。 */
export interface BehaviorFailureDetail {
  name: string;
  target: string;
  reason: string;
  /** 失败约束的原始条件 / 级别 / 降级策略（回喂给 heal prompt） */
  conditions: Condition[];
  level: Level;
  onResolveFail: ResolveFail;
  /** 不匹配的自检场景（期望来自约束数据，实际来自真实 lint） */
  mismatches: {
    scenarioId: string;
    code: string;
    expect: 'error' | 'warn' | 'ok';
    actual: 'error' | 'warn' | 'ok';
  }[];
}

/**
 * 引擎运行时配置（取代 SupportMatrix）：
 * - 校验对象是 jue SDK 挂载 API，版本按调用点从 import 路径解析，平台按运行时守卫推断，
 *   因此不再有「每端一个当前 target」，统一收敛为一份配置。
 * - `sdkName`：追踪的导入绑定名（如 'jue'）。
 * - `guards`：运行时平台守卫映射（布尔 flag + environment 字符串两类）。
 * - `order`：jue「SDK 目录名 → 序号」有序清单，越靠后越新（单一公共版本号空间）。
 */
export interface EngineConfig {
  sdkName: string;
  guards: {
    booleanFlags: Record<string, Platform>; // 布尔注入变量：{ isIOS: 'ios', isAndroid: 'android', ... }
    envVar: string; // 字符串环境变量名，如 'environment'
    envValues: Record<string, Platform>; // envVar 取值 → 端：{ ios: 'ios', android: 'android', ... }
  };
  order: string[];
}

// ---------- 提取流水线 ----------

// 提取阶段单步的可观测记录（落盘 trace 供审计）
export interface AgentStep {
  step: number;
  observation: string;
  timestamp: number;
  durationMs: number;
  tokensUsed?: number;
}

// ---------- 自纠错循环（generate → eval → self-heal） ----------

/** 单轮自纠错的执行记录。 */
export interface HealRound {
  round: number;
  observation: string;
  constraintCount: number; // 该轮结束时约束总数
  coverageMissed: string[];
  coverageHallucinated: string[];
  behaviorFailures: { name: string; reason: string }[];
  semanticFailures: SemanticFailure[]; // 语义校验失败（约束与文档原文不符）
  healedCount: number;
  durationMs: number;
  tokensUsed: number;
  /** 该轮 LLM 修正调用失败记录（不中断循环，但落盘可观测，杜绝静默吞异常） */
  llmFailures: { strategy: string; error: string }[];
}

/** 自纠错循环的最终结果。 */
export interface SelfHealResult {
  constraints: Constraint[];
  /** 初始提取时检测到的同 target 数据行冲突（保留首次出现，显式上报）。 */
  conflicts: ConstraintConflict[];
  rounds: HealRound[];
  passed: boolean;
  finalMissed: string[];
  finalHallucinated: string[];
  finalBehaviorFailures: { name: string; reason: string }[];
  finalSemanticFailures: SemanticFailure[];
  durationMs: number;
}

// ---------- LLM ----------

// LLM 客户端配置
export interface LLMConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey: string;
  baseURL?: string;
  maxRetries: number;
  timeoutMs: number;
  /**
   * 关闭兼容网关的思考模式（智谱 GLM-4.5+ 的 thinking:disabled）。
   */
  disableThinking?: boolean;
  /** 相邻请求的最小间隔（毫秒），用于规避免费档限流 */
  minIntervalMs?: number;
}

// 对话消息
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// chat() 的可选参数
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean; // 请求 JSON 输出（json mode / tool use）
  label?: string; // 日志标识，如 'extract_patterns'
  structuredOutput?: boolean; // 使用原生结构化输出（OpenAI json_schema / Anthropic tool use），不支持时自动回退
  // 内部字段：由 chatJSON 设置，外部调用方不需要
  jsonSchema?: object; // 结构化输出的 JSON Schema（doChat 用）
  schemaName?: string; // json_schema 的 name 或 Anthropic tool name
}

// 单次调用的 token/耗时统计
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

// ---------- Zod 运行时校验 ----------
// 要求：所有 Skill 的 LLM 输出必须过 Zod 校验后再进入类型世界

const platformSchema = z.enum(PLATFORM_VALUES);

export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unsupported'),
    platform: platformSchema,
  }),
  z.object({
    kind: z.literal('min_version'),
    platform: platformSchema,
    minVersion: z.string().min(1),
  }),
]);

export const constraintSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, '约束名必须是 kebab-case'),
  target: z.string().min(1),
  // selector 不再由 LLM 产出，由 targetToSelector 机械推导；保留可选以兼容历史数据
  selector: z.string().optional(),
  message: z.string().min(1),
  conditions: z.array(conditionSchema).default([]),
  level: z.enum(['error', 'warn']).default('error'),
  onResolveFail: z.enum(['warn', 'skip']).default('warn'),
  // 文档原文字句引用；default('') 兼容缺 evidence 的历史数据（如固定快照）
  evidence: z.string().default(''),
});

export const constraintArraySchema = z.array(constraintSchema);

/** LLM-as-judge 语义评审的单条判定结果。 */
export const semanticVerdictSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  issue: z.string().default(''),
});

export const semanticVerdictArraySchema = z.array(semanticVerdictSchema);

/**
 * 文档 oracle 对单个场景的独立判定：
 * - error：文档明确该版本/端下不可用，静态检查应报 error
 * - warn：文档只有废弃/迁移类提醒，应报 warn
 * - ok：文档支持，应放行
 * - unclear：文档未提及该 API 或无法判断该场景（差分跳过，不判失败）
 */
export const oracleVerdictSchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(['error', 'warn', 'ok', 'unclear']),
  reason: z.string().default(''),
});

export const oracleVerdictArraySchema = z.array(oracleVerdictSchema);

export const engineConfigSchema = z.object({
  sdkName: z.string().min(1),
  guards: z.object({
    booleanFlags: z.record(platformSchema),
    envVar: z.string().min(1),
    envValues: z.record(platformSchema),
  }),
  order: z.array(z.string()),
});
