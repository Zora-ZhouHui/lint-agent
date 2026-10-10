// eval 命令：校验 generate 已生成的约束是否正确。三层校验，锚点各不相同：
//   1. 覆盖率（零 LLM，锚=文档）：正则抽文档 API 全路径与生成 target 做差集 → 漏提 / 幻觉。
//      [跳过] 条目已从 missed 中排除，单独列入 skippedInDoc。
//   2. 引擎自检（零 LLM，锚=引擎）：每条约束合成「版本 × 端」边界场景跑真实 Linter，
//      断言引擎按约束数据执行（selector / 解析 / severity 接线）。期望与数据同源，
//      故只回答「响不响」，不回答「对不对」。
//   3. 语义层（默认开启，锚=文档，需 LLM）：
//      a. 忠实度评审：LLM-as-judge 逐条对照文档评审 conditions/level/evidence；
//      b. 文档差分：oracle LLM 只看文档、对具体场景代码独立判定，与引擎真实 lint 结果差分——
//         期望不来自约束自身，能抓「数据自洽但与文档不符」（平台/版本抄错）。
//      无 API Key 时跳过并显著警告「数据正确性未验证」；--no-semantic 显式关闭。
// 末尾输出总结裁决，一眼看出 Agent 产物是否可用。
// 输入是 generate 的产物（<output>/constraints.json），而非原始文档本身——generate 纯生成，eval 纯校验。
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Linter } from 'eslint';
import type { Constraint, EngineConfig, OracleFailure } from '../../types/index.js';
import { loadConstraints, loadEngineConfig } from '../../engine/data-file.js';
import { defaultEngineConfig } from '../../engine/default-config.js';
import { buildUnsupportedApiConfig } from '../../engine/unsupported-api.js';
import { computeCoverage } from '../../engine/coverage.js';
import { synthesizeScenarios, type ScenarioExpect } from '../../engine/behavior.js';
import { LLMClient, loadLLMConfigFromEnv } from '../../llm/client.js';
import { verifySemantics } from '../../agent/judge.js';
import { verifyAgainstDoc } from '../../agent/oracle.js';
import { logger } from '../../utils/logger.js';
import { readFileText, writeJSON } from '../../utils/file.js';

interface EvalOptions {
  from: string;
  output: string;
  config?: string;
  noSemantic?: boolean;
}

const linter = new Linter({ configType: 'flat' });

/** 把 Linter 消息归约为 error / warn / ok 三态。 */
function severityOf(msgs: Linter.LintMessage[]): ScenarioExpect {
  if (msgs.some((m) => m.severity === 2)) return 'error';
  if (msgs.some((m) => m.severity === 1)) return 'warn';
  return 'ok';
}

interface SelfCheckFailure {
  name: string;
  target: string;
  mismatches: {
    scenarioId: string;
    code: string;
    expect: ScenarioExpect;
    actual: ScenarioExpect;
  }[];
}

/** 引擎自检：一条约束的全部场景逐个跑真实 Linter，返回不匹配场景（空数组=通过）。 */
function selfCheckConstraint(
  constraint: Constraint,
  config: EngineConfig,
): SelfCheckFailure | null {
  const lintConfig = buildUnsupportedApiConfig([constraint], config);
  const mismatches: SelfCheckFailure['mismatches'] = [];
  for (const scenario of synthesizeScenarios(constraint, config)) {
    const actual = severityOf(linter.verify(scenario.code, lintConfig));
    if (actual !== scenario.expect) {
      mismatches.push({
        scenarioId: scenario.id,
        code: scenario.code,
        expect: scenario.expect,
        actual,
      });
    }
  }
  return mismatches.length === 0
    ? null
    : { name: constraint.name, target: constraint.target, mismatches };
}

export const evalCommand = new Command('eval')
  .description('校验 generate 产物：覆盖率 + 引擎自检 + 语义层（默认开启），末尾输出总结裁决')
  .requiredOption('--from <file>', '输入文档路径（覆盖率/语义锚点）')
  .option('--output <dir>', 'generate 产物目录（读取 <dir>/constraints.json）', 'output')
  .option(
    '--config <file>',
    '引擎配置 JSON 路径（缺省读 <dir>/engine-config.json，再退回默认 jue 配置）',
  )
  .option('--no-semantic', '关闭语义层校验（默认开启：忠实度评审 + 文档差分，需 LLM API Key）')
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

    // ---------- 第一层：覆盖率（文档 vs 生成 target 差集） ----------
    const coverage = computeCoverage(doc, constraints, engineConfig.sdkName);

    console.log('\n======== 覆盖率（锚：文档） ========');
    const effectiveDocApis = coverage.docApiPaths.length - coverage.skippedInDoc.length;
    console.log(
      `文档 API：${coverage.docApiPaths.length} 条` +
        (coverage.skippedInDoc.length > 0
          ? `（其中 [跳过] ${coverage.skippedInDoc.length} 条，预期不提取）`
          : '') +
        ` / 生成 target：${coverage.generatedTargets.length} 条`,
    );
    if (coverage.missed.length > 0) {
      console.log(
        `⚠ 漏提 ${coverage.missed.length} 条（文档有、结果无，应提取但未提取）：\n  ${coverage.missed.join('\n  ')}`,
      );
    }
    if (coverage.hallucinated.length > 0) {
      console.log(
        `⚠ 幻觉 ${coverage.hallucinated.length} 条（结果有、文档无，应移除或补文档）：\n  ${coverage.hallucinated.join('\n  ')}`,
      );
    }
    if (coverage.missed.length === 0 && coverage.hallucinated.length === 0) {
      console.log('✔ 全覆盖，无漏提 / 无幻觉');
    }
    const coverageRate =
      effectiveDocApis > 0
        ? `${Math.round(((effectiveDocApis - coverage.missed.length) / effectiveDocApis) * 100)}%`
        : '100%';

    // ---------- 第二层：引擎自检（场景跑真实 Linter，验接线不验内容） ----------
    console.log('\n======== 引擎自检（锚：引擎，零 LLM） ========');
    const selfCheckFailures: SelfCheckFailure[] = [];
    let scenarioTotal = 0;
    for (const c of constraints) {
      scenarioTotal += synthesizeScenarios(c, engineConfig).length;
      const failure = selfCheckConstraint(c, engineConfig);
      if (failure) {
        selfCheckFailures.push(failure);
        console.log(`  ✘ ${c.name}`);
        for (const m of failure.mismatches) {
          console.log(`      ${m.scenarioId}：期望 ${m.expect}，实际 ${m.actual}`);
        }
      } else {
        console.log(`  ✔ ${c.name}`);
      }
    }
    console.log(
      `\n结果：${constraints.length - selfCheckFailures.length}/${constraints.length} 条约束通过（共 ${scenarioTotal} 个场景）`,
    );
    console.log('  ┌────────────────────────────────────────────────────────┐');
    console.log('  │ ⚠ 自检只验引擎接线（selector/scope/severity）         │');
    console.log('  │ 数据正确性（平台/版本是否忠于文档）由语义层负责       │');
    console.log('  └────────────────────────────────────────────────────────┘');

    // ---------- 第三层：语义层（默认开启，需 LLM API Key） ----------
    let semanticFailures: { name: string; target: string; issue: string }[] = [];
    let oracleFailures: OracleFailure[] = [];
    let semanticRan = false;

    if (opts.noSemantic) {
      console.log('\n======== 语义层（已通过 --no-semantic 关闭） ========');
    } else {
      let llm: LLMClient | undefined;
      try {
        llm = new LLMClient(loadLLMConfigFromEnv());
      } catch {
        console.log('\n======== 语义层（未运行） ========');
        console.log('  ⚠ 未检测到 LLM API Key，语义忠实度校验已跳过');
        console.log('    数据正确性（conditions/level/evidence 是否忠于文档）未验证');
        console.log('    设置 LLM_API_KEY 后重新运行 eval 以获取完整评估');
      }

      if (llm) {
        semanticRan = true;
        console.log('\n======== 忠实度评审（LLM-as-judge 对照文档） ========');
        semanticFailures = await verifySemantics(doc, constraints, llm, engineConfig.sdkName);
        if (semanticFailures.length === 0) {
          console.log('✔ 全部约束与文档原文一致');
        } else {
          for (const f of semanticFailures) {
            console.log(`  ✘ ${f.name}（${f.target}）：${f.issue}`);
          }
        }

        console.log('\n======== 文档差分（oracle 独立判场景 vs 引擎实际判定） ========');
        oracleFailures = await verifyAgainstDoc(doc, constraints, engineConfig, llm);
        if (oracleFailures.length === 0) {
          console.log('✔ oracle 与引擎对所有双确定场景判定一致');
        } else {
          for (const f of oracleFailures) {
            console.log(
              `  ✘ ${f.name}（${f.target}）场景 ${f.scenarioId}：文档判定 ${f.oracle}，引擎实际 ${f.actual}`,
            );
            console.log(`      依据：${f.oracleReason}`);
          }
        }
        logger.info(`语义层消耗 Token：${llm.getTotalTokens()}`);
      }
    }

    // ---------- 总结裁决 ----------
    const coverageOk = coverage.missed.length === 0 && coverage.hallucinated.length === 0;
    const selfCheckOk = selfCheckFailures.length === 0;

    console.log('\n======== Agent 质量评估 ========');
    console.log(
      `  覆盖率        ${coverageRate}` +
        `  （漏提 ${coverage.missed.length} / 幻觉 ${coverage.hallucinated.length}）` +
        `  ${coverageOk ? '✔' : '✘'}`,
    );
    console.log(
      `  引擎自检      ${constraints.length - selfCheckFailures.length}/${constraints.length}` +
        `  ${selfCheckOk ? '✔' : '✘'}`,
    );
    if (opts.noSemantic) {
      console.log('  语义忠实度    ---   ⚠ 已通过 --no-semantic 关闭');
      console.log('  文档差分      ---   ⚠ 已通过 --no-semantic 关闭');
    } else if (!semanticRan) {
      console.log('  语义忠实度    ---   ⚠ 未校验（无 API Key）');
      console.log('  文档差分      ---   ⚠ 未校验（无 API Key）');
    } else {
      console.log(
        `  语义忠实度    ${constraints.length - semanticFailures.length}/${constraints.length}` +
          `  ${semanticFailures.length === 0 ? '✔' : '✘'}`,
      );
      console.log(
        `  文档差分      ${oracleFailures.length === 0 ? '全部一致' : `${oracleFailures.length} 个不一致`}` +
          `  ${oracleFailures.length === 0 ? '✔' : '✘'}`,
      );
    }

    // 裁决：覆盖率 + 引擎自检必须通过；语义层若已运行也必须通过，未运行则标记"部分通过"
    const failReasons: string[] = [];
    if (coverage.missed.length > 0) failReasons.push(`${coverage.missed.length} 条漏提`);
    if (coverage.hallucinated.length > 0)
      failReasons.push(`${coverage.hallucinated.length} 条幻觉`);
    if (selfCheckFailures.length > 0)
      failReasons.push(`${selfCheckFailures.length} 条引擎自检失败`);
    if (semanticRan && semanticFailures.length > 0)
      failReasons.push(`${semanticFailures.length} 条语义忠实度失败`);
    if (semanticRan && oracleFailures.length > 0)
      failReasons.push(`${oracleFailures.length} 个文档差分不一致`);

    if (failReasons.length === 0) {
      if (semanticRan || opts.noSemantic) {
        console.log(`\n  裁决：${opts.noSemantic ? '部分通过' : 'PASS'}`);
      } else {
        console.log('\n  裁决：部分通过（覆盖率 + 引擎自检 OK，数据正确性未验证）');
      }
    } else {
      console.log(`\n  裁决：FAIL`);
      console.log(`  原因：${failReasons.join('；')}`);
      // 列出失败详情
      if (coverage.missed.length > 0) {
        console.log(`    ✘ 漏提：${coverage.missed.join('、')}`);
      }
      if (coverage.hallucinated.length > 0) {
        console.log(`    ✘ 幻觉：${coverage.hallucinated.join('、')}`);
      }
      for (const f of selfCheckFailures) {
        console.log(
          `    ✘ 自检失败 ${f.name}：${f.mismatches.map((m) => `${m.scenarioId}(期望${m.expect}实际${m.actual})`).join('、')}`,
        );
      }
      for (const f of semanticFailures) {
        console.log(`    ✘ 语义失败 ${f.name}（${f.target}）：${f.issue}`);
      }
      for (const f of oracleFailures) {
        console.log(
          `    ✘ 差分失败 ${f.name}（${f.target}）场景 ${f.scenarioId}：文档 ${f.oracle}，引擎 ${f.actual}`,
        );
      }
    }

    // ---------- 输出 + 退出码 ----------
    writeJSON(path.join(outputDir, 'eval-result.json'), {
      coverage,
      engineSelfCheck: {
        total: constraints.length,
        passed: constraints.length - selfCheckFailures.length,
        scenarioTotal,
        failures: selfCheckFailures,
      },
      semantic: {
        enabled: semanticRan,
        skipped: opts.noSemantic ? 'explicit' : !semanticRan ? 'no-api-key' : null,
        fidelityFailures: semanticFailures,
        oracleFailures,
      },
      verdict: failReasons.length === 0 ? 'pass' : 'fail',
      failReasons,
    });

    if (failReasons.length > 0) {
      process.exitCode = 1;
    }
    logger.info(`完整结果：${path.join(outputDir, 'eval-result.json')}\n`);
  });
