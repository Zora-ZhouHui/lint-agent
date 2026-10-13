import { describe, expect, it } from 'vitest';
import {
  apiPathFromHeading,
  extractApiPathFromCode,
  narrowDocToApis,
  parseDocSections,
  validateCitation,
} from '../src/engine/doc-context.js';

// 贴近真实踩坑文档的结构：全局约定前言 + 分组标题 + 编号条目
const DOC = [
  '# 跨端文档差异总结（jue SDK 约束样例）',
  '',
  '> 约定：`[硬校验]` 违规报错，`[提示]` 降级为提示，`[跳过]` 不校验。',
  '> 版本来自 `import jue from ".../jue/<版本>"` 的目录名。',
  '',
  '## 场景一：jue 系统能力（1–12）',
  '',
  '### 1. jue.system.getSystemInfo [硬校验]',
  '',
  'iOS 需 jue ≥ 2.25.0，Android 需 jue ≥ 2.10.0。低于阈值改用静态字段兜底。',
  '',
  '### 7. jue.system.vibrate [硬校验]',
  '',
  '鸿蒙部分机型不支持。做能力探测后降级为忽略。',
  '',
  '## 场景二：jue 媒体（53–64）',
  '',
  '### 59. jue.media.getCamera [硬校验]',
  '',
  '鸿蒙 ArkTS 不支持 getCamera，其余端可用。',
  '',
  '### 60. jue.media.onMediaStateChange [提示]',
  '',
  '平台差异不确定，仅提示按端分支处理。',
].join('\n');

describe('parseDocSections（文档切片）', () => {
  it('按编号条目切出 API 条目，路径从标题机械提取', () => {
    const sections = parseDocSections(DOC);
    expect(sections.map((s) => s.apiPath)).toEqual([
      'jue.system.getSystemInfo',
      'jue.system.vibrate',
      'jue.media.getCamera',
      'jue.media.onMediaStateChange',
    ]);
    // 正文归属正确：vibrate 条目里不应混入 getSystemInfo 的正文
    const vibrate = sections.find((s) => s.apiPath === 'jue.system.vibrate')!;
    expect(vibrate.body).toContain('鸿蒙部分机型不支持');
    expect(vibrate.body).not.toContain('iOS 需 jue ≥ 2.25.0');
  });

  it('条目正文到下一个条目/分组标题为止，不吞并后续条目', () => {
    const sections = parseDocSections(DOC);
    const camera = sections.find((s) => s.apiPath === 'jue.media.getCamera')!;
    expect(camera.body).toContain('鸿蒙 ArkTS 不支持 getCamera');
    expect(camera.body).not.toContain('平台差异不确定');
  });

  it('无 API 路径的标题不产生条目（分组标题不参与收窄）', () => {
    const sections = parseDocSections(DOC);
    expect(sections.some((s) => s.title.includes('场景一'))).toBe(false);
  });

  it('apiPathFromHeading 取标题里的最长 API 路径', () => {
    expect(apiPathFromHeading('### 1. jue.system.getSystemInfo [硬校验]')).toBe(
      'jue.system.getSystemInfo',
    );
    expect(apiPathFromHeading('### 1. 无 API 的条目')).toBeNull();
  });
});

describe('extractApiPathFromCode（从场景代码机械提取，不引入约束数据）', () => {
  it('提取三层挂载调用路径', () => {
    const code = [
      "import jue from './jue/2.22.0';",
      'if (isIOS) {',
      '  jue.system.getSystemInfo();',
      '}',
    ].join('\n');
    expect(extractApiPathFromCode(code)).toBe('jue.system.getSystemInfo');
  });

  it('同时出现前缀路径与完整路径时取更长者（setSync 不被 set 截断）', () => {
    const code = "jue.storage.set('a', 1);\njue.storage.setSync('a', 1);";
    expect(extractApiPathFromCode(code)).toBe('jue.storage.setSync');
  });

  it('import 路径里的 jue 不会被当成调用（无点号后接标识符的挂载）', () => {
    expect(extractApiPathFromCode("import jue from './jue/2.22.0';")).toBeNull();
  });
});

describe('narrowDocToApis（换输入视角：只喂相关条目 + 全局约定）', () => {
  it('命中条目时：保留前言与目标条目，切掉无关条目', () => {
    const narrowed = narrowDocToApis(DOC, ['jue.system.getSystemInfo']);
    expect(narrowed.fellBackToFullDoc).toBe(false);
    expect(narrowed.matched).toEqual(['jue.system.getSystemInfo']);
    expect(narrowed.text).toContain('jue.system.getSystemInfo');
    expect(narrowed.text).toContain('约定'); // 全局约定前言必须保留
    expect(narrowed.text).not.toContain('jue.media.getCamera'); // 无关条目被切掉
    expect(narrowed.text).not.toContain('jue.system.vibrate');
  });

  it('多个目标条目时全部保留', () => {
    const narrowed = narrowDocToApis(DOC, ['jue.system.vibrate', 'jue.media.getCamera']);
    expect(narrowed.fellBackToFullDoc).toBe(false);
    expect(narrowed.text).toContain('jue.system.vibrate');
    expect(narrowed.text).toContain('jue.media.getCamera');
    expect(narrowed.text).not.toContain('jue.system.getSystemInfo');
  });

  it('文档里找不到该 API → 退回全文并显式报告 unmatched（不静默给错片段）', () => {
    const narrowed = narrowDocToApis(DOC, ['jue.pay.requestPayment']);
    expect(narrowed.fellBackToFullDoc).toBe(true);
    expect(narrowed.unmatched).toEqual(['jue.pay.requestPayment']);
    expect(narrowed.text).toBe(DOC);
  });

  it('空目标列表 → 退回全文（无从收窄）', () => {
    const narrowed = narrowDocToApis(DOC, []);
    expect(narrowed.fellBackToFullDoc).toBe(true);
    expect(narrowed.text).toBe(DOC);
  });

  it('不做同模块放宽：目标方法名不在文档时退回全文，而不是拿邻居条目的规则背书', () => {
    const narrowed = narrowDocToApis(DOC, ['jue.media.previewImage']);
    expect(narrowed.fellBackToFullDoc).toBe(true);
    expect(narrowed.unmatched).toEqual(['jue.media.previewImage']);
    expect(narrowed.text).toBe(DOC);
  });
});

describe('validateCitation（引用先行必须有校验，否则退化成装饰）', () => {
  it('逐字存在的引用通过（含跨行空白差异）', () => {
    expect(validateCitation('鸿蒙 ArkTS 不支持 getCamera', DOC)).toBe(true);
    // 归一化后比较：换行/缩进不应让正确引用被判为幻觉
    expect(validateCitation('鸿蒙 ArkTS 不支持\ngetCamera', DOC)).toBe(true);
  });

  it('编造的原句不通过', () => {
    expect(validateCitation('文档明确说鸿蒙全版本支持 getCamera', DOC)).toBe(false);
  });

  it('过短的引用不足以支撑判定', () => {
    expect(validateCitation('鸿蒙', DOC)).toBe(false);
  });

  it('缺引用（undefined / 空串）一律不通过', () => {
    expect(validateCitation(undefined, DOC)).toBe(false);
    expect(validateCitation('', DOC)).toBe(false);
  });
});
