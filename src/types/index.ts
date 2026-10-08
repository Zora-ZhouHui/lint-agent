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
  name: string; // 标识，kebab-case（消息 / 未来按名禁用）
  selector: string; // esquery AST selector，精确匹配违规节点
  message: string; // 违规时报告给开发者的提示语
  conditions: Condition[];
  level: Level; // 硬校验（error）/ 天生提醒（warn）
  onResolveFail: ResolveFail; // 解析失败时的降级（error 级别时生效）
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

// ---------- Agent 循环 ----------

// Agent 循环的上下文
export interface AgentContext {
  inputDoc: string;
  constraints: Constraint[];
  currentStep: number;
  maxSteps: number;
  history: AgentStep[];
  failures: string[];
}

// Agent 每一步的记录
export interface AgentStep {
  step: number;
  thought: string;
  action: string;
  actionInput: Record<string, unknown>;
  observation: string;
  timestamp: number;
  durationMs: number;
  tokensUsed?: number;
}

// Planner 的输出
export type PlannerAction = 'extract_patterns' | 'finish';

export interface PlannerDecision {
  thought: string;
  action: PlannerAction;
  actionInput: Record<string, unknown>;
}

/**
 * Planner 决策模式：
 * - `state`：确定性状态机，从不调用 LLM（完全可复现，适合 CI 与大批量跑）
 * - `auto` ：确定性状态机（默认）
 * - `llm`  ：每一步都问 LLM（供对比实验，token 消耗最高）
 */
export type PlannerMode = 'state' | 'auto' | 'llm';

export const PLANNER_MODES: readonly PlannerMode[] = ['state', 'auto', 'llm'];

// Reflector 的输出
export interface ReflectionResult {
  done: boolean;
  reason: string;
  shouldContinue: boolean;
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
  label?: string; // 日志标识，如 'planner'、'extract_patterns'
}

// 单次调用的 token/耗时统计
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

// ---------- 评估 ----------

// 评估结果
export interface EvalResult {
  totalConstraints: number;
  matchedExpected: number;
  accuracy: number;
  falsePositives: number;
  falsePositiveRate: number;
  falseNegatives: number;
  falseNegativeRate: number;
  avgDurationMs: number;
  totalTokens: number;
}

// 期望的规则（expected-rules.json 里的单条）
export interface ExpectedRule {
  name: string;
  target: string;
  platforms: Platform[];
}

// 期望的测试用例
export interface ExpectedTestCase {
  code: string;
  shouldReport: boolean;
  ruleName: string;
}

// expected-rules.json 的整体结构
export interface ExpectedFile {
  expectedRules: ExpectedRule[];
  testCases: ExpectedTestCase[];
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
  selector: z.string().min(1),
  message: z.string().min(1),
  conditions: z.array(conditionSchema).default([]),
  level: z.enum(['error', 'warn']).default('error'),
  onResolveFail: z.enum(['warn', 'skip']).default('warn'),
});

export const constraintArraySchema = z.array(constraintSchema);

export const engineConfigSchema = z.object({
  sdkName: z.string().min(1),
  guards: z.object({
    booleanFlags: z.record(platformSchema),
    envVar: z.string().min(1),
    envValues: z.record(platformSchema),
  }),
  order: z.array(z.string()),
});

export const plannerDecisionSchema = z.object({
  thought: z.string(),
  action: z.enum(['extract_patterns', 'finish']),
  // LLM 偶尔会省略 actionInput，给个默认值兜底
  actionInput: z.record(z.unknown()).default({}),
});

export const reflectionResultSchema = z.object({
  done: z.boolean(),
  reason: z.string(),
  // prompt 里只要求输出 done/reason，shouldContinue 由 Reflector 代码补齐
  shouldContinue: z.boolean().optional(),
});

// expected-rules.json 的整体结构校验
export const expectedFileSchema = z.object({
  expectedRules: z.array(
    z.object({
      name: z.string(),
      target: z.string(),
      platforms: z.array(platformSchema),
    }),
  ),
  testCases: z.array(
    z.object({
      code: z.string(),
      shouldReport: z.boolean(),
      ruleName: z.string(),
    }),
  ),
});
