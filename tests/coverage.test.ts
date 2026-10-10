import { describe, expect, it } from 'vitest';
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
  it('抽取标了 [跳过] 的 API 路径', () => {
    const doc = '### jue.network.get [跳过]\njue.system.getSystemInfo [硬校验]';
    expect(extractSkippedApiPaths(doc)).toEqual(['jue.network.get']);
  });

  it('无 [跳过] 标记时返回空数组', () => {
    expect(extractSkippedApiPaths('jue.system.getSystemInfo [硬校验]')).toEqual([]);
  });
});

describe('computeCoverage（[跳过] 条目不计入 missed）', () => {
  it('[跳过] 条目从 missed 中排除，列入 skippedInDoc', () => {
    const doc = 'jue.network.get [跳过]\njue.system.getSystemInfo [硬校验]';
    const report = computeCoverage(doc, [constraint('jue.system.getSystemInfo')]);
    // jue.network.get 标了 [跳过]，不算漏提
    expect(report.missed).toEqual([]);
    expect(report.skippedInDoc).toEqual(['jue.network.get']);
  });
});
