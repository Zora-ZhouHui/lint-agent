import { describe, expect, it } from 'vitest';
import type { LLMClient } from '../src/llm/client.js';
import type { Constraint } from '../src/types/index.js';
import { extractPatterns, splitSections } from '../src/skills/extract-patterns.js';

describe('splitSections', () => {
  it('按 ## 二级标题切成多个章节块，引言并入首块', () => {
    const doc = ['# 标题', '', '> 引言', '', '## 场景一', '1', '## 场景二', '2'].join('\n');
    expect(splitSections(doc)).toEqual(['# 标题\n\n> 引言\n\n## 场景一\n1', '## 场景二\n2']);
  });

  it('无 ## 标题时整体作为单块', () => {
    expect(splitSections('纯文本')).toEqual(['纯文本']);
  });

  it('空文档返回空数组', () => {
    expect(splitSections('  \n  ')).toEqual([]);
  });
});

const constraintA: Constraint = {
  name: 'no-bigint',
  selector: 'Literal[bigint]',
  message: '禁止 BigInt',
  conditions: [{ kind: 'unsupported', platform: 'h5' }],
  level: 'error',
  onResolveFail: 'warn',
};

describe('extractPatterns', () => {
  it('按 name 去重，保留首次出现', async () => {
    const duplicateA: Constraint = { ...constraintA, message: '重复的' };
    const llm = {
      chatJSON: async () => [constraintA, duplicateA],
    } as unknown as LLMClient;

    const constraints = await extractPatterns('文档', llm);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].message).toBe('禁止 BigInt');
  });

  it('空数组原样返回', async () => {
    const llm = { chatJSON: async () => [] } as unknown as LLMClient;
    expect(await extractPatterns('文档', llm)).toEqual([]);
  });
});
