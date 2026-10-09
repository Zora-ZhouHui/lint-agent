// eval 命令：校验 generate 已生成的约束是否正确，默认两步，均不依赖手写 JSON、不重跑 LLM：
//   1. 覆盖率（文档为锚点）：从 --from 文档抽取 jue.xxx 全路径，与生成 target 做差集 → 漏提 / 幻觉
//   2. 行为校验（引擎为锚点）：逐条约束合成 fire（必命中）/ not-fire（必放行）代码，跑 Linter 断言规则真的生效
//   3. 语义校验（--semantic 可选，LLM-as-judge）：逐条对照文档原文评审 conditions / level / evidence 忠实度
// 输入是 generate 的产物（<output>/constraints.json），而非原始文档本身——generate 纯生成，eval 纯校验。
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Linter } from 'eslint';
import type { Constraint, EngineConfig } from '../../types/index.js';
import { loadConstraints, loadEngineConfig } from '../../engine/data-file.js';
import { defaultEngineConfig } from '../../engine/default-config.js';
import { buildUnsupportedApiConfig } from '../../engine/unsupported-api.js';
import { computeCoverage } from '../../engine/coverage.js';
import { synthesizeCases } from '../../engine/behavior.js';
import { LLMClient, loadLLMConfigFromEnv } from '../../llm/client.js';
import { verifySemantics } from '../../agent/judge.js';
import { logger } from '../../utils/logger.js';
import { readFileText, writeJSON } from '../../utils/file.js';

interface EvalOptions {
  from: string;
  output: string;
  config?: string;
  semantic?: boolean;
}

const linter = new Linter({ configType: 'flat' });

// 该代码被 error 规则（severity=2）报出的条数
function errorCount(msgs: Linter.LintMessage[]): number {
  return msgs.filter((m) => m.severity === 2).length;
}

// 单条约束的行为校验：fire 必命中、not-fire 必放行。返回 null 表示通过，否则返回失败原因。
function verifyBehavior(constraint: Constraint, config: EngineConfig): string | null {
  const { fire, notFire } = synthesizeCases(constraint, config);
  const lintConfig = buildUnsupportedApiConfig([constraint], config);

  const fireMsgs = linter.verify(fire, lintConfig);
  const fireOk = constraint.level === 'warn' ? fireMsgs.length > 0 : errorCount(fireMsgs) > 0;
  if (!fireOk) return `fire 未命中：\n${fire.trim()}`;

  if (notFire !== null && errorCount(linter.verify(notFire, lintConfig)) !== 0) {
    return `not-fire 被误报：\n${notFire.trim()}`;
  }
  return null;
}

export const evalCommand = new Command('eval')
  .description('校验 generate 产物：覆盖率（漏提/幻觉）+ 行为（规则是否生效）+ 语义（--semantic）')
  .requiredOption('--from <file>', '输入文档路径（覆盖率锚点）')
  .option('--output <dir>', 'generate 产物目录（读取 <dir>/constraints.json）', 'output')
  .option(
    '--config <file>',
    '引擎配置 JSON 路径（缺省读 <dir>/engine-config.json，再退回默认 jue 配置）',
  )
  .option('--semantic', '启用 LLM-as-judge 语义校验（对照文档评审约束忠实度，需 API Key）')
  .action(async (opts: EvalOptions) => {
    const outputDir = path.resolve(opts.output);
    const constraintsPath = path.join(outputDir, 'constraints.json');

    if (!fs.existsSync(constraintsPath)) {
      throw new Error(`约束数据文件不存在：${constraintsPath}（请先 npm run generate）`);
    }

    const doc = readFileText(opts.from);
    const constraints = loadConstraints(constraintsPath);

    // 引擎配置：显式 --config > 产物 engine-config.json > 默认 jue 配置
    const engineConfigPath = path.join(outputDir, 'engine-config.json');
    const engineConfig: EngineConfig = opts.config
      ? loadEngineConfig(opts.config)
      : fs.existsSync(engineConfigPath)
        ? loadEngineConfig(engineConfigPath)
        : defaultEngineConfig;

    logger.title('跨端规则生成 Agent · Eval');
    logger.info(`文档：${opts.from}`);
    logger.info(`约束：${constraintsPath}（${constraints.length} 条）`);
    logger.info(
      `引擎配置：${opts.config ?? (fs.existsSync(engineConfigPath) ? engineConfigPath : '（默认 jue 配置）')}`,
    );

    // ---------- 第一步：覆盖率（文档 vs 生成 target 差集） ----------
    const coverage = computeCoverage(doc, constraints, engineConfig.sdkName);

    console.log('\n======== 覆盖率 ========');
    console.log(
      `文档 API：${coverage.docApiPaths.length} 条 / 生成 target：${coverage.generatedTargets.length} 条`,
    );
    if (coverage.missed.length > 0) {
      console.log(
        `⚠ 漏提（文档有、结果无，含 [跳过] 条目需人工确认是否应忽略）：\n  ${coverage.missed.join('\n  ')}`,
      );
    }
    if (coverage.hallucinated.length > 0) {
      console.log(
        `⚠ 幻觉（结果有、文档无，应移除或补文档）：\n  ${coverage.hallucinated.join('\n  ')}`,
      );
    }
    if (coverage.missed.length === 0 && coverage.hallucinated.length === 0) {
      console.log('✔ 全覆盖，无漏提 / 无幻觉');
    }

    // ---------- 第二步：行为校验（每条约束触发/不触发） ----------
    const failures: { name: string; reason: string }[] = [];
    let skippedNotFire = 0;
    console.log('\n======== 行为校验 ========');
    for (const c of constraints) {
      const reason = verifyBehavior(c, engineConfig);
      if (reason !== null) {
        failures.push({ name: c.name, reason });
        console.log(`  ✘ ${c.name}`);
        console.log(`      ${reason}`);
      } else {
        const skipped = synthesizeCases(c, engineConfig).notFire === null;
        if (skipped) skippedNotFire += 1;
        console.log(`  ✔ ${c.name}`);
      }
    }
    console.log(
      `\n结果：${constraints.length - failures.length}/${constraints.length} 条通过（跳过 not-fire ${skippedNotFire} 条）`,
    );

    // ---------- 第三步（可选）：语义校验（LLM-as-judge 对照文档评审忠实度） ----------
    let semanticFailures: { name: string; target: string; issue: string }[] = [];
    if (opts.semantic) {
      console.log('\n======== 语义校验（LLM-as-judge） ========');
      const llm = new LLMClient(loadLLMConfigFromEnv());
      semanticFailures = await verifySemantics(doc, constraints, llm, engineConfig.sdkName);
      if (semanticFailures.length === 0) {
        console.log('✔ 全部约束与文档原文一致');
      } else {
        for (const f of semanticFailures) {
          console.log(`  ✘ ${f.name}（${f.target}）`);
          console.log(`      ${f.issue}`);
        }
        logger.info(`语义校验消耗 Token：${llm.getTotalTokens()}`);
      }
    }

    // ---------- 输出 + 退出码 ----------
    writeJSON(path.join(outputDir, 'eval-result.json'), {
      coverage,
      behavior: {
        total: constraints.length,
        passed: constraints.length - failures.length,
        skippedNotFire,
        failures,
      },
      semantic: { enabled: Boolean(opts.semantic), failures: semanticFailures },
    });

    const hasHallucination = coverage.hallucinated.length > 0;
    if (failures.length > 0 || hasHallucination || semanticFailures.length > 0) {
      logger.error(
        failures.length > 0
          ? `${failures.length} 条规则未通过行为校验（生成规则未正确生效）`
          : hasHallucination
            ? `${coverage.hallucinated.length} 条幻觉（结果有、文档无）`
            : `${semanticFailures.length} 条约束与文档原文不符（语义校验）`,
      );
      process.exitCode = 1;
    } else {
      logger.info('✔ 覆盖率无幻觉、行为校验全部通过');
    }
    logger.info(`完整结果：${path.join(outputDir, 'eval-result.json')}\n`);
  });
