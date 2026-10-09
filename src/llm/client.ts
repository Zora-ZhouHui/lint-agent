// LLM 客户端：封装 OpenAI / Anthropic 双 provider，通过 LLMConfig.provider 切换
// - chat()：普通文本对话
// - chatJSON()：结构化输出，内部做 JSON 提取 + Zod 校验 + 格式修复重试
// - 重试采用指数退避，只对可重试错误（429/5xx/网络超时）生效
// - 每次调用记录日志（prompt/response/tokens/duration）到 output/logs/llm-calls.jsonl
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions/completions.js';
import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { type ZodType, type ZodTypeDef } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChatOptions, LLMConfig, LLMUsage, Message } from '../types/index.js';
import { ensureDir } from '../utils/file.js';

const LOG_DIR = path.resolve('output/logs');
const LOG_FILE = path.join(LOG_DIR, 'llm-calls.jsonl');
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

/** 从环境变量构造 LLMConfig：LLM_PROVIDER / LLM_MODEL / LLM_API_KEY / LLM_BASE_URL */
export function loadLLMConfigFromEnv(): LLMConfig {
  const provider = (process.env.LLM_PROVIDER ?? 'openai') as LLMConfig['provider'];
  const apiKey =
    process.env.LLM_API_KEY ??
    (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error(
      '缺少 LLM API Key：请设置 LLM_API_KEY（或 OPENAI_API_KEY / ANTHROPIC_API_KEY）',
    );
  }
  return {
    provider,
    model: process.env.LLM_MODEL ?? (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o'),
    apiKey,
    baseURL: process.env.LLM_BASE_URL || undefined,
    maxRetries: 3, // LLM 调用失败重试 3 次
    timeoutMs: 180000,
    // 关闭思考模式（仅对支持该参数的兼容网关生效，如智谱 GLM-4.5+）
    disableThinking: process.env.LLM_DISABLE_THINKING === '1',
    // 请求最小间隔（毫秒），用于规避免费档限流，默认不节流
    minIntervalMs: Number(process.env.LLM_MIN_INTERVAL_MS ?? 0),
  };
}

interface LogEntry {
  timestamp: string;
  label: string;
  provider: string;
  model: string;
  prompt: Message[];
  response: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 从 LLM 输出中提取 JSON：
 * 1. 剥掉 ```json ... ``` 代码块标记
 * 2. 直接 JSON.parse 失败时，截取第一个 { 或 [ 到最后一个 } 或 ]
 */
export function extractJSON(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) t = fence[1].trim();

  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[{[]/);
    if (start === -1) throw new SyntaxError('输出中找不到 JSON');
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    return JSON.parse(t.slice(start, end + 1));
  }
}

export class LLMClient {
  private openai?: OpenAI;
  private anthropic?: Anthropic;
  // 每次调用的用量记录，供上层（提取流水线）读取并写入 trace
  private usages: LLMUsage[] = [];
  // 节流：上一次请求发出的时间戳（0 = 还没发过）
  private lastRequestAt = 0;

  constructor(private config: LLMConfig) {
    if (config.provider === 'openai') {
      this.openai = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        // 禁用 SDK 内置重试，统一走自己的指数退避，避免双重重试
        maxRetries: 0,
      });
    } else {
      this.anthropic = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: 0,
      });
    }
  }

  /** 普通对话，返回文本 */
  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    return this.withRetry(() => this.doChat(messages, options), options.label ?? 'chat');
  }

  /**
   * 结构化对话：提取 JSON → Zod 校验。
   * - structuredOutput: true 时优先使用原生结构化输出（OpenAI json_schema / Anthropic tool use），
   *   API 不支持时自动回退到 json_object 模式。
   * - 校验失败时把错误回传给 LLM 要求修正（格式修复循环），总尝试次数 = maxRetries + 1。
   */
  async chatJSON<T>(
    messages: Message[],
    schema: ZodType<T, ZodTypeDef, unknown>,
    options: ChatOptions = {},
  ): Promise<T> {
    const convo = [...messages];
    const maxAttempts = this.config.maxRetries + 1;
    let lastError: unknown;

    // 准备结构化输出：Zod → JSON Schema，包裹在 { data: ... } 对象中
    // （OpenAI json_schema 和 Anthropic tool use 均要求顶层为 object）
    let jsonSchema: object | undefined;
    const schemaName = options.label ?? 'output';
    if (options.structuredOutput) {
      try {
        const rawSchema = zodToJsonSchema(schema) as Record<string, unknown>;
        delete rawSchema.$schema;
        jsonSchema = {
          type: 'object',
          properties: { data: rawSchema },
          required: ['data'],
          additionalProperties: false,
        };
      } catch {
        // schema 转换失败 → 静默回退到 json_object 模式
      }
    }
    let structuredFailed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const useStructured = jsonSchema !== undefined && !structuredFailed;
      let text: string;
      try {
        text = await this.chat(convo, {
          ...options,
          jsonMode: true,
          jsonSchema: useStructured ? jsonSchema : undefined,
          schemaName: useStructured ? schemaName : undefined,
        });
      } catch (err) {
        // 结构化输出不被 API 支持 → 回退到 json_object，不消耗本次 attempt
        if (useStructured && this.isStructuredNotSupported(err)) {
          structuredFailed = true;
          continue;
        }
        throw err;
      }

      try {
        let parsed = extractJSON(text);
        // 结构化输出的响应包裹在 { data: ... } 里，需要解包
        if (useStructured && parsed !== null && typeof parsed === 'object' && 'data' in parsed) {
          parsed = (parsed as { data: unknown }).data;
        }
        return schema.parse(parsed);
      } catch (err) {
        lastError = err;
        const reason = errMessage(err).slice(0, 500);
        convo.push({ role: 'assistant', content: text });
        convo.push({
          role: 'user',
          content:
            `你的输出不是合法 JSON 或不符合 schema：${reason}\n` +
            '请只输出符合要求的 JSON，不要包含任何其他文字或 markdown 标记。',
        });
      }
    }
    throw new Error(
      `chatJSON 在 ${maxAttempts} 次尝试后仍未得到合法输出（label=${options.label ?? 'chat'}）：` +
        errMessage(lastError),
    );
  }

  /** 累计 token 消耗（供 eval 统计） */
  getTotalTokens(): number {
    return this.usages.reduce((sum, u) => sum + u.totalTokens, 0);
  }

  // ---------- 内部实现 ----------

  private async doChat(messages: Message[], options: ChatOptions): Promise<string> {
    // 节流：保证相邻请求至少间隔 minIntervalMs（放在 doChat 内，重试不额外等待）
    if (this.config.minIntervalMs && this.lastRequestAt > 0) {
      const wait = this.config.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    this.lastRequestAt = Date.now();

    const started = Date.now();
    let response = '';
    let promptTokens = 0;
    let completionTokens = 0;

    if (this.openai) {
      // 优先使用 json_schema 结构化输出，回退到 json_object
      const responseFormat = options.jsonSchema
        ? {
            type: 'json_schema' as const,
            json_schema: {
              name: options.schemaName ?? 'output',
              schema: options.jsonSchema,
              strict: false,
            },
          }
        : options.jsonMode
          ? { type: 'json_object' as const }
          : undefined;
      // thinking 是非标准参数（智谱等兼容网关支持），混入 body 后整体断言
      const params = {
        model: this.config.model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        response_format: responseFormat,
        ...(this.config.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      } as unknown as ChatCompletionCreateParamsNonStreaming;
      const res = await this.openai.chat.completions.create(params, {
        timeout: this.config.timeoutMs,
      });
      response = res.choices[0]?.message?.content ?? '';
      promptTokens = res.usage?.prompt_tokens ?? 0;
      completionTokens = res.usage?.completion_tokens ?? 0;
    } else if (this.anthropic) {
      // Anthropic 要求 system 单独传、max_tokens 必填
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const rest = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      if (options.jsonSchema) {
        // Anthropic: 用 tool use 实现结构化输出
        const tool = {
          name: options.schemaName ?? 'output',
          description: '输出结构化数据',
          input_schema: options.jsonSchema as { type: 'object' } & Record<string, unknown>,
        };
        const res = await this.anthropic.messages.create(
          {
            model: this.config.model,
            max_tokens: options.maxTokens ?? 4096,
            system: system || undefined,
            messages: rest,
            temperature: options.temperature,
            tools: [tool],
            tool_choice: { type: 'tool', name: tool.name },
          },
          { timeout: this.config.timeoutMs },
        );
        for (const block of res.content) {
          if (block.type === 'tool_use') {
            response = JSON.stringify(block.input);
            break;
          }
        }
        promptTokens = res.usage.input_tokens;
        completionTokens = res.usage.output_tokens;
      } else {
        const res = await this.anthropic.messages.create(
          {
            model: this.config.model,
            max_tokens: options.maxTokens ?? 4096,
            system: system || undefined,
            messages: rest,
            temperature: options.temperature,
          },
          { timeout: this.config.timeoutMs },
        );
        for (const block of res.content) {
          if (block.type === 'text') response += block.text;
        }
        promptTokens = res.usage.input_tokens;
        completionTokens = res.usage.output_tokens;
      }
    }

    const durationMs = Date.now() - started;
    const usage: LLMUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      durationMs,
    };
    this.usages.push(usage);
    this.logCall(options.label ?? 'chat', messages, response, usage);
    return response;
  }

  /** 指数退避重试，只重试可重试错误；429 限流单独处理（更慢起步 + retry-after） */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= this.config.maxRetries || !this.isRetryable(err)) break;
        const delay = this.backoffDelay(err, attempt);
        console.warn(
          chalk.yellow(
            `  ⚠ [${label}] LLM 调用失败（第 ${attempt + 1} 次），` +
              `${Math.round(delay / 1000)}s 后重试：${errMessage(err).slice(0, 120)}`,
          ),
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  private backoffDelay(err: unknown, attempt: number): number {
    const e = err as {
      status?: number;
      response?: { headers?: { get?: (k: string) => string | null } };
    };
    // 优先尊重服务端的 retry-after（秒）
    const retryAfter = Number(e?.response?.headers?.get?.('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1000, 60000) + Math.random() * 300;
    }
    // 429 限流窗口通常按秒/分钟计，用 5s 起步；其他错误 1s 起步
    const base = e?.status === 429 ? 5000 : BASE_DELAY_MS;
    const cap = e?.status === 429 ? 30000 : MAX_DELAY_MS;
    return Math.min(base * 2 ** attempt, cap) + Math.random() * 300;
  }

  private isRetryable(err: unknown): boolean {
    const e = err as { status?: number; code?: string; name?: string };
    if (typeof e?.status === 'number') {
      return e.status === 429 || e.status >= 500;
    }
    if (e?.code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(e.code)) {
      return true;
    }
    if (e?.name && ['APIConnectionError', 'APIConnectionTimeoutError'].includes(e.name)) {
      return true;
    }
    return false;
  }

  /** 检测 API 是否不支持 json_schema 结构化输出（用于自动回退到 json_object） */
  private isStructuredNotSupported(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    if (e?.status === 400 || e?.status === 422) {
      const msg = e?.message ?? '';
      return (
        msg.includes('json_schema') ||
        msg.includes('response_format') ||
        msg.includes('responseFormat') ||
        msg.toLowerCase().includes('unsupported')
      );
    }
    return false;
  }

  private logCall(label: string, prompt: Message[], response: string, usage: LLMUsage): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      label,
      provider: this.config.provider,
      model: this.config.model,
      prompt,
      response,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      durationMs: usage.durationMs,
    };
    // 日志写失败不影响主流程
    try {
      ensureDir(LOG_DIR);
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    } catch {
      /* ignore */
    }
    console.log(
      chalk.dim(
        `  ⚡ [${label}] ${usage.totalTokens} tokens · ${(usage.durationMs / 1000).toFixed(1)}s`,
      ),
    );
  }
}
