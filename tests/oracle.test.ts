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

    if (this.forceVerdict === 'missing') return [] as T;

    const blocks = [...content.matchAll(/### (scene-\d+)\n版本：(.+?)　运行端：(.+?)\n/g)];
    const verdicts = blocks.map(([, id, , platform]) => {
      if (this.forceVerdict) return { id, verdict: this.forceVerdict, reason: 'forced' };
      // 文档事实：getCamera 鸿蒙不支持 → 鸿蒙场景 error，其余端 ok
      const verdict = platform.includes('鸿蒙') ? 'error' : 'ok';
      return { id, verdict, reason: '文档：鸿蒙 ArkTS 不支持 getCamera' };
    });
    return verdicts as T;
  }
}

const DOC = [
  '### 7. jue.media.getCamera [硬校验]',
  '鸿蒙 ArkTS 不支持 getCamera，其余端可用。',
].join('\n');

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
    const failures = await verifyAgainstDoc(DOC, [constraintFor('ios')], defaultEngineConfig, llm);

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
    const failures = await verifyAgainstDoc(
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
    const failures = await verifyAgainstDoc(DOC, [constraintFor('ios')], defaultEngineConfig, llm);
    expect(failures).toHaveLength(0);
  });

  it('oracle 遗漏场景（空响应）→ 跳过不判失败', async () => {
    const llm = new ScriptedOracleLLM();
    llm.forceVerdict = 'missing';
    const failures = await verifyAgainstDoc(DOC, [constraintFor('ios')], defaultEngineConfig, llm);
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
});
