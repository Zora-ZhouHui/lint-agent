// 所有 Prompt 模板集中在这里，每个 prompt 导出为函数，返回 Message[]，由调用方传给 LLMClient
import type { BehaviorFailureDetail, Message } from '../types/index.js';
import { PLATFORM_VALUES } from '../types/index.js';

/** 多行代码块缩进两格，嵌入 prompt 列表项时保持可读。 */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

// ---------- extract_patterns ----------

export function extractPatternsPrompt(doc: string, sdkName: string): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是一个精通 ESLint 规则的跨端开发专家。请从用户提供的团队文档中，提取所有可以转化为 jue SDK 挂载 API 约束的数据行。',
        '',
        '背景：',
        `- jue 是跨端 SDK，\`${sdkName}.xxx\` / \`${sdkName}.module.method\` 是挂载在 jue 之上的 API。`,
        `- 代码中 jue 的导入绑定名统一为 \`${sdkName}\`。`,
        "- 版本来自 `import jue from '.../jue/<版本>'` 路径末尾目录名；平台来自 `if (isIOS)` / `if (environment === 'ios')` 这类运行时守卫。",
        '',
        '要求：',
        '1. 只提取能静态检测的约束（jue 挂载 API 禁用 / 最低版本）。',
        '2. 无法静态检测的语义模式（如 BigInt 作参数、运行时布局、动态拼接路径）→ 不提取，跳过。',
        '3. 每条约束输出一个 JSON 对象，符合 Constraint 结构（见下）。',
        '4. 如果文档里没有可提取的约束，返回空数组 []。',
        '',
        '校验级别映射（按文中标记）：',
        '- `[硬校验]`（平台与版本可确定）→ "level": "error"，"onResolveFail": "warn"',
        '- `[提示]`（天生提醒类：废弃迁移 / 平台差异不确定）→ "level": "warn"，"onResolveFail": "warn"',
        '- `[跳过]`（无法静态检测）→ 不提取',
        '',
        'Constraint 结构（注意：name 与 selector 都已移除，由引擎从 target 机械推导，你不需要输出）：',
        '{',
        '  "target": "该 API 的完整挂载路径，如 jue.system.getSystemInfo、jue.vibrate（与文档一致，勿臆造）",',
        '  "message": "违规时报告给开发者的提示语",',
        '  "conditions": [ ... ],',
        '  "level": "error" 或 "warn",',
        '  "onResolveFail": "warn" 或 "skip",',
        '  "evidence": "文档原文字句引用"',
        '}',
        '',
        'evidence 要求：逐字摘录文档中支撑该约束的那句话（≤100 字），禁止改写、概括或跨段落拼接。',
        'evidence 是这条约束的审计追溯锚点，必须能在文档中原文找到。',
        '',
        `conditions 表示该约束在哪些端、哪些条件下不可用。platform 只能取 ${PLATFORM_VALUES.join(' / ')} 之一：`,
        '- 无条件全端禁用 → "conditions": []',
        '- 某端完全不支持 → { "kind": "unsupported", "platform": "ios" }',
        '- 某端低于某 SDK 版本不可用 → { "kind": "min_version", "platform": "ios", "minVersion": "2.25.0" }',
        '文档说"所有端/全平台 jue ≥ X 才支持"时，表示**四端都要求最低版本**，必须逐端展开成 4 条 min_version：',
        '  [{"kind":"min_version","platform":"h5","minVersion":"X"}, ...android/ios/harmony]',
        '注意：',
        '- "所有端 ≥ X" ≠ conditions: []。空数组的语义是「全端无条件禁用」（任何版本都违规），',
        '  与「版本够就能用」正好相反，写错会把合规调用也拦下。',
        '- "所有端均不支持该 API"（无版本条件）才是 conditions: []。',
        '- 某端"部分机型不支持/需能力探测"→ 属提示类，用 level: "warn"，不要写成全端硬门槛。',
        '',
        'target 格式要求：',
        `- 2 段（无模块名）：${sdkName}.method，如 jue.vibrate`,
        `- 3 段（有模块名）：${sdkName}.module.method，如 jue.system.getSystemInfo`,
        '- 最多 3 段，不支持 4 段及以上路径',
        '- target 必须与文档中出现的 API 路径完全一致，勿臆造',
        '',
        'minVersion 直接取自文档中出现的 SDK 版本号/目录名（如 2.25.0），不要臆造。',
        '',
        '以下是几个提取示例：',
        '',
        '示例 1（2 段路径 + min_version）：',
        '文档片段：「jue.vibrate() [硬校验] iOS 需 2.25.0 以上版本」',
        '输出：',
        '[{"target":"jue.vibrate","message":"iOS 需 jue ≥ 2.25.0","conditions":[{"kind":"min_version","platform":"ios","minVersion":"2.25.0"}],"level":"error","onResolveFail":"warn","evidence":"jue.vibrate() [硬校验] iOS 需 2.25.0 以上版本"}]',
        '',
        '示例 2（3 段路径 + 多端 min_version）：',
        '文档片段：「jue.system.getSystemInfo() [硬校验] Android ≥ 2.10.0、iOS ≥ 2.25.0」',
        '输出：',
        '[{"target":"jue.system.getSystemInfo","message":"Android 需 jue ≥ 2.10.0、iOS 需 jue ≥ 2.25.0","conditions":[{"kind":"min_version","platform":"android","minVersion":"2.10.0"},{"kind":"min_version","platform":"ios","minVersion":"2.25.0"}],"level":"error","onResolveFail":"warn","evidence":"jue.system.getSystemInfo() [硬校验] Android ≥ 2.10.0、iOS ≥ 2.25.0"}]',
        '',
        '示例 3（无法静态检测 → 跳过，不提取）：',
        '文档片段：「jue.xxx(path) 当 path 为动态拼接时需校验 [跳过]」',
        '输出：[]',
        '',
        '只输出 JSON 数组，不要输出任何解释或 markdown 标记。',
      ].join('\n'),
    },
    { role: 'user', content: `文档内容：\n${doc}\n\n输出格式：JSON 数组` },
  ];
}

// ---------- heal_missed（自纠错：补提取漏掉的 API） ----------

export function healMissedPrompt(missedApis: string[], doc: string, sdkName: string): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是跨端约束提取专家。上一轮提取遗漏了以下 API，请从文档中找到它们对应的约束并输出。',
        '',
        `遗漏的 API（共 ${missedApis.length} 条）：`,
        ...missedApis.map((api) => `- ${api}`),
        '',
        '提取规则与 Constraint 结构：',
        `- target 必须以 ${sdkName} 开头，2 或 3 段路径；name 与 selector 都不需要输出（由引擎从 target 推导）`,
        '- level / onResolveFail 按文档标注填写：`[硬校验]`→error+warn，`[提示]`→warn+warn，`[跳过]`→不提取',
        '',
        '每条约束必须输出以下字段（缺一不可，缺 message 会导致整批 schema 校验失败作废）：',
        '- "target": API 完整挂载路径',
        '- "message": 违规时报告给开发者的提示语（一句话，含版本/平台要求），**必填**',
        '- "conditions": 见下方规则',
        '- "level" / "onResolveFail": 按上方标注映射',
        '- "evidence": 逐字摘录文档中支撑该约束的原句，禁止改写拼接',
        '',
        'conditions 必须严格使用下面两种形态之一（其它写法都会导致整批校验失败）：',
        '- 某端完全不支持 → { "kind": "unsupported", "platform": "ios" }',
        '- 某端低于某版本才可用 → { "kind": "min_version", "platform": "ios", "minVersion": "2.25.0" }',
        `platform 只能取 ${PLATFORM_VALUES.join(' / ')}，不存在 "all"；minVersion 只写版本号本身（如 2.25.0），不要写 ">=2.25.0"。`,
        '文档说「所有端/全平台 jue ≥ X 才支持」→ 逐端展开成 4 条 min_version（h5/android/ios/harmony）；',
        '只有「所有端均不支持、无版本条件」才是 "conditions": []（空数组 = 全端无条件禁用）。',
        '某端「部分机型不支持 / 需能力探测后降级」→ 属提示类：level 用 "warn"、conditions 用 []，',
        '不要写成 unsupported 全端硬门槛（那会把该端所有调用都拦下）。',
        '',
        '文档内容：',
        doc,
        '',
        '只输出这些遗漏 API 对应的 JSON 约束数组，不要包含已有约束，不要输出解释。',
      ].join('\n'),
    },
  ];
}

// ---------- heal_behavior（自纠错：修正引擎自检失败的约束） ----------

export function healBehaviorPrompt(
  failures: BehaviorFailureDetail[],
  doc: string,
  sdkName: string,
): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是跨端约束提取专家。以下约束在引擎自检中失败（真实 ESLint 对场景代码的判定与约束数据期望不一致），请结合失败上下文修正后重新输出。',
        '',
        `sdkName：${sdkName}`,
        '',
        '失败的约束（含完整数据、不匹配场景代码与期望/实际差异）：',
        ...failures.map((f) => {
          const lines = [
            `- name: ${f.name}`,
            `  target: ${f.target}`,
            `  失败原因: ${f.reason}`,
            `  原始约束: ${JSON.stringify({
              target: f.target,
              conditions: f.conditions,
              level: f.level,
              onResolveFail: f.onResolveFail,
            })}`,
          ];
          for (const m of f.mismatches) {
            lines.push(
              `  场景 ${m.scenarioId}（期望 ${m.expect}，实际 ${m.actual}）：\n${indent(m.code)}`,
            );
          }
          return lines.join('\n');
        }),
        '',
        '常见失败原因及修正方式：',
        '- target 段数错误（应为 2 或 3 段）→ 修正 target',
        '- conditions 中的 platform 或 minVersion 与文档不一致 → 重新对照文档',
        '- level 设置不当 → 检查文档标注是 [硬校验] 还是 [提示]',
        '- onResolveFail 设置不当 → 检查无守卫场景应降级为 warn 还是 skip',
        '',
        '请输出修正后的完整 JSON 约束数组（只包含需要修正的约束），不要输出解释。',
        '每条必须含字段：target / message（违规提示语，必填，缺了整批作废）/ conditions / level / onResolveFail / evidence；name 与 selector 不要输出。',
      ].join('\n'),
    },
    { role: 'user', content: `文档内容（修正必须忠实于它）：\n${doc}` },
  ];
}

// ---------- oracle_behavior（文档差分：独立第二意见，看不到任何约束数据） ----------

/** 送给 oracle 的场景视图：只有业务代码 + 人读上下文，绝不含约束期望/conditions。 */
export interface OracleScenarioView {
  /** 中性数字 id（如 scene-3）；禁止使用约束名，避免把提取结论泄漏给 oracle */
  id: string;
  /** 场景代码（与喂给引擎 Linter 的完全一致） */
  code: string;
  /** 人读上下文：SDK 版本与运行端，帮助 oracle 不必自行解析守卫 */
  version: string;
  platform: string;
}

/**
 * 文档差分 oracle：只给文档 + 具体业务代码场景，让 LLM 以独立第二意见判定
 * 每段代码在指定 SDK 版本/端下是否真的有问题。
 *
 * 关键：prompt 中不出现任何提取出的约束数据（conditions / level / 期望），
 * 从根上消除「看着数据评审数据」的锚定偏差——它的判定与引擎结果同源度为零，
 * 差分不一致才意味着「数据自洽但与文档不符」。
 *
 * 两道加固（不依赖换模型）：
 * 1. `doc` 由调用方收窄成「该 API 条目 + 全局约定」，切断与提取链共享的全文语境；
 * 2. 强制「先逐字引用原句、再判定」——引不出就是 unclear，引用由调用方逐字校验。
 */
export function oracleJudgePrompt(batch: OracleScenarioView[], doc: string): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是严格的跨端 SDK 评审员。我会给你团队文档节选和若干段真实业务代码，每段代码标注了使用的 SDK 版本与运行端（H5 / Android / iOS / 鸿蒙）。',
        '请只依据我给的文档节选，独立判断每段代码调用该 API 在该版本、该端下是否会出问题。你看不到任何自动生成的规则，禁止猜测规则意图，只回答文档怎么说。',
        '',
        '判定方法（必须严格按此两步，不允许先给结论再补依据）：',
        '第一步：在文档节选中找出与该 API、该端、该版本相关的原句，逐字摘录到 cite 字段。不得改写、拼接、概括、补全。',
        '第二步：只依据这句引用做判定。引不出原句时，说明文档没有提供依据，verdict 必须是 "unclear"。',
        '',
        '判定四态：',
        '- "error"：文档明确该端不支持该 API，或该端要求的最低 SDK 版本高于代码所用版本 → 静态检查必须报错拦截。',
        '- "warn"：文档只有废弃、迁移提醒或跨端语义不确定的提示，没有硬性的版本/端门槛 → 应提醒但不拦截。',
        '- "ok"：文档表明该端在该版本下可用（或文档明确全端支持）→ 应放行。',
        '- "unclear"：文档完全没有提到这个 API，或没说清这个端/版本组合 → 无法判断（不要猜）。',
        '',
        '版本比较以文档给出的最低版本为准：代码版本 ≥ 最低版本才算可用。',
        '每段代码都有平台守卫（如 if (isIOS)），表示该调用只会在标注的端上执行。',
        '',
        '输出 JSON 数组，每个输入场景对应一个判定：',
        '[{ "id": "场景 id", "verdict": "error|warn|ok|unclear", "cite": "文档原句逐字摘录", "reason": "一句话说明依据" }]',
        '',
        '必须覆盖输入的每个场景（id 一一对应），不要遗漏、不要新增。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `场景列表（共 ${batch.length} 个）：`,
        ...batch.map(
          (s) =>
            `### ${s.id}\n版本：${s.version}　运行端：${s.platform}\n代码：\n${s.code.trimEnd()}`,
        ),
        '',
        `文档节选：\n${doc}`,
      ].join('\n\n'),
    },
  ];
}

// ---------- judge_semantics（LLM-as-judge：约束是否忠实于文档） ----------

/** judge 评审的约束视图：只暴露判定所需字段，不含 message / selector 等无关信息。 */
export interface JudgeConstraintView {
  name: string;
  target: string;
  evidence: string;
  conditions: unknown;
  level: string;
}

export function judgeSemanticsPrompt(
  batch: JudgeConstraintView[],
  doc: string,
  sdkName: string,
): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是严格的跨端约束评审员。下面给出从文档自动提取的约束数据行，请逐条对照文档节选，判定约束是否忠实于文档。',
        '',
        `sdkName：${sdkName}`,
        '',
        '逐条检查四个方面：',
        '1. conditions 忠实性：每个 { kind, platform, minVersion } 都必须有文档原文支撑——platform 不是文档说的端、minVersion 数字与文档不符，都判 ok=false。',
        '2. level 一致性：文档标注 [硬校验] 应为 "error"，[提示] 应为 "warn"。',
        '   但若正文语义与标题标签矛盾（如标题写 [硬校验]，正文却写“部分机型不支持 / 需能力探测后降级”），以正文语义为准，该提示类场景按 warn 判通过。',
        '3. evidence 真实性：evidence 必须能在文档中逐字找到；找不到（改写/拼接/编造）判 ok=false。',
        '4. target 一致性：target 必须与文档中的 API 路径完全一致。',
        '',
        '判定尺度：只报告有据可查的偏差，不要因为「文档没写清楚」而臆测；拿不准时判 ok=true 并在 issue 里说明不确定点。',
        '',
        '输出 JSON 数组，每条输入约束对应一个判定对象：',
        '[{ "name": "约束名", "ok": true|false, "issue": "ok=false 时的具体偏差说明（引用文档原文对比）" }]',
        '',
        '必须覆盖输入列表中的每一条约束（name 一一对应），不要遗漏、不要新增。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `待评审约束（共 ${batch.length} 条）：\n${JSON.stringify(batch, null, 2)}\n\n文档节选（只含本批约束涉及的条目与全局约定）：\n${doc}`,
    },
  ];
}

// ---------- heal_semantics（自纠错：修正语义评审失败的约束） ----------

export function healSemanticsPrompt(
  failures: { name: string; target: string; issue: string }[],
  doc: string,
  sdkName: string,
): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是跨端约束提取专家。以下约束在语义评审中被评为「与文档原文不符」，请对照评审意见与文档原文修正后重新输出。',
        '',
        `sdkName：${sdkName}`,
        '',
        '被评审判失败的约束与评审意见：',
        ...failures.map((f) => `- name: ${f.name}\n  target: ${f.target}\n  评审意见: ${f.issue}`),
        '',
        '修正要求：',
        '- conditions / level / evidence 必须严格以文档原文为准；evidence 逐字摘录，禁止改写。',
        '- 若评审意见指出的问题实际不存在（评审误判），原样重新输出该约束即可。',
        '',
        '只输出修正后的完整 JSON 约束数组（只包含被点名修正的约束），不要输出解释。',
        '每条必须含字段：target / message（违规提示语，必填，缺了整批作废）/ conditions / level / onResolveFail / evidence；name 与 selector 不要输出。',
      ].join('\n'),
    },
    { role: 'user', content: `文档内容：\n${doc}` },
  ];
}

// ---------- heal_versions（自纠错：修正 minVersion 不在版本清单的约束） ----------

/**
 * 修正「minVersion 不在版本清单」的约束。
 *
 * 这类缺陷有两种成因，必须在 prompt 里讲清，否则模型会盲目改数据：
 *   (a) 版本号抄错 —— 文档写 2.12.0，抄成 2.6.1（此时应改成文档里的正确值）；
 *   (b) 文档确实引入了清单外的新版本（此时数据可能是对的，需人工补 engine-config 的 order）。
 * 因此这里把「合法版本清单」直接给模型，并要求它只在文档原文支持另一个清单内版本时才改。
 */
export function healVersionsPrompt(
  problems: { name: string; target: string; platform: string; minVersion: string }[],
  order: string[],
  doc: string,
  sdkName: string,
): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是跨端约束提取专家。以下约束的 minVersion 不在项目的合法版本清单中，请对照文档原文处理。',
        '',
        `sdkName：${sdkName}`,
        `合法版本清单（升序，minVersion 必须取自此清单）：${order.join(' < ')}`,
        '',
        '出问题的约束：',
        ...problems.map(
          (p) => `- name: ${p.name}\n  target: ${p.target}\n  ${p.platform} 端要求 ${p.minVersion}`,
        ),
        '',
        '处理规则（按顺序判断）：',
        '1. 先回到文档原文核对这一条的最低版本要求；',
        '2. 若文档写的版本是清单里的另一个值（即之前抄错了）→ 按文档原文改成那个值；',
        '3. 若文档原文确实写的就是这个清单外的版本 → **原样重新输出该约束**，不要为了迎合清单而篡改版本号，',
        '   这种情形属于「版本清单需要补充」，由人工处理，不属于数据错误。',
        '',
        '只输出处理后的完整 JSON 约束数组（只包含被点名的约束），不要输出解释。',
        '每条必须含字段：target / message（违规提示语，必填，缺了整批作废）/ conditions / level / onResolveFail / evidence；name 与 selector 不要输出。',
      ].join('\n'),
    },
    { role: 'user', content: `文档内容：\n${doc}` },
  ];
}
