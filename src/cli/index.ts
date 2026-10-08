#!/usr/bin/env node
// CLI 入口：lint-agent generate / lint-agent eval / lint-agent config
import { loadDotEnv } from '../utils/env.js';
import { Command } from 'commander';
import { generateCommand } from './commands/generate.js';
import { evalCommand } from './commands/eval.js';
import { configCommand } from './commands/config.js';

// 启动时加载项目根目录 .env（真实环境变量优先）
loadDotEnv();

const program = new Command();

program
  .name('lint-agent')
  .description('跨端规则自治维护 Agent：从自然语言文档提取约束数据，产出可运行的 ESLint 配置')
  .version('0.1.0');

program.addCommand(generateCommand);
program.addCommand(evalCommand);
program.addCommand(configCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
