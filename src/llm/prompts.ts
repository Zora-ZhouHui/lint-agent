// 所有 Prompt 模板集中在这里（关键要求 7：Prompt 独立，不在 Skill/Agent 里硬编码）
// 每个 prompt 导出为一个函数，返回 Message[]，由调用方直接传给 LLMClient
import type { Message } from '../types/index.js';
import { PLATFORM_VALUES } from '../types/index.js';

export interface PlannerPromptState {
  constraintCount: number;
  failedCount: number;
}

export interface ReflectorPromptState {
  constraintCount: number;
  failedCount: number;
}

// ---------- 1. extract_patterns ----------

export function extractPatternsPrompt(doc: string): Message[] {
  return [
    {
      role: 'system',
      content: [
        '你是一个精通 ESLint 规则的跨端开发专家。请从用户提供的团队文档中，提取所有可以转化为 jue SDK 挂载 API 约束的数据行。',
        '',
        '背景：',
        '- jue 是跨端 SDK，`jue.xxx` / `jue.module.method` 是挂载在 jue 之上的 API。',
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
        'Constraint 结构：',
        '{',
        '  "name": "kebab-case 约束名，如 no-system-getsysteminfo",',
        '  "selector": "esquery AST selector，精确匹配该 jue API 的调用/成员访问节点（根标识为 jue，见示例）",',
        '  "message": "违规时报告给开发者的提示语",',
        '  "conditions": [ ... ],',
        '  "level": "error" 或 "warn",',
        '  "onResolveFail": "warn" 或 "skip"',
        '}',
        '',
        `conditions 表示该约束在哪些端、哪些条件下不可用。platform 只能取 ${PLATFORM_VALUES.join(' / ')} 之一：`,
        '- 无条件全端禁用 → "conditions": []',
        '- 某端完全不支持 → { "kind": "unsupported", "platform": "ios" }',
        '- 某端低于某 SDK 版本不可用 → { "kind": "min_version", "platform": "ios", "minVersion": "2.25.0" }',
        '文档说"所有端/全平台"时，conditions 固定输出 []（无条件全禁）。',
        '',
        'selector 写法要点：精确匹配 jue 挂载 API 的调用节点，根标识固定为 jue。示例：',
        '- jue.system.getSystemInfo() → CallExpression[callee.object.object.name="jue"][callee.object.property.name="system"][callee.property.name="getSystemInfo"]',
        '- jue.network.request() → CallExpression[callee.object.object.name="jue"][callee.object.property.name="network"][callee.property.name="request"]',
        '- jue.device.getDeviceId() → CallExpression[callee.object.object.name="jue"][callee.object.property.name="device"][callee.property.name="getDeviceId"]',
        '第二层挂载（无 module）时去掉 object.property 层，如 jue.vibrate() → CallExpression[callee.object.name="jue"][callee.property.name="vibrate"]。',
        'selector 只用于匹配违规节点；限制条件（如"带 async 回调"）仍放 message 语义里。',
        '',
        'minVersion 直接取自文档中出现的 SDK 版本号/目录名（如 2.25.0），不要臆造。',
        '只输出 JSON 数组，不要输出任何解释或 markdown 标记。',
      ].join('\n'),
    },
    { role: 'user', content: `文档内容：\n${doc}\n\n输出格式：JSON 数组` },
  ];
}

// ---------- 2. planner ----------

export function plannerPrompt(state: PlannerPromptState): Message[] {
  return [
    {
      role: 'system',
      content: '你是一个 Agent 的规划器。根据当前状态，决定下一步该做什么。',
    },
    {
      role: 'user',
      content: [
        '当前状态：',
        `- 已提取的约束数：${state.constraintCount}`,
        `- 失败数：${state.failedCount}`,
        '',
        '可用动作：',
        '- extract_patterns: 从文档提取约束（仅当尚未提取时可用）',
        '- finish: 结束（已提取）',
        '',
        '说明：执行器会根据当前状态自动选择待处理目标，所以 actionInput 传空对象 {} 即可。',
        '',
        '请输出 JSON：',
        '{',
        '  "thought": "你的推理过程",',
        '  "action": "动作名",',
        '  "actionInput": {}',
        '}',
      ].join('\n'),
    },
  ];
}

// ---------- 3. reflector ----------

export function reflectorPrompt(state: ReflectorPromptState): Message[] {
  return [
    {
      role: 'system',
      content: '你是一个 Agent 的反思器。判断当前任务是否完成。',
    },
    {
      role: 'user',
      content: [
        '当前状态：',
        `- 约束总数：${state.constraintCount}`,
        `- 失败数：${state.failedCount}`,
        '',
        '判断标准：',
        '文档已尝试提取过约束（无论提取到几条）→ done，否则 → 继续。',
        '',
        '请输出 JSON：',
        '{',
        '  "done": true 或 false,',
        '  "reason": "判断理由"',
        '}',
      ].join('\n'),
    },
  ];
}
