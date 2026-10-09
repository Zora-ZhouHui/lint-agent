import { describe, expect, it } from 'vitest';
import type { LLMClient } from '../src/llm/client.js';
import type { Constraint } from '../src/types/index.js';
import { extractPatterns, findConflicts, splitSections } from '../src/skills/extract-patterns.js';

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
  target: 'jue.example.bigint',
  selector: 'Literal[bigint]',
  message: '禁止 BigInt',
  conditions: [{ kind: 'unsupported', platform: 'h5' }],
  level: 'error',
  onResolveFail: 'warn',
  evidence: 'h5 端不支持 BigInt',
};

describe('extractPatterns', () => {
  it('按 target 去重，保留首次出现', async () => {
    const duplicateA: Constraint = { ...constraintA, message: '重复的' };
    const llm = {
      chatJSON: async () => [constraintA, duplicateA],
    } as unknown as LLMClient;

    const { constraints } = await extractPatterns('文档', llm);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].message).toBe('禁止 BigInt');
  });

  it('同名但 target 不同 → 不去重（target 才是身份）', async () => {
    const sameNameOtherTarget: Constraint = { ...constraintA, target: 'jue.example.other' };
    const llm = {
      chatJSON: async () => [constraintA, sameNameOtherTarget],
    } as unknown as LLMClient;

    const { constraints } = await extractPatterns('文档', llm);
    expect(constraints).toHaveLength(2);
  });

  it('空数组原样返回', async () => {
    const llm = { chatJSON: async () => [] } as unknown as LLMClient;
    const { constraints } = await extractPatterns('文档', llm);
    expect(constraints).toEqual([]);
  });

  it('同 target 不同 conditions → 记入 conflicts（保留首次出现）', async () => {
    const variant: Constraint = {
      ...constraintA,
      conditions: [{ kind: 'min_version', platform: 'h5', minVersion: '2.10.0' }],
    };
    const llm = {
      chatJSON: async () => [constraintA, variant],
    } as unknown as LLMClient;

    const { constraints, conflicts } = await extractPatterns('文档', llm);
    expect(constraints).toHaveLength(1); // 保留首次出现
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].target).toBe('jue.example.bigint');
    expect(conflicts[0].variants).toHaveLength(2);
  });
});

describe('findConflicts（同 target 数据行冲突检测）', () => {
  it('conditions 不同 → 冲突', () => {
    const b: Constraint = {
      ...constraintA,
      conditions: [{ kind: 'unsupported', platform: 'ios' }],
    };
    expect(findConflicts([constraintA, b])).toHaveLength(1);
  });

  it('level 不同 → 冲突', () => {
    const b: Constraint = { ...constraintA, level: 'warn' };
    expect(findConflicts([constraintA, b])).toHaveLength(1);
  });

  it('仅 message / evidence 不同 → 不算冲突（重复行，静默去重）', () => {
    const b: Constraint = { ...constraintA, message: '另一份文案', evidence: '另一段引用' };
    expect(findConflicts([constraintA, b])).toHaveLength(0);
  });

  it('无重复 target → 无冲突', () => {
    const b: Constraint = { ...constraintA, target: 'jue.example.other' };
    expect(findConflicts([constraintA, b])).toHaveLength(0);
  });
});
