// generate 命令：读取文档 → 跑确定性流水线 → 输出约束数据文件 + 可运行 ESLint 配置（单引擎 + 数据文件方案）
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { LLMClient, loadLLMConfigFromEnv } from '../../llm/client.js';
import { extractWithSelfHeal, printConvergenceTable } from '../../agent/self-heal.js';
import { Tracer } from '../../agent/trace.js';
import { logger } from '../../utils/logger.js';
import { readFileText, writeText } from '../../utils/file.js';
import { loadEngineConfig, writeConstraints, writeEngineConfig } from '../../engine/data-file.js';
import { renderFlatConfigSource } from '../../engine/distribute.js';
import { defaultEngineConfig } from '../../engine/default-config.js';

interface GenerateOptions {
  from: string;
  output: string;
}

export const generateCommand = new Command('generate')
  .description('从自然语言文档生成约束数据 + 可运行 ESLint 配置')
  .requiredOption('--from <file>', '输入文档路径')
  .option('--output <dir>', '输出目录', 'output')
  .action(async (opts: GenerateOptions) => {
    const outputDir = path.resolve(opts.output);
    const doc = readFileText(opts.from);

    // 引擎配置（repo 固定配置）：已存在则用（尊重 config 命令自定义），否则用默认 jue 配置，
    // 其 sdkName 决定提取阶段 selector 的根标识。
    const engineConfigPath = path.join(outputDir, 'engine-config.json');
    const engineConfig = fs.existsSync(engineConfigPath)
      ? loadEngineConfig(engineConfigPath)
      : defaultEngineConfig;

    const llm = new LLMClient(loadLLMConfigFromEnv());
    const tracer = new Tracer(path.join(outputDir, 'logs', 'agent-trace.jsonl'));

    logger.title('跨端规则生成 Agent（自纠错闭环）');
    logger.info(`文档：${opts.from}`);
    logger.info(`输出：${outputDir}`);
    logger.info(`sdkName：${engineConfig.sdkName}`);

    const started = Date.now();
    const result = await extractWithSelfHeal(doc, llm, engineConfig, { tracer });

    // 约束数据落盘为单一数据文件（引擎运行时读取）
    const constraintsPath = path.join(outputDir, 'constraints.json');
    writeConstraints(constraintsPath, result.constraints);

    // 引擎配置首次生成补默认 jue 配置（已存在则不覆盖）
    if (!fs.existsSync(engineConfigPath)) {
      writeEngineConfig(engineConfigPath, engineConfig);
    }

    // 分发层：约束数据 + 引擎配置接进单引擎，产出可直接运行的 ESLint flat config
    const configPath = path.join(outputDir, 'eslint.config.mjs');
    writeText(
      configPath,
      renderFlatConfigSource(path.relative(outputDir, path.resolve('dist', 'engine'))),
    );

    if (!result.passed) {
      logger.warn(
        `自纠错未完全通过：漏提 ${result.finalMissed.length}、` +
          `幻觉 ${result.finalHallucinated.length}、` +
          `行为失败 ${result.finalBehaviorFailures.length}、` +
          `语义失败 ${result.finalSemanticFailures.length}（详见 trace）`,
      );
    }
    if (result.conflicts.length > 0) {
      logger.warn(
        `检测到 ${result.conflicts.length} 组同 target 数据行冲突（保留首次出现，需人工裁决）：` +
          result.conflicts.map((c) => c.target).join('、'),
      );
    }

    const durationSec = ((Date.now() - started) / 1000).toFixed(1);

    console.log('\n======== 统计 ========');
    console.log(`约束总数：${result.constraints.length}`);
    console.log(
      `自纠错轮次：${result.rounds.length}（${result.passed ? '全部通过' : '仍有残留'}）`,
    );
    printConvergenceTable(result.rounds, result.passed);
    console.log(`Token 消耗：${llm.getTotalTokens()}`);
    console.log(`总耗时：${durationSec}s`);
    console.log(`约束数据文件：${constraintsPath}`);
    console.log(`ESLint 配置：${configPath}`);
    console.log(`Trace：${path.join(outputDir, 'logs', 'agent-trace.jsonl')}\n`);
  });
