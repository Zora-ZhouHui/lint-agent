// prompt 契约测试：这些指令一旦被改错，会**静默产出语义错误的约束**，
// 而引擎自检对这类错误天然全绿（题面与答案同源），只有语义层能抓到。
// 因此用断言锁住几条关键的语义规则，避免回退。
import { describe, expect, it } from 'vitest';
import { extractPatternsPrompt, healMissedPrompt, healVersionsPrompt } from '../src/llm/prompts.js';

const text = (msgs: { content: string }[]): string => msgs.map((m) => m.content).join('\n');

describe('提取 prompt 的语义契约', () => {
  const ex = text(extractPatternsPrompt('文档内容', 'jue'));

  it('不再要求模型输出 name（由引擎从 target 推导）', () => {
    // 曾因模型把 name 填成 API 路径，整批补提取被 Zod 校验打挂
    expect(ex).not.toMatch(/"name":\s*"kebab/);
  });

  it('明确「所有端 ≥ X」必须逐端展开，而不是 conditions: []', () => {
    // 这是实测过的真实语义错误：文档「所有端 jue ≥ 2.0.0 才支持」被写成 conditions: []，
    // 而空数组的语义是「全端无条件禁用」——任何版本都拦，与文档完全相反。
    expect(ex).toContain('逐端展开成 4 条');
    expect(ex).toContain('≠ conditions: []');
    expect(ex).toContain('空数组的语义是');
  });

  it('给出两种合法 condition 形态的精确写法', () => {
    expect(ex).toContain('"kind": "unsupported"');
    expect(ex).toContain('"kind": "min_version"');
  });
});

describe('heal_missed prompt 的格式契约', () => {
  const hm = text(healMissedPrompt(['jue.router.navigateTo'], '文档内容', 'jue'));

  it('内联 conditions 的精确格式（缺失会导致整批校验失败）', () => {
    // 实测根因：模型输出 {"platform":"all","jue":">=2.0.0"}，整批校验失败，
    // 9 条漏提三轮补不回来。prompt 必须自带格式规格，不能只说「与首次提取一致」。
    expect(hm).toContain('"kind": "min_version"');
    expect(hm).toContain('"kind": "unsupported"');
    expect(hm).toContain('不存在 "all"');
    expect(hm).toContain('不要写 ">=2.25.0"');
  });

  it('不再要求输出 name / selector', () => {
    expect(hm).toContain('name 与 selector 都不需要输出');
  });

  it('三个遗漏 API 都必须列进 prompt', () => {
    const multi = text(healMissedPrompt(['jue.a.one', 'jue.b.two'], '文档内容', 'jue'));
    expect(multi).toContain('- jue.a.one');
    expect(multi).toContain('- jue.b.two');
    expect(multi).toContain('共 2 条');
  });
});

describe('heal_versions prompt 的护栏', () => {
  it('允许原样返回，禁止为迎合清单而篡改版本号', () => {
    const hv = text(
      healVersionsPrompt(
        [{ name: 'n', target: 'jue.a.one', platform: 'ios', minVersion: '9.9.9' }],
        ['2.0.0', '2.5.0'],
        '文档内容',
        'jue',
      ),
    );
    expect(hv).toContain('原样重新输出');
    expect(hv).toContain('不要为了迎合清单而篡改版本号');
    expect(hv).toContain('2.0.0 < 2.5.0');
  });
});
