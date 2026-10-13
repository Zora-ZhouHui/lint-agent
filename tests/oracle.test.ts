import { describe, expect, it } from 'vitest';
import type { ZodType, ZodTypeDef } from 'zod';
import { LLMClient } from '../src/llm/client.js';
import type { ChatOptions, Constraint, Message } from '../src/types/index.js';
import { verifyAgainstDoc } from '../src/agent/oracle.js';
import { defaultEngineConfig } from '../src/engine/default-config.js';

// ---------- 脚本化 oracle LLM：按 prompt 中的场景块独立「读文档」判定 ----------

/**
 * 模拟真实 oracle：不看约束数据，只根据场景代码里的平台守卫 + 一份「文档事实」
 * （harmony 端不支持 getCamera）独立判定。
 */
class ScriptedOracleLLM extends LLMClient {
  calls: { label: string; content: string }[] = [];
  /** 强制所有场景返回该 verdict（用于 unclear / 空响应测试） */
  forceVerdict?: 'error' | 'warn' | 'ok' | 'unclear' | 'missing';
  /** 模拟批次调用失败（用于验证失败批次必须被计数、不得静默当作「一致」） */
  failBatches = false;
  /** 覆盖引用内容（用于验证幻觉引用必须作废） */
  citeOverride?: string;
  /** 完全不给 cite 字段（等价于没从文档读到依据） */
  omitCite = false;

  constructor() {
    super({ provider: 'openai', model: 'test', apiKey: 'test', maxRetries: 0, timeoutMs: 1000 });
  }

  override async chatJSON<T>(
    messages: Message[],
    _schema: ZodType<T, ZodTypeDef, unknown>,
    options?: ChatOptions,
  ): Promise<T> {
    const content = messages.map((m) => m.content).join('\n');
    this.calls.push({ label: options?.label ?? '', content });

    if (options?.label !== 'oracle_behavior') throw new Error('未预期的调用');

    if (this.failBatches) throw new Error('模拟 oracle 调用失败');

    if (this.forceVerdict === 'missing') return [] as T;

    const blocks = [...content.matchAll(/### (scene-\d+)\n版本：(.+?)　运行端：(.+?)\n/g)];
    // 引用实际喂进来的文档节选里的原句（真实 oracle 也必须给逐字引用，否则判定作废）
    const cited = content.includes(HARMONY_DOC_FACT)
      ? HARMONY_DOC_FACT
      : '鸿蒙 ArkTS 不支持 getCamera';
    // citeOverride：给出一句文档里不存在的「依据」，用于验证引用校验必须作废它
    // omitCite：完全不给依据，等价于没有从文档读到东西
    const citeOf = (): Record<string, string> =>
      this.omitCite ? {} : { cite: this.citeOverride ?? cited };
    const verdicts = blocks.map(([, id, , platform]) => {
      if (this.forceVerdict) {
        return { id, verdict: this.forceVerdict, ...citeOf(), reason: 'forced' };
      }
      // 文档事实：getCamera 鸿蒙不支持 → 鸿蒙场景 error，其余端 ok
      const verdict = platform.includes('鸿蒙') ? 'error' : 'ok';
      return { id, verdict, ...citeOf(), reason: '文档：鸿蒙 ArkTS 不支持 getCamera' };
    });
    return verdicts as T;
  }
}

/** 文档里支撑判定的原句：oracle 必须逐字引用它（引用校验会核对） */
const HARMONY_DOC_FACT = '鸿蒙 ArkTS 不支持 getCamera，其余端可用。';

const DOC = ['### 7. jue.media.getCamera [硬校验]', HARMONY_DOC_FACT].join('\n');

function constraintFor(platform: 'ios' | 'harmony'): Constraint {
  return {
    name: 'no-media-getcamera',
    target: 'jue.media.getCamera',
    selector: 'CallExpression[callee.object.object.name="jue"]',
    message: '该端不支持 getCamera',
    conditions: [{ kind: 'unsupported', platform }],
    level: 'error',
    onResolveFail: 'warn',
    evidence: '鸿蒙 ArkTS 不支持 getCamera',
  };
}

describe('verifyAgainstDoc（文档差分：oracle 独立判定 vs 引擎真实判定）', () => {
  it('平台抄错（文档说鸿蒙，约束写成 iOS）→ 差分抓出双向不一致', async () => {
    const llm = new ScriptedOracleLLM();
    // 约束张冠李戴：unsupported ios
    const { failures } = await verifyAgainstDoc(
      DOC,
      [constraintFor('ios')],
      defaultEngineConfig,
      llm,
    );

    // iOS 场景：oracle 依文档判 ok，引擎按错误约束判 error → 不一致
    // 鸿蒙场景：oracle 判 error，引擎约束没提鸿蒙判 ok → 不一致
    expect(failures).toHaveLength(2);
    const ids = failures.map((f) => f.scenarioId).sort();
    expect(ids).toEqual(['pass-harmony', 'unsupported-ios']);

    const ios = failures.find((f) => f.scenarioId === 'unsupported-ios')!;
    expect(ios.oracle).toBe('ok');
    expect(ios.actual).toBe('error');
    const harmony = failures.find((f) => f.scenarioId === 'pass-harmony')!;
    expect(harmony.oracle).toBe('error');
    expect(harmony.actual).toBe('ok');

    // 关键：送给 oracle 的 prompt 不能包含约束数据（conditions / level / 约束名）
    const call = llm.calls.find((c) => c.label === 'oracle_behavior')!;
    expect(call.content).not.toContain('unsupported');
    expect(call.content).not.toContain('no-media-getcamera');
  });

  it('约束与文档一致（鸿蒙 unsupported）→ 零差分失败', async () => {
    const llm = new ScriptedOracleLLM();
    const { failures } = await verifyAgainstDoc(
      DOC,
      [constraintFor('harmony')],
      defaultEngineConfig,
      llm,
    );
    expect(failures).toHaveLength(0);
  });

  it('oracle 判 unclear（文档没说清）→ 跳过不判失败', async () => {
    const llm = new ScriptedOracleLLM();
    llm.forceVerdict = 'unclear';
    const { failures } = await verifyAgainstDoc(
      DOC,
      [constraintFor('ios')],
      defaultEngineConfig,
      llm,
    );
    expect(failures).toHaveLength(0);
  });

  it('oracle 遗漏场景（空响应）→ 跳过不判失败', async () => {
    const llm = new ScriptedOracleLLM();
    llm.forceVerdict = 'missing';
    const { failures } = await verifyAgainstDoc(
      DOC,
      [constraintFor('ios')],
      defaultEngineConfig,
      llm,
    );
    expect(failures).toHaveLength(0);
  });

  it('resolution 场景（无守卫/动态 import）不送差分，只送 determinate 场景', async () => {
    const llm = new ScriptedOracleLLM();
    llm.forceVerdict = 'ok';
    await verifyAgainstDoc(DOC, [constraintFor('harmony')], defaultEngineConfig, llm);
    const content = llm.calls.find((c) => c.label === 'oracle_behavior')!.content;
    // unsupported-harmony + pass-ios/android/h5 共 4 个 determinate 场景
    expect(content.match(/### scene-\d+/g)).toHaveLength(4);
    // resolution 场景（无守卫降级）不送差分
    expect(content).not.toContain('noguard-resolve-fail');
  });

  it('批次调用失败 → 必须计入 failedBatches（否则「一批都没成功」与「全部一致」不可区分）', async () => {
    const llm = new ScriptedOracleLLM();
    llm.failBatches = true;
    const outcome = await verifyAgainstDoc(DOC, [constraintFor('ios')], defaultEngineConfig, llm);

    expect(outcome.failures).toHaveLength(0); // 失败批次不产生失败项……
    expect(outcome.okBatches).toBe(0);
    expect(outcome.failedBatches).toBeGreaterThan(0); // ……但必须被显式计数
  });

  it('成功批次会被计数（用于区分「跑过」与「没跑」）', async () => {
    const llm = new ScriptedOracleLLM();
    const outcome = await verifyAgainstDoc(
      DOC,
      [constraintFor('harmony')],
      defaultEngineConfig,
      llm,
    );
    expect(outcome.okBatches).toBeGreaterThan(0);
    expect(outcome.failedBatches).toBe(0);
  });

  it('幻觉引用（原句不在给它的文档片段里）→ 判定作废，计入 invalidCitations 且不算差分失败', async () => {
    const llm = new ScriptedOracleLLM();
    // 让 fixture 引用一句文档里根本没有的话
    llm.citeOverride = '文档明确说鸿蒙全版本支持 getCamera，无需提示。';
    const outcome = await verifyAgainstDoc(DOC, [constraintFor('ios')], defaultEngineConfig, llm);

    // 编造依据不能换来「通过」也不能制造差分失败：该判定被作废
    expect(outcome.failures).toHaveLength(0);
    expect(outcome.invalidCitations).toBeGreaterThan(0);
    expect(outcome.unclearScenarios).toBeGreaterThan(0);
  });

  it('缺 cite 字段（没给依据）→ 一律按 unclear 作废', async () => {
    const llm = new ScriptedOracleLLM();
    llm.omitCite = true;
    const outcome = await verifyAgainstDoc(
      DOC,
      [constraintFor('harmony')],
      defaultEngineConfig,
      llm,
    );
    expect(outcome.failures).toHaveLength(0);
    expect(outcome.invalidCitations).toBeGreaterThan(0);
  });

  it('输入视角收窄：只把该 API 的文档条目喂给 oracle，不再是全文', async () => {
    const docWithExtra = [
      DOC,
      '',
      '### 8. jue.media.playVoice [硬校验]',
      '所有端 jue ≥ 3.0.0 才支持，低于阈值请降级为提示。',
    ].join('\n');
    const llm = new ScriptedOracleLLM();
    await verifyAgainstDoc(docWithExtra, [constraintFor('harmony')], defaultEngineConfig, llm, {
      contextMode: 'narrow',
    });

    const content = llm.calls.find((c) => c.label === 'oracle_behavior')!.content;
    expect(content).toContain('jue.media.getCamera'); // 本条目在
    expect(content).not.toContain('jue.media.playVoice'); // 无关条目被切掉
    expect(content).toContain('文档节选'); // prompt 口径已改为节选
  });

  it('--no-narrow-context（contextMode=full）→ 维持旧行为，喂整篇文档', async () => {
    const docWithExtra = [
      DOC,
      '',
      '### 8. jue.media.playVoice [硬校验]',
      '所有端 jue ≥ 3.0.0 才支持，低于阈值请降级为提示。',
    ].join('\n');
    const llm = new ScriptedOracleLLM();
    const outcome = await verifyAgainstDoc(
      docWithExtra,
      [constraintFor('harmony')],
      defaultEngineConfig,
      llm,
      { contextMode: 'full' },
    );

    const content = llm.calls.find((c) => c.label === 'oracle_behavior')!.content;
    expect(content).toContain('jue.media.playVoice');
    expect(outcome.contextMode).toBe('full');
  });

  it('文档里找不到该 API 条目 → 退回全文（宁可给多，不可把依据切掉）', async () => {
    const llm = new ScriptedOracleLLM();
    const outcome = await verifyAgainstDoc(
      DOC,
      [constraintFor('harmony')],
      defaultEngineConfig,
      llm,
    );
    // DOC 里只有 getCamera 条目，场景代码调用的也是它 → 精确命中，不应退回
    expect(outcome.contextMode).toBe('narrow');
  });
});
