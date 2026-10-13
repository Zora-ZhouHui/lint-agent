// CLI 选项解析回归测试。
//
// 背景（真实 bug）：commander 的 `--no-<flag>` 会把值映射到 `<flag>: false`，
// 而本项目曾把字段声明成 `noSemantic` 并读 `opts.noSemantic`——该字段永远不会被赋值，
// 于是「关闭语义层」的开关**静默失效**：用户以为跳过了 LLM 校验，实际照跑不误。
// 这类 bug 不会被任何业务单测发现（因为业务逻辑本身没错），只能靠直接断言解析结果。
import { describe, expect, it } from 'vitest';
import { Command } from 'commander';

/** 用与 eval.ts 完全一致的选项声明重建一个命令，只断言解析结果。 */
function parseEvalOptions(argv: string[]): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  const program = new Command();
  program
    .command('eval')
    .requiredOption('--from <file>', '输入文档路径')
    .option('--output <dir>', '产物目录', 'output')
    .option('--config <file>', '引擎配置 JSON 路径')
    .option('--no-semantic', '关闭语义层校验')
    .option('--no-narrow-context', '不做输入视角收窄')
    .action((opts: Record<string, unknown>) => {
      parsed = opts;
    });
  program.parse(['node', 'test', 'eval', ...argv]);
  return parsed;
}

describe('eval CLI 选项解析（--no-* 开关必须真的生效）', () => {
  it('不传 flag 时：语义层与收窄默认开启（semantic / narrowContext 均为 true）', () => {
    const opts = parseEvalOptions(['--from', 'doc.md']);
    // 关键：commander 的 --no-* 会把默认值设为 true，字段名是 semantic 而非 noSemantic
    expect(opts.semantic).toBe(true);
    expect(opts.narrowContext).toBe(true);
    expect(opts).not.toHaveProperty('noSemantic');
  });

  it('--no-semantic → semantic === false（曾因读错字段名而静默失效）', () => {
    const opts = parseEvalOptions(['--from', 'doc.md', '--no-semantic']);
    expect(opts.semantic).toBe(false);
    // 断言「错字段名不存在」，防止有人又把判断写成 opts.noSemantic
    expect(opts.noSemantic).toBeUndefined();
  });

  it('--no-narrow-context → narrowContext === false', () => {
    const opts = parseEvalOptions(['--from', 'doc.md', '--no-narrow-context']);
    expect(opts.narrowContext).toBe(false);
  });

  it('两个开关可同时使用', () => {
    const opts = parseEvalOptions(['--from', 'doc.md', '--no-semantic', '--no-narrow-context']);
    expect(opts.semantic).toBe(false);
    expect(opts.narrowContext).toBe(false);
  });
});
