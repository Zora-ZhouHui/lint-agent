import { describe, expect, it } from 'vitest';
import type { ZodType, ZodTypeDef } from 'zod';
import { LLMClient } from '../src/llm/client.js';
import type { ChatOptions, Constraint, Message } from '../src/types/index.js';
import { extractWithSelfHeal } from '../src/agent/self-heal.js';
import { constraintArraySchema } from '../src/types/index.js';
import { Tracer } from '../src/agent/trace.js';
import { jueGetSystemInfoConstraint, makeEngineConfig } from './helpers.js';

// ---------- 脚本化 LLM：按 label 分发预设结果，judge 默认全过 ----------

class ScriptedHealLLM extends LLMClient {
  extractResult: Constraint[] = [];
  healMissedResult: Constraint[] = [];
  healSemanticsResult: Constraint[] = [];
  healBehaviorResult: Constraint[] = [];
  healVersionsResult: Constraint[] = [];
  /** 按序弹出的 judge 失败判定；空队列时全部判 ok */
  judgeFailQueue: { name: string; issue: string }[] = [];
  calls: { label: string; content: string }[] = [];
  /** 这些 heal_* label 的调用一律抛错（模拟整批+逐条都失败的系统性故障） */
  failHealLabels = new Set<string>();
  /** 用真实 schema 校验返回结果：让「坏数据」真的被判不合法，而不是靠手写抛错 */
  strictSchema?: import('zod').ZodType<unknown, import('zod').ZodTypeDef, unknown>;

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

    if (this.failHealLabels.has(label)) throw new Error(`模拟 ${label} 调用失败`);

    switch (label) {
      case 'extract_patterns':
        return this.extractResult as T;
      case 'heal_missed': {
        // 模拟真实失效：模型把某条的 `name` 填成了 API 路径（违反 kebab-case），
        // 坏数据混在整批里 → 整批 Zod 校验失败。
        //
        // 判定依据用**批大小**（prompt 里列了几条遗漏 API），不用字符串匹配：
        // API 路径本来就出现在 prompt 中，拿它当标记会让单条探测也误判，
        // 于是「逐条降级」永远救不回任何东西（这正是先前踩过的坑）。
        const batchSize = [...content.matchAll(/^- (\S+)$/gm)].length;
        const isBatch = batchSize > 1;
        if (this.strictSchema && isBatch) {
          throw new Error('整批 Zod 校验失败：一条 name 未按 kebab-case');
        }
        // 逐条重试时模型重新生成就正常了 —— 真实场景里这正是降级的意义
        const picked = this.strictSchema
          ? this.healMissedResult.map((c) =>
              isBatch ? c : { ...c, name: c.target.replace(/\./g, '-').toLowerCase() },
            )
          : this.healMissedResult;
        this.strictSchema?.parse(picked);
        return picked as T;
      }
      case 'heal_semantics':
        return this.healSemanticsResult as T;
      case 'heal_behavior':
        return this.healBehaviorResult as T;
      case 'heal_versions':
        return this.healVersionsResult as T;
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

// 两份文档 + 两条约束：用于「一个坏条目不得拖垮整批」的集成测试
const DOC_TWO = [
  DOC_SINGLE,
  '',
  '### 2. jue.device.getModel [硬校验]',
  '所有端 jue ≥ 2.0.0 才支持。',
].join('\n');

const getModelConstraintTwo: Constraint = {
  name: 'no-device-getmodel',
  target: 'jue.device.getModel',
  selector:
    'CallExpression[callee.object.object.name="jue"][callee.object.property.name="device"][callee.property.name="getModel"]',
  message: '所有端需 jue ≥ 2.0.0',
  conditions: [{ kind: 'min_version', platform: 'ios', minVersion: '2.0.0' }],
  level: 'error',
  onResolveFail: 'warn',
  evidence: '所有端 jue ≥ 2.0.0 才支持。',
};

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

    // 空 order 会同时暴露两个**互相独立**的信号，二者都必须保留：
    //   - 引擎自检失败：约束在清单里定位不到版本，「阈值版本应放行」实际被拦；
    //   - 版本清单缺项：归因信息（该约束在已知版本空间内未被正向验证）。
    // 若按 target 把自检失败过滤掉，一条真正的 selector 缺陷就会被版本问题掩盖。
    expect(result.passed).toBe(false);
    expect(result.rounds[0].behaviorFailures).toHaveLength(1);
    expect(result.rounds[0].unverifiedMinVersions.length).toBeGreaterThan(0);
    // 行为修正确实被触发并生效（第 2 轮起行为失败消失）
    expect(result.rounds[1].behaviorFailures).toHaveLength(0);
    expect(result.rounds[0].healedCount).toBe(1);
    // heal_behavior prompt 必须带不匹配场景代码 + 期望/实际差异 + 文档
    const healCall = llm.calls.find((c) => c.label === 'heal_behavior');
    expect(healCall?.content).toContain('场景');
    expect(healCall?.content).toContain('import jue from');
    expect(healCall?.content).toContain('期望 ok');
    expect(healCall?.content).toContain('实际 error');
    expect(healCall?.content).toContain('文档内容');
  }, 30000);

  it('minVersion 抄成清单外的版本号 → 被归因捕获，heal_versions 带合法清单修正后收敛', async () => {
    // 真实失效模式：文档写 2.25.0，LLM 凭空抄出一个不存在的 2.26.0。
    // 这个版本号既不在文档里、也不在 order 清单里 —— 文档级不可达，只有抄错才出现，
    // 因此必须用脚本化 LLM 精确模拟，而不能指望真实运行撞上。
    const typo: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'min_version', platform: 'ios', minVersion: '2.26.0' }],
    };
    const corrected: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'min_version', platform: 'ios', minVersion: '2.25.0' }],
    };

    const llm = new ScriptedHealLLM();
    llm.extractResult = [typo];
    llm.healVersionsResult = [corrected];
    llm.healBehaviorResult = [corrected]; // 清单外版本同时会让自检失败，一并修正

    const result = await extractWithSelfHeal(DOC_SINGLE, llm, makeEngineConfig(), {
      tracer: tracer(),
    });

    // 归因检查捕获到了清单外版本，且明确指出是哪条、哪端、哪个版本
    expect(result.rounds[0].unverifiedMinVersions).toEqual([
      {
        name: jueGetSystemInfoConstraint.name,
        target: jueGetSystemInfoConstraint.target,
        platform: 'ios',
        minVersion: '2.26.0',
      },
    ]);

    // heal_versions prompt 必须带上合法版本清单，并明确禁止为迎合清单而篡改版本号
    const healVersions = llm.calls.find((c) => c.label === 'heal_versions');
    expect(healVersions).toBeDefined();
    expect(healVersions?.content).toContain('2.25.0 < 2.28.0'); // 清单片段
    expect(healVersions?.content).toContain('不要为了迎合清单而篡改版本号');
    expect(healVersions?.content).toContain('文档内容');

    // 修正后：清单缺项清零，闭环收敛
    expect(result.passed).toBe(true);
    expect(result.rounds[1].unverifiedMinVersions).toHaveLength(0);
    expect(result.constraints[0].conditions).toEqual([
      { kind: 'min_version', platform: 'ios', minVersion: '2.25.0' },
    ]);
  }, 30000);

  it('文档原文确实写了清单外版本 → heal_versions 原样返回也算合规（不许篡改版本号）', async () => {
    // 与上一个用例的区别：这里数据是「对」的，缺的是 engine-config 的 order 清单。
    // 纠正方向应是补配置，而不是改数据 —— 因此 LLM 原样返回时不能算作修正，
    // 闭环应当如实报「仍有残留」，把问题交给人工补 order。
    const asIs: Constraint = {
      ...jueGetSystemInfoConstraint,
      conditions: [{ kind: 'min_version', platform: 'ios', minVersion: '2.26.0' }],
    };
    const llm = new ScriptedHealLLM();
    llm.extractResult = [asIs];
    llm.healVersionsResult = [asIs]; // 原样返回
    llm.healBehaviorResult = [asIs];

    const result = await extractWithSelfHeal(DOC_SINGLE, llm, makeEngineConfig(), {
      tracer: tracer(),
    });

    expect(result.passed).toBe(false);
    expect(result.finalMissed).toHaveLength(0);
    // 归因信息如实保留，未被「修成」一个好看的清单内版本
    expect(result.constraints[0].conditions).toEqual([
      { kind: 'min_version', platform: 'ios', minVersion: '2.26.0' },
    ]);
  }, 30000);

  it('批次级降级：一个 name 不合法的坏条目不得让整批修正作废（实测缺陷的回归）', async () => {
    // 精确复现真实失效：整批 heal_missed 里混入一条 `name` 被填成 API 路径的数据，
    // 违反 kebab-case 的 Zod 校验 → 原先整批 2 条漏提全部修不回来。
    const llm = new ScriptedHealLLM();
    llm.extractResult = []; // 两条都靠自纠错补提取，批里才有「好 + 坏」
    llm.healMissedResult = [jueGetSystemInfoConstraint, getModelConstraintTwo];
    llm.strictSchema = constraintArraySchema; // 用真实 schema 校验，让坏 name 真的被判不合法

    const result = await extractWithSelfHeal(DOC_TWO, llm, makeEngineConfig(), {
      tracer: tracer(),
    });

    // 好数据被救回来了：整批失败 → 逐条重试后仍拿到那条合法约束
    const healCalls = llm.calls.filter((c) => c.label === 'heal_missed');
    expect(healCalls.length).toBeGreaterThan(1); // 确实发生了逐条降级
    expect(result.finalMissed).toHaveLength(0);
    expect(result.constraints.map((c) => c.target).sort()).toEqual([
      'jue.device.getModel',
      'jue.system.getSystemInfo',
    ]);

    // 降级情况必须可观测（否则成本上升被隐藏）
    const fallbackNotes = result.rounds[0].llmFailures.filter((f) =>
      f.strategy.includes('batch_fallback'),
    );
    expect(fallbackNotes).toHaveLength(1);
    expect(fallbackNotes[0].error).toContain('逐条重试');
  }, 30000);

  it('系统性故障（逐条也失败）→ 放弃降级，计入 LLM 失败且如实报残留', async () => {
    const llm = new ScriptedHealLLM();
    llm.extractResult = [jueGetSystemInfoConstraint];
    llm.failHealLabels.add('heal_missed'); // 整批与逐条全部失败（系统性故障）

    const result = await extractWithSelfHeal(DOC_TWO, llm, makeEngineConfig(), {
      tracer: tracer(),
    });

    expect(result.passed).toBe(false);
    // 真实漏提如实报出，绝不被「修过了」掩盖
    expect(result.finalMissed).toEqual(['jue.device.getModel']);
    const notes = result.rounds[0].llmFailures.filter((f) => f.strategy.includes('batch_fallback'));
    expect(notes[0].error).toContain('系统性故障');
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
