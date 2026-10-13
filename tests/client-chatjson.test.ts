import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LLMClient, unwrapEnvelope } from '../src/llm/client.js';
import type { ChatOptions, Message } from '../src/types/index.js';

// 覆盖 chat()，不发起真实网络请求
class ScriptedClient extends LLMClient {
  private responses: string[];

  constructor(responses: string[], maxRetries = 3) {
    super({ provider: 'openai', model: 'test', apiKey: 'test', maxRetries, timeoutMs: 1000 });
    this.responses = responses;
  }

  override async chat(_messages: Message[], _options?: ChatOptions): Promise<string> {
    return this.responses.shift() ?? '';
  }
}

const schema = z.object({ n: z.number() });

describe('chatJSON 格式修复循环', () => {
  it('第一次就合法时直接返回', async () => {
    const client = new ScriptedClient(['{"n": 1}']);
    expect(await client.chatJSON([], schema)).toEqual({ n: 1 });
  });

  it('带 markdown 围栏的输出也能解析', async () => {
    const client = new ScriptedClient(['```json\n{"n": 2}\n```']);
    expect(await client.chatJSON([], schema)).toEqual({ n: 2 });
  });

  it('非法输出后带着错误重试，第二次成功', async () => {
    const client = new ScriptedClient(['这不是 JSON', '{"n": 3}']);
    const result = await client.chatJSON([{ role: 'user', content: '原始请求' }], schema, {
      label: 'test',
    });
    expect(result).toEqual({ n: 3 });
  });

  it('schema 校验失败同样触发修复循环', async () => {
    // 第一次返回合法 JSON 但字段类型错误，第二次正确
    const client = new ScriptedClient(['{"n": "abc"}', '{"n": 4}']);
    expect(await client.chatJSON([], schema)).toEqual({ n: 4 });
  });

  it('重试耗尽后抛错', async () => {
    const client = new ScriptedClient(['nope', 'still nope'], 1); // maxRetries=1 → 共 2 次
    await expect(client.chatJSON([], schema)).rejects.toThrow('chatJSON');
  });
});

// ---------- 信封解包（有界容错） ----------

describe('unwrapEnvelope（模型把裸数组包成对象的容错）', () => {
  it('剥掉已知信封键的单键对象', () => {
    expect(unwrapEnvelope({ constraints: [1, 2] })).toEqual([1, 2]);
    expect(unwrapEnvelope({ data: [1] })).toEqual([1]);
    expect(unwrapEnvelope({ items: [1] })).toEqual([1]);
  });

  it('多层信封逐层剥开', () => {
    expect(unwrapEnvelope({ data: { constraints: [1] } })).toEqual([1]);
  });

  it('不碰裸数组与多键对象（避免误伤正常响应）', () => {
    expect(unwrapEnvelope([1, 2])).toEqual([1, 2]);
    // 多键对象不是信封，原样返回
    expect(unwrapEnvelope({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('不把合法业务对象误当信封', () => {
    // condition 形态：单键但键名不在信封集合内（kind / platform / minVersion）
    expect(unwrapEnvelope({ kind: 'min_version' })).toEqual({ kind: 'min_version' });
    expect(unwrapEnvelope({ platform: 'all' })).toEqual({ platform: 'all' });
    // 非对象直接返回
    expect(unwrapEnvelope('x')).toBe('x');
    expect(unwrapEnvelope(null)).toBeNull();
  });

  it('深度上限防止无限剥壳', () => {
    const deep = { data: { data: { data: { data: [1] } } } };
    // maxDepth=3 时第 4 层不会被剥开
    expect(unwrapEnvelope(deep, 3)).toEqual({ data: [1] });
    expect(unwrapEnvelope(deep, 10)).toEqual([1]);
  });
});

describe('chatJSON 对信封包裹的实际容错（实测失效的回归）', () => {
  it('数组契约遇上 {"constraints":[...]} → 自动剥信封，不消耗修复重试', async () => {
    const arrSchema = z.array(z.object({ target: z.string() }));
    const client = new ScriptedClient(['{"constraints":[{"target":"jue.a.one"}]}']);
    expect(await client.chatJSON([], arrSchema)).toEqual([{ target: 'jue.a.one' }]);
  });

  it('信封里仍是不合法数据 → 仍要报错（不会因为剥壳就放行）', async () => {
    const arrSchema = z.array(z.object({ target: z.string() }));
    // 剥开信封后是 {target: 123}，类型不对，必须失败
    const client = new ScriptedClient([
      '{"constraints":[{"target":123}]}',
      '{"constraints":[{"target":123}]}',
      '{"constraints":[{"target":123}]}',
      '{"constraints":[{"target":123}]}',
    ]);
    await expect(client.chatJSON([], arrSchema)).rejects.toThrow(/仍未得到合法输出/);
  });
});
