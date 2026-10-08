import { describe, expect, it } from 'vitest';
import { extractJSON } from '../src/llm/client.js';

describe('extractJSON', () => {
  it('解析裸 JSON 对象', () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥掉 markdown 代码块标记', () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJSON('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('从前后废话中截取 JSON', () => {
    expect(extractJSON('好的，结果如下：[1, 2] 以上。')).toEqual([1, 2]);
    expect(extractJSON('结果 {"a": 1} 完毕')).toEqual({ a: 1 });
  });

  it('完全找不到 JSON 时抛错', () => {
    expect(() => extractJSON('这里没有 JSON')).toThrow(SyntaxError);
  });
});
