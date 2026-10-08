// generate 命令：读取文档 → 跑 Agent 循环 → 输出约束数据文件 + 可运行 ESLint 配置（单引擎 + 数据文件方案）
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import type { PlannerMode } from '../../types/index.js';
import { LLMClient, loadLLMConfigFromEnv } from '../../llm/client.js';
import { runAgentLoop } from '../../agent/loop.js';
import { Tracer } from '../../agent/trace.js';
import { logger } from '../../utils/logger.js';
import { readFileText, writeText } from '../../utils/file.js';
import { writeConstraints, writeEngineConfig } from '../../engine/data-file.js';
import { renderFlatConfigSource } from '../../engine/distribute.js';
import { defaultEngineConfig } from '../../engine/default-config.js';
import { parsePlannerMode } from './planner-mode.js';

interface GenerateOptions {
  from: string;
  output: string;
  maxSteps: string;
  planner: string;
}

export const generateCommand = new Command('generate')
  .description('从自然语言文档生成约束数据 + 可运行 ESLint 配置')
  .requiredOption('--from <file>', '输入文档路径')
  .option('--output <dir>', '输出目录', 'output')
  .option('--max-steps <n>', '最大步数上限', '80')
  .option('--planner <mode>', 'planner 模式：auto（默认）| llm | state', 'auto')
  .action(async (opts: GenerateOptions) => {
    const outputDir = path.resolve(opts.output);
    const plannerMode: PlannerMode = parsePlannerMode(opts.planner);
    const doc = readFileText(opts.from);

    const llm = new LLMClient(loadLLMConfigFromEnv());
    const tracer = new Tracer(path.join(outputDir, 'logs', 'agent-trace.jsonl'));

    logger.title('跨端规则生成 Agent');
    logger.info(`文档：${opts.from}`);
    logger.info(`输出：${outputDir}`);
    logger.info(`Planner：${plannerMode}`);

    const started = Date.now();
    const context = await runAgentLoop(doc, llm, {
      maxSteps: Number(opts.maxSteps),
      plannerMode,
      tracer,
    });

    // 约束数据落盘为单一数据文件（引擎运行时读取），失败信息写 failures/
    const constraintsPath = path.join(outputDir, 'constraints.json');
    writeConstraints(constraintsPath, context.constraints);

    // 引擎配置（repo 固定配置）：首次生成补默认 jue 配置，已存在则不覆盖（尊重 config 命令自定义）
    const engineConfigPath = path.join(outputDir, 'engine-config.json');
    if (!fs.existsSync(engineConfigPath)) {
      writeEngineConfig(engineConfigPath, defaultEngineConfig);
    }

    // 分发层：约束数据 + 引擎配置接进单引擎，产出可直接运行的 ESLint flat config
    const configPath = path.join(outputDir, 'eslint.config.mjs');
    writeText(
      configPath,
      renderFlatConfigSource(path.relative(outputDir, path.resolve('dist', 'engine'))),
    );

    if (context.failures.length > 0) {
      logger.error(`最终失败并已记录：${context.failures.length} 条（详见 trace）`);
    }

    const durationSec = ((Date.now() - started) / 1000).toFixed(1);

    console.log('\n======== 统计 ========');
    console.log(`约束总数：${context.constraints.length}`);
    console.log(`Token 消耗：${llm.getTotalTokens()}`);
    console.log(`总耗时：${durationSec}s`);
    console.log(`约束数据文件：${constraintsPath}`);
    console.log(`ESLint 配置：${configPath}`);
    console.log(`Trace：${path.join(outputDir, 'logs', 'agent-trace.jsonl')}\n`);
  });
