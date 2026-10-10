import { describe, expect, it } from 'vitest';
import type { ZodType, ZodTypeDef } from 'zod';
import { LLMClient } from '../src/llm/client.js';
import type { ChatOptions, Constraint, Message } from '../src/types/index.js';
import { extractWithSelfHeal } from '../src/agent/self-heal.js';
import { Tracer } from '../src/agent/trace.js';
import { jueGetSystemInfoConstraint, makeEngineConfig } from './helpers.js';

// ---------- 脚本化 LLM：按 label 分发预设结果，judge 默认全过 ----------

class ScriptedHealLLM extends LLMClient {
  extractResult: Constraint[] = [];
  healMissedResult: Constraint[] = [];
  healSemanticsResult: Constraint[] = [];
  healBehaviorResult: Constraint[] = [];
  /** 按序弹出的 judge 失败判定；空队列时全部判 ok */
  judgeFailQueue: { name: string; issue: string }[] = [];
  calls: { label: string; content: string }[] = [];

  constructor() {
    super({ provider: 'openai', model: 'test', apiKey: 'test', maxRetries: 0, timeoutMs: 1000 });
  }

  override async chatJSON<T>(
    messages: Message[],
    _schema: ZodType<T, ZodTypeDef, unknown>,
    options?: ChatOptions,
  ): Promise<T> {
    const label = options?.label ?? '';
    const content = messages.map((m) => m.content).join('\n');
    this.calls.push({ label, content });

    switch (label) {
      case 'extract_patterns':
        return this.extractResult as T;
      case 'heal_missed':
        return this.healMissedResult as T;
      case 'heal_semantics':
        return this.healSemanticsResult as T;
      case 'heal_behavior':
        return this.healBehaviorResult as T;
      case 'judge_semantics': {
        const fail = this.judgeFailQueue.shift();
        const names = [...content.matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]);
        const verdicts = [...new Set(names)].map((name) => {
          const hit = fail && name === fail.name;
          return { name, ok: !hit, issue: hit ? fail.issue : '' };
        });
        return verdicts as T;
      }
      default:
        throw new Error(`未预期的 chatJSON 调用：${label}`);
    }
  }
}

// ---------- 夹具 ----------

// 只含一个 API：用于提取结果恰好覆盖全部 API 的场景
const DOC_SINGLE = [
  '### 1. jue.system.getSystemInfo [硬校验]',
  'iOS 需 jue ≥ 2.25.0，Android 需 jue ≥ 2.10.0。',
].join('\n');

// 含两个 API：用于漏提场景
const DOC = [
  DOC_SINGLE,
  '',
  '### 14. jue.device.getModel [硬校验]',
  '所有端 jue ≥ 2.0.0 才支持。',
].join('\n');

const getModelConstraint: Constraint = {
  name: 'no-device-getmodel',
  target: 'jue.device.getModel',
  selector:
    'CallExpression[callee.object.object.name="jue"][callee.object.property.name="device"][callee.property.name="getModel"]',
  message: '所有端需 jue ≥ 2.0.0',
  conditions: [],
  level: 'error',
  onResolveFail: 'warn',
  evidence: '所有端 jue ≥ 2.0.0 才支持。',
};

function tracer(): Tracer {
  return new Tracer('/tmp/lint-agent-self-heal-trace.jsonl');
}

describe('extractWithSelfHeal（自纠错闭环）', () => {
  it('一次提取全部通过 → 1 轮收敛', async () => {
    const llm = new ScriptedHealLLM();
    llm.extractResult = [jueGetSystemInfoConstraint];

    const result = await extractWithSelfHeal(DOC_SINGLE, llm, makeEngineConfig(), {
      tracer: tracer(),
    });

    expect(result.passed).toBe(true);
    expect(result.constraints).toHaveLength(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.finalSemanticFailures).toHaveLength(0);
  }, 30000);

  it('幻觉约束自动移除（无需 LLM）→ 2 轮收敛', async () => {
    const hallucinated: Constraint = {
      ...jueGetSystemInfoConstraint,
      name: 'no-device-fakeapi',
      target: 'jue.device.fakeApi',
    };
    const llm = new ScriptedHealLLM();
    llm.extractResult = [jueGetSystemInfoConstraint, hallucinated];

    const result = await extractWithSelfHeal(DOC_SINGLE, llm, makeEngineConfig(), {
      tracer: tracer(),
    });

    expect(result.passed).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(result.constraints.map((c) => c.target)).toEqual(['jue.system.getSystemInfo']);
    expect(result.rounds[0].coverageHallucinated).toContain('jue.device.fakeApi');
  }, 30000);

  it('漏提补提取 + 语义失败修正 → 2 轮收敛，heal prompt 带评审意见与文档', async () => {
    const llm = new ScriptedHealLLM();
    llm.extractResult = [jueGetSystemInfoConstraint]; // 漏提 getModel
    llm.healMissedResult = [getModelConstraint];
    llm.judgeFailQueue = [
      {
        name: 'no-system-getsysteminfo',
        issue: 'minVersion 与文档不符：文档说 2.25.0，约束写 2.12.0',
      },
    ];
    llm.healSemanticsResult = [
      { ...jueGetSystemInfoConstraint, evidence: '修正后逐字引用：iOS 需 jue ≥ 2.25.0' },
    ];

    const result = await extractWithSelfHeal(DOC, llm, makeEngineConfig(), { tracer: tracer() });

    expect(result.passed).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(result.constraints).toHaveLength(2);
    // 漏提 1 + 语义修正 1（healedCount 只计真实变更）
    expect(result.rounds[0].healedCount).toBe(2);
    // 修正后的 evidence 被应用
    const fixed = result.constraints.find((c) => c.target === 'jue.system.getSystemInfo');
    expect(fixed?.evidence).toContain('修正后逐字引用');
    // P0：heal_semantics prompt 必须带评审意见 + 文档原文（信息闭环完整）
    const healCall = llm.calls.find((c) => c.label === 'heal_semantics');
    expect(healCall?.content).toContain('minVersion 与文档不符');
    expect(healCall?.content).toContain('文档内容');
  }, 30000);

  it('行为失败修正：heal prompt 带不匹配场景代码与文档，修正后收敛', async () => {
    // 引擎配置版本序为空 → 阈值场景 2.25.0 无法在清单中定位，compare 保守判违规，
    // 「阈值版本应放行」场景期望 ok 实际 error → 引擎自检失败。
    // 修正为 warn 级后只剩 warn-any 场景（命中即 warn），自检通过。
    const configEmptyOrder = makeEngineConfig({ order: [] });
    const llm = new ScriptedHealLLM();
    llm.extractResult = [jueGetSystemInfoConstraint];
    llm.healBehaviorResult = [{ ...jueGetSystemInfoConstraint, level: 'warn' }];

    const result = await extractWithSelfHeal(DOC_SINGLE, llm, configEmptyOrder, {
      tracer: tracer(),
    });

    expect(result.passed).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].behaviorFailures).toHaveLength(1);
    expect(result.rounds[0].healedCount).toBe(1);
    // heal_behavior prompt 必须带不匹配场景代码 + 期望/实际差异 + 文档
    const healCall = llm.calls.find((c) => c.label === 'heal_behavior');
    expect(healCall?.content).toContain('场景');
    expect(healCall?.content).toContain('import jue from');
    expect(healCall?.content).toContain('期望 ok');
    expect(healCall?.content).toContain('实际 error');
    expect(healCall?.content).toContain('文档内容');
  }, 30000);

  it('同 target 数据行冲突 → 结果透传 conflicts', async () => {
    const variant: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'unsupported', platform: 'ios' }],
    };
    const llm = new ScriptedHealLLM();
    llm.extractResult = [jueGetSystemInfoConstraint, variant];

    const result = await extractWithSelfHeal(DOC, llm, makeEngineConfig(), { tracer: tracer() });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].target).toBe('jue.system.getSystemInfo');
    expect(result.conflicts[0].variants).toHaveLength(2);
  }, 30000);
});
