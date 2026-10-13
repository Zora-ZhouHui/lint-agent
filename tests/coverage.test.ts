import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computeCoverage,
  extractApiPaths,
  extractSkippedApiPaths,
} from '../src/engine/coverage.js';
import type { Constraint } from '../src/types/index.js';

function constraint(target: string): Constraint {
  return {
    name: 'x',
    target,
    selector: 'CallExpression',
    message: 'm',
    conditions: [],
    level: 'error',
    onResolveFail: 'warn',
    evidence: '',
  };
}

describe('extractApiPaths（从文档正则抽 jue.xxx 全路径）', () => {
  it('抽出模块.方法级别的 API 全路径', () => {
    const doc = '### 1. jue.system.getSystemInfo [硬校验]\n调用 jue.storage.set 需谨慎。';
    expect(extractApiPaths(doc)).toEqual(['jue.system.getSystemInfo', 'jue.storage.set']);
  });

  it('去重', () => {
    const doc = 'a jue.system.getSystemInfo b jue.system.getSystemInfo c';
    expect(extractApiPaths(doc)).toEqual(['jue.system.getSystemInfo']);
  });

  it('忽略模块级（仅两段）与「jue SDK」这类自然语言', () => {
    const doc = 'jue.storage 是存储模块；使用 jue SDK 前请确认版本。';
    expect(extractApiPaths(doc)).toEqual([]);
  });

  it('自定义 sdkName', () => {
    expect(extractApiPaths('foo.bar.baz 无效', 'foo')).toEqual(['foo.bar.baz']);
    expect(extractApiPaths('foo.bar.baz 无效', 'jue')).toEqual([]);
  });

  it('排除只出现在反引号行内代码内的占位符', () => {
    // jue.module.method 只在 `code` 内出现 → 占位符，排除
    const doc = '> 含 `jue.module.method` 多层挂载。\n### 1. jue.system.getSystemInfo [硬校验]';
    expect(extractApiPaths(doc)).toEqual(['jue.system.getSystemInfo']);
  });

  it('反引号内外都出现的路径保留', () => {
    // jue.storage.set 在正文裸文本和 `code` 中都出现 → 保留
    const doc = '调用 `jue.storage.set` 需谨慎。\njue.storage.set 是存储方法。';
    expect(extractApiPaths(doc)).toEqual(['jue.storage.set']);
  });
});

describe('computeCoverage（文档 vs 生成 target 差集）', () => {
  it('报告漏提与幻觉', () => {
    const doc = 'jue.system.getSystemInfo / jue.storage.set';
    const report = computeCoverage(doc, [
      constraint('jue.system.getSystemInfo'),
      constraint('jue.device.getIDFV'),
    ]);
    expect(report.missed).toEqual(['jue.storage.set']);
    expect(report.hallucinated).toEqual(['jue.device.getIDFV']);
  });

  it('全覆盖：无漏提无幻觉', () => {
    const doc = 'jue.system.getSystemInfo';
    const report = computeCoverage(doc, [constraint('jue.system.getSystemInfo')]);
    expect(report.missed).toEqual([]);
    expect(report.hallucinated).toEqual([]);
  });
});

describe('extractSkippedApiPaths（[跳过] 条目排除）', () => {
  it('抽取标了 [跳过] 的条目标题', () => {
    const doc = '### 1. jue.network.get [跳过]\n### 2. jue.system.getSystemInfo [硬校验]';
    expect(extractSkippedApiPaths(doc)).toEqual(['jue.network.get']);
  });

  it('无 [跳过] 标记时返回空数组', () => {
    expect(extractSkippedApiPaths('### 1. jue.system.getSystemInfo [硬校验]')).toEqual([]);
  });
});

describe('computeCoverage（[跳过] 条目不计入 missed）', () => {
  it('[跳过] 条目标题从 missed 中排除，列入 skippedInDoc', () => {
    const doc = '### 1. jue.network.get [跳过]\n### 2. jue.system.getSystemInfo [硬校验]';
    const report = computeCoverage(doc, [constraint('jue.system.getSystemInfo')]);
    // jue.network.get 标了 [跳过]，不算漏提
    expect(report.missed).toEqual([]);
    expect(report.skippedInDoc).toEqual(['jue.network.get']);
  });

  it('同名 API 在别处是硬校验条目 → 不得被另一条 [跳过] 条目整体划走（漏提必须可见）', () => {
    const doc = [
      '### 23. jue.network.request [硬校验]',
      '所有端 jue ≥ 2.0.0 才支持。',
      '### 33. jue.network.request 并发上限控制 [跳过]',
      '无法静态检测。',
    ].join('\n');
    expect(extractSkippedApiPaths(doc)).not.toContain('jue.network.request');
    // 因此这条真 API 若漏提，必须出现在 missed 里，而不是双向隐身
    expect(computeCoverage(doc, []).missed).toContain('jue.network.request');
  });

  it('图例 / 正文里的 [跳过] 字样不构成条目（只看 `### N.` 标题行）', () => {
    const doc = [
      '> - `[跳过]`：无法静态检测的语义模式 → 不校验，仅留档说明。',
      '### 5. jue.foo.bar [跳过]',
      '正文提到 jue.baz.qux 也标 [跳过]，但这一行不是条目标题。',
    ].join('\n');
    expect(extractSkippedApiPaths(doc)).toEqual(['jue.foo.bar']);
  });

  it('真实样例文档回归：jue.network.request 不再是「预期不提取」', () => {
    const doc = readFileSync('examples/input/cross-platform-pitfalls.md', 'utf8');
    const skipped = extractSkippedApiPaths(doc);
    expect(skipped).not.toContain('jue.network.request');
    // 确实只出现在 [跳过] 条目里的 API 仍被正确排除
    expect(skipped).toContain('jue.ui.getBoundingClientRect');
  });
});
