// eval 命令：跑 Agent 循环 → 与 expected-rules.json 对比 → 输出量化指标
// 单引擎 + 数据文件方案：提取约束 → 引擎加载 → Linter 验证 expected 用例（不再逐条 loadRule）
import path from 'node:path';
import fs from 'node:fs';
import { Linter } from 'eslint';
import { Command } from 'commander';
import chalk from 'chalk';
import type {
  Constraint,
  EvalResult,
  EngineConfig,
  ExpectedFile,
  ExpectedRule,
  PlannerMode,
  Platform,
} from '../../types/index.js';
import { PLATFORM_VALUES, expectedFileSchema } from '../../types/index.js';
import { LLMClient, loadLLMConfigFromEnv } from '../../llm/client.js';
import { runAgentLoop } from '../../agent/loop.js';
import { Tracer } from '../../agent/trace.js';
import { buildUnsupportedApiConfig } from '../../engine/unsupported-api.js';
import { loadEngineConfig } from '../../engine/data-file.js';
import { defaultEngineConfig } from '../../engine/default-config.js';
import { logger } from '../../utils/logger.js';
import { readFileText, readJSON, writeJSON } from '../../utils/file.js';
import { parsePlannerMode } from './planner-mode.js';

interface EvalOptions {
  from: string;
  expect: string;
  maxSteps: string;
  planner: string;
  engineConfig?: string;
}

// 约束覆盖到的端：conditions 空 = 全端；否则取 conditions 里出现的平台并集
export function platformsOf(constraint: Constraint): Platform[] {
  if (constraint.conditions.length === 0) return [...PLATFORM_VALUES];
  return [...new Set(constraint.conditions.map((c) => c.platform))];
}

// 期望平台是否都被覆盖（多标保守安全、漏标才危险）
export function coversPlatforms(
  generated: readonly Platform[],
  expected: readonly Platform[],
): boolean {
  return expected.every((p) => generated.includes(p));
}

// 语义匹配：名字（标识）+ 平台覆盖（期望集 ⊆ 实际集）
export function matchConstraint(constraint: Constraint, expected: ExpectedRule): boolean {
  return (
    constraint.name === expected.name &&
    coversPlatforms(platformsOf(constraint), expected.platforms)
  );
}

const linter = new Linter({ configType: 'flat' });

// 引擎单约束运行时：命中即报。返回该代码被引擎报出的条数。
function countReports(
  constraint: Constraint,
  engineConfig: EngineConfig | null,
  code: string,
): number {
  const config = buildUnsupportedApiConfig([constraint], engineConfig);
  return linter.verify(code, config).length;
}

export const evalCommand = new Command('eval')
  .description('生成约束并与期望结果对比，输出量化指标')
  .requiredOption('--from <file>', '输入文档路径')
  .requiredOption('--expect <file>', '期望结果 JSON 路径')
  .option('--max-steps <n>', '最大步数上限', '80')
  .option('--planner <mode>', 'planner 模式：auto（默认）| llm | state', 'auto')
  .option('--config <file>', '引擎配置 JSON 路径（缺省使用默认 jue 配置）')
  .action(async (opts: EvalOptions) => {
    // 清空默认产物目录，避免上轮运行遗留的旧产物污染结果
    fs.rmSync(path.resolve('output'), { recursive: true, force: true });
    const doc = readFileText(opts.from);
    const expected = expectedFileSchema.parse(readJSON<ExpectedFile>(opts.expect));
    const plannerMode: PlannerMode = parsePlannerMode(opts.planner);
    const engineConfig: EngineConfig = opts.engineConfig
      ? loadEngineConfig(opts.engineConfig)
      : defaultEngineConfig;

    const llm = new LLMClient(loadLLMConfigFromEnv());
    const tracer = new Tracer();

    logger.title('跨端规则生成 Agent · Eval');
    logger.info(`文档：${opts.from}`);
    logger.info(
      `期望：${opts.expect}（${expected.expectedRules.length} 条规则 / ${expected.testCases.length} 条用例）`,
    );
    logger.info(`Planner：${plannerMode}`);
    logger.info(`引擎配置：${opts.engineConfig ?? '（未提供，使用默认 jue 配置）'}`);

    const started = Date.now();
    const context = await runAgentLoop(doc, llm, {
      maxSteps: Number(opts.maxSteps),
      plannerMode,
      tracer,
    });

    const constraintByName = new Map(context.constraints.map((c) => [c.name, c]));

    // ---------- 规则级指标：提取的约束是否覆盖期望规则（按 name + platforms 语义匹配） ----------
    const matchedPairs = expected.expectedRules
      .map((e) => {
        const constraint = constraintByName.get(e.name);
        return {
          expected: e,
          constraint,
          matched: constraint !== undefined && matchConstraint(constraint, e),
        };
      })
      .filter(
        (p): p is { expected: ExpectedRule; constraint: Constraint; matched: true } => p.matched,
      );
    const matchedExpected = matchedPairs.map((p) => p.expected);
    const missedExpected = expected.expectedRules.filter(
      (e) => !matchedPairs.some((p) => p.expected === e),
    );
    const extraConstraints = context.constraints.filter(
      (c) => !expected.expectedRules.some((e) => e.name === c.name),
    );

    // ---------- 用例级指标：FP / FN（按 ruleName 找到约束，单约束隔离运行引擎） ----------
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const tc of expected.testCases) {
      const constraint = constraintByName.get(tc.ruleName);
      const reported =
        constraint !== undefined && countReports(constraint, engineConfig, tc.code) > 0;
      if (tc.shouldReport) {
        if (reported) tp++;
        else fn++;
      } else {
        if (reported) fp++;
        else tn++;
      }
    }

    const evalResult: EvalResult = {
      totalConstraints: context.constraints.length,
      matchedExpected: matchedExpected.length,
      accuracy: expected.expectedRules.length
        ? matchedExpected.length / expected.expectedRules.length
        : 0,
      falsePositives: fp,
      falsePositiveRate: fp + tn ? fp / (fp + tn) : 0,
      falseNegatives: fn,
      falseNegativeRate: fn + tp ? fn / (fn + tp) : 0,
      avgDurationMs: context.history.length
        ? context.history.reduce((s, h) => s + h.durationMs, 0) / context.history.length
        : 0,
      totalTokens: llm.getTotalTokens(),
    };

    // ---------- 输出 ----------
    writeJSON(path.resolve('output/eval-result.json'), {
      ...evalResult,
      matched: matchedExpected.map((e) => e.name),
      missed: missedExpected.map((e) => e.name),
      extraConstraints: extraConstraints.map((c) => c.name),
      wallMs: Date.now() - started,
    });

    const totalPositive = expected.testCases.filter((tc) => tc.shouldReport).length;
    const totalNegative = expected.testCases.length - totalPositive;

    console.log('\n' + chalk.bold.cyan('════ Eval 结果 ════'));
    console.log(`约束总数：${evalResult.totalConstraints}`);
    console.log(
      `规则匹配：${evalResult.matchedExpected}/${expected.expectedRules.length}` +
        `（准确率 ${(evalResult.accuracy * 100).toFixed(0)}%，按 name+平台 语义匹配）`,
    );
    // 规则匹配 0/N：期望基线与样例文档未对齐（或约束命名不一致），FP/FN 是纯噪声，显式告警
    if (evalResult.matchedExpected === 0 && expected.expectedRules.length > 0) {
      logger.warn('⚠ 规则匹配 0/N：期望基线与样例文档可能未对齐，下方 FP/FN 无参考意义。');
    }
    if (missedExpected.length > 0) {
      logger.warn(`未命中：${missedExpected.map((e) => e.name).join('、')}`);
    }
    if (extraConstraints.length > 0) {
      logger.info(`额外约束（不在期望内）：${extraConstraints.map((c) => c.name).join('、')}`);
    }
    console.log(
      `误报 FP：${evalResult.falsePositives}/${totalNegative}` +
        `（误报率 ${(evalResult.falsePositiveRate * 100).toFixed(0)}%）`,
    );
    console.log(
      `漏报 FN：${evalResult.falseNegatives}/${totalPositive}` +
        `（漏报率 ${(evalResult.falseNegativeRate * 100).toFixed(0)}%）`,
    );
    console.log(`平均单步耗时：${evalResult.avgDurationMs.toFixed(0)}ms`);
    console.log(`Token 消耗：${evalResult.totalTokens}`);
    logger.info(`完整结果：output/eval-result.json\n`);
  });
