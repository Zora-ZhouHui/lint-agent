import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LLMClient } from '../src/llm/client.js';
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
