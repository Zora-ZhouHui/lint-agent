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
import {
  severityOf,
  synthesizeScenarios,
  unverifiedMinVersions,
  type EngineScenario,
  uncoveredPlatforms,
  type ScenarioExpect,
} from '../../engine/behavior.js';
import { LLMClient, loadLLMConfigFromEnv } from '../../llm/client.js';
import { verifySemantics } from '../../agent/judge.js';
import { verifyAgainstDoc } from '../../agent/oracle.js';
import { logger } from '../../utils/logger.js';
import { readFileText, writeJSON } from '../../utils/file.js';

interface EvalOptions {
  from: string;
  output: string;
  config?: string;
  /**
   * commander 的 `--no-semantic` 会映射成 `semantic: false`（默认 true）。
   * 注意不要写成 `noSemantic` —— 那个字段在 commander 里根本不会被赋值，
   * 会导致「关闭语义层」的开关静默失效（曾经的真实 bug）。
   */
  semantic?: boolean;
  narrowContext?: boolean;
}

const linter = new Linter({ configType: 'flat' });

/** 把 Linter 消息归约为 error / warn / ok 三态。 */
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

/**
 * 引擎自检：一条约束的全部场景逐个跑真实 Linter，返回不匹配场景（null=通过）。
 *
 * 场景由调用方传入而不是在内部现算：`synthesizeScenarios` 是纯函数，
 * 原本调用方为统计场景总数又算了一遍，84 条约束下等于白算 460 个场景。
 */
function selfCheckConstraint(
  constraint: Constraint,
  config: EngineConfig,
  scenarios: EngineScenario[],
): SelfCheckFailure | null {
  const lintConfig = buildUnsupportedApiConfig([constraint], config);
  const mismatches: SelfCheckFailure['mismatches'] = [];
  for (const scenario of scenarios) {
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
  .option(
    '--no-narrow-context',
    '不做输入视角收窄：把整篇文档喂给复判端（默认收窄为「该 API 条目 + 全局约定」，用于对比）',
  )
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
    // 零覆盖端：配置缺该端守卫时场景被静默跳过，分母随之缩小——
    // 不显式上报的话，「N/N 通过」会掩盖某端一个场景都没跑。
    const uncovered: { name: string; target: string; platforms: string[] }[] = [];
    for (const c of constraints) {
      // 只合成一次：既用于统计场景总数，也用于跑自检（纯函数，无需重算）
      const scenarios = synthesizeScenarios(c, engineConfig);
      scenarioTotal += scenarios.length;
      const missing = uncoveredPlatforms(c, engineConfig);
      if (missing.length > 0)
        uncovered.push({ name: c.name, target: c.target, platforms: missing });
      const failure = selfCheckConstraint(c, engineConfig, scenarios);
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
    // 归因检查：minVersion 必须存在于版本清单，否则自检给的失败归因是错的
    // （会显示「期望 ok 实际 error」把方向引向 selector，真因是清单缺项或版本抄错）。
    const unverified = unverifiedMinVersions(constraints, engineConfig);
    if (unverified.length > 0) {
      console.log(
        `\n  ✘ ${unverified.length} 处 minVersion 不在版本清单中 → 该约束在已知版本空间内未被正向验证，` +
          '下方自检失败的归因不可信（真因是清单缺项或版本号抄错）',
      );
      console.log(`      版本清单：${engineConfig.order.join(' < ')}`);
      for (const u of unverified.slice(0, 10)) {
        console.log(`      ${u.target}：${u.platform} 端要求 ${u.minVersion}（不在清单中）`);
      }
      if (unverified.length > 10) console.log(`      …… 另有 ${unverified.length - 10} 处`);
      console.log(
        '      修法二选一：① 文档确实引入了新版本 → 补进 output/engine-config.json 的 order；' +
          '② LLM 抄错版本 → 修约束数据',
      );
    }
    if (uncovered.length > 0) {
      const platforms = [...new Set(uncovered.flatMap((u) => u.platforms))];
      console.log(
        `  ⚠ ${uncovered.length} 条约束存在零覆盖端（${platforms.join('/')}）：引擎配置缺对应布尔守卫，` +
          '这些端一个场景都没跑，未计入分母',
      );
      for (const u of uncovered.slice(0, 5)) {
        console.log(`      ${u.target}：${u.platforms.join('/')}`);
      }
    }
    console.log('  ┌────────────────────────────────────────────────────────┐');
    console.log('  │ ⚠ 自检只验引擎接线（selector/scope/severity）         │');
    console.log('  │ 数据正确性（平台/版本是否忠于文档）由语义层负责       │');
    console.log('  └────────────────────────────────────────────────────────┘');

    // ---------- 第三层：语义层（默认开启，需 LLM API Key） ----------
    let semanticFailures: { name: string; target: string; issue: string }[] = [];
    let oracleFailures: OracleFailure[] = [];
    let semanticRan = false;
    // 批次执行状态：只有「成功跑过且没有失败批次」才算真正校验过。
    // 缺了它，「一批都没成功」与「全部一致」在报告上完全一样（见 types CheckOutcome）。
    let semanticBatches = { ok: 0, failed: 0 };
    let oracleBatches = { ok: 0, failed: 0 };
    // 加固生效情况（收窄模式 / unclear / 幻觉引用 / 无法提取路径）——落到结果文件里，
    // 让「差分通过」是可审计的通过，而不是把退化藏起来。
    let oracleStats = {
      contextMode: 'narrow' as 'narrow' | 'full',
      unclear: 0,
      invalidCitations: 0,
      unresolvedTargets: 0,
    };

    if (opts.semantic === false) {
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
        const semanticCheck = await verifySemantics(doc, constraints, llm, engineConfig.sdkName);
        semanticFailures = semanticCheck.failures;
        semanticBatches = { ok: semanticCheck.okBatches, failed: semanticCheck.failedBatches };
        const judgeIncomplete =
          constraints.length > 0 &&
          (semanticCheck.failedBatches > 0 || semanticCheck.okBatches === 0);
        if (judgeIncomplete) {
          console.log(
            `⚠ 评审未完成（成功 ${semanticCheck.okBatches} 批 / 失败 ${semanticCheck.failedBatches} 批）` +
              '——本次结论不可信，不计为「通过」',
          );
        } else if (semanticFailures.length === 0) {
          console.log('✔ 全部约束与文档原文一致');
        }
        for (const f of semanticFailures) {
          console.log(`  ✘ ${f.name}（${f.target}）：${f.issue}`);
        }

        console.log('\n======== 文档差分（oracle 独立判场景 vs 引擎实际判定） ========');
        // 输入视角收窄（默认）：只把场景涉及的 API 条目 + 全局约定交给 oracle，
        // 切断与提取链共享的全文语境；--no-narrow-context 可退回全文做对比。
        const oracleCheck = await verifyAgainstDoc(doc, constraints, engineConfig, llm, {
          contextMode: opts.narrowContext === false ? 'full' : 'narrow',
        });
        oracleFailures = oracleCheck.failures;
        oracleBatches = { ok: oracleCheck.okBatches, failed: oracleCheck.failedBatches };
        oracleStats = {
          contextMode: oracleCheck.contextMode,
          unclear: oracleCheck.unclearScenarios,
          invalidCitations: oracleCheck.invalidCitations,
          unresolvedTargets: oracleCheck.unresolvedTargets,
        };
        console.log(
          `  上下文：${
            oracleCheck.contextMode === 'narrow'
              ? '收窄（仅该 API 条目 + 全局约定）'
              : '全文（含退回全文的批次）'
          }　引用先行：开启（引用须逐字存在，否则按 unclear 作废）`,
        );
        if (oracleCheck.failedBatches > 0) {
          console.log(
            `⚠ 差分未完成：${oracleCheck.failedBatches} 批调用失败（成功 ${oracleCheck.okBatches} 批）` +
              '——失败批次覆盖的场景未被校验，不计为「一致」',
          );
        } else if (oracleFailures.length === 0) {
          console.log('✔ oracle 与引擎对所有双确定场景判定一致');
        }
        if (oracleCheck.invalidCitations > 0) {
          console.log(
            `  ⚠ ${oracleCheck.invalidCitations} 个场景的引用无法在文档片段中逐字找到` +
              '（幻觉引用），已按 unclear 作废',
          );
        }
        if (oracleCheck.unresolvedTargets > 0) {
          console.log(
            `  ⚠ ${oracleCheck.unresolvedTargets} 个场景未能从代码提取 API 路径，已退回全文上下文`,
          );
        }
        if (oracleCheck.unclearScenarios > 0) {
          console.log(
            `  文档未说清（unclear，含引用作废）跳过 ${oracleCheck.unclearScenarios} 个场景`,
          );
        }
        for (const f of oracleFailures) {
          console.log(
            `  ✘ ${f.name}（${f.target}）场景 ${f.scenarioId}：文档判定 ${f.oracle}，引擎实际 ${f.actual}`,
          );
          console.log(`      依据：${f.oracleReason}`);
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
        (unverified.length > 0 ? `（另 ${unverified.length} 处版本清单缺项）` : '') +
        `  ${selfCheckOk ? '✔' : '✘'}`,
    );
    if (opts.semantic === false) {
      console.log('  语义忠实度    ---   ⚠ 已通过 --no-semantic 关闭');
      console.log('  文档差分      ---   ⚠ 已通过 --no-semantic 关闭');
    } else if (!semanticRan) {
      console.log('  语义忠实度    ---   ⚠ 未校验（无 API Key）');
      console.log('  文档差分      ---   ⚠ 未校验（无 API Key）');
    } else {
      // 批次全挂时不能再显示 "N/N" 或 "全部一致"——那正是「什么都没验却报通过」
      const judgeCount =
        semanticBatches.ok === 0
          ? '---'
          : `${constraints.length - semanticFailures.length}/${constraints.length}`;
      const judgeState =
        semanticBatches.ok === 0
          ? '⚠ 未完成'
          : semanticBatches.failed > 0
            ? '⚠ 部分完成'
            : semanticFailures.length === 0
              ? '✔'
              : '✘';
      const oracleCount =
        oracleBatches.ok === 0
          ? '---'
          : oracleFailures.length === 0
            ? '全部一致'
            : `${oracleFailures.length} 个不一致`;
      const oracleState =
        oracleBatches.ok === 0
          ? '⚠ 未完成'
          : oracleBatches.failed > 0
            ? '⚠ 部分完成'
            : oracleFailures.length === 0
              ? '✔'
              : '✘';
      console.log(
        `  语义忠实度    ${judgeCount}` +
          `（批次 ${semanticBatches.ok} 成功 / ${semanticBatches.failed} 失败）  ${judgeState}`,
      );
      console.log(
        `  文档差分      ${oracleCount}` +
          `（批次 ${oracleBatches.ok} 成功 / ${oracleBatches.failed} 失败）  ${oracleState}`,
      );
    }

    // 裁决：覆盖率 + 引擎自检必须通过；语义层若已运行也必须通过，未运行则标记"部分通过"
    const failReasons: string[] = [];
    if (coverage.missed.length > 0) failReasons.push(`${coverage.missed.length} 条漏提`);
    if (coverage.hallucinated.length > 0)
      failReasons.push(`${coverage.hallucinated.length} 条幻觉`);
    if (selfCheckFailures.length > 0)
      failReasons.push(`${selfCheckFailures.length} 条引擎自检失败`);
    if (unverified.length > 0)
      failReasons.push(`${unverified.length} 处 minVersion 不在版本清单（约束未被验证）`);
    if (semanticRan && semanticFailures.length > 0)
      failReasons.push(`${semanticFailures.length} 条语义忠实度失败`);
    if (semanticRan && oracleFailures.length > 0)
      failReasons.push(`${oracleFailures.length} 个文档差分不一致`);
    // 批次失败必须进入裁决：否则「校验器一批都没成功」会被当成「没有问题」
    if (semanticRan && semanticBatches.failed > 0)
      failReasons.push(`忠实度评审 ${semanticBatches.failed} 批调用失败（结论不完整）`);
    if (semanticRan && constraints.length > 0 && semanticBatches.ok === 0)
      failReasons.push('忠实度评审 0 批成功（数据正确性实际未校验）');
    if (semanticRan && oracleBatches.failed > 0)
      failReasons.push(`文档差分 ${oracleBatches.failed} 批调用失败（结论不完整）`);

    if (failReasons.length === 0) {
      if (semanticRan || opts.semantic === false) {
        console.log(`\n  裁决：${opts.semantic === false ? '部分通过' : 'PASS'}`);
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
      for (const u of unverified) {
        console.log(
          `    ✘ 版本清单缺项 ${u.target}：${u.platform} 端要求 ${u.minVersion}（不在 order 清单中）`,
        );
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
        // 归因检查：不在版本清单里的 minVersion（该约束未被正向验证）
        unverifiedMinVersions: unverified,
      },
      semantic: {
        enabled: semanticRan,
        skipped:
          opts.semantic === false
            ? 'explicit'
            : !semanticRan
              ? 'no-api-key'
              : semanticBatches.failed > 0 ||
                  (constraints.length > 0 && semanticBatches.ok === 0) ||
                  oracleBatches.failed > 0
                ? 'incomplete'
                : null,
        // 批次执行状态随产物落盘：让「跑了多少 / 挂了多少」可审计，而不是只能看失败数
        batches: { judge: semanticBatches, oracle: oracleBatches },
        // 去相关加固的生效情况：收窄模式 / 引用作废数 / 未提取到路径的场景数
        oracleHardening: {
          contextMode: oracleStats.contextMode,
          citationRequired: true,
          invalidCitations: oracleStats.invalidCitations,
          unclearScenarios: oracleStats.unclear,
          unresolvedTargets: oracleStats.unresolvedTargets,
        },
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
