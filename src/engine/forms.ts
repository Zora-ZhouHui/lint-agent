// 调用形式目录（CallForm）：把「测试代码长什么样」从字符串拼接里抽出来，做成一份冻结的静态表。
//
// 为什么需要它：synthesizeScenarios 原先只用一种骨架渲染场景
//   import jue from './jue/<V>';  +  if (isIOS) { jue.module.method(); }
// 于是 561 个场景在语法维度上只有 1 种写法——别名导入、解构、早返回、复杂守卫等
// 真实业务写法从未出现在任何场景里，引擎在这些写法上的行为因此完全不被观测。
//
// 设计取舍（两轴分离）：
//   - 决策轴（哪个版本 / 哪个端 / 期望 error|warn|ok）：必须机械生成，保证覆盖率可枚举、可声明。
//   - 形式轴（调用长什么样）：由本文件的冻结目录提供，只改变代码形态，不参与期望计算。
//
// 核心不变量：**形式只改代码形态，不改期望**。
//   resolution: 'same'     → 该形式与规范形式语义等价，期望沿用决策轴算出的值。
//   resolution: 'degraded' → 该形式确实改变了可解析性（如动态 import 使版本不可静态提取），
//                            期望改由 onResolveFail 决定，单独归类，不混入 same 的通过率。
//
// 本目录由 LLM 一次性产出候选、人工确认后冻结；运行时零 LLM 调用，CI 可离线复现。

/** 渲染一个场景所需的全部信息：目标 API 路径、版本、平台守卫变量名（null = 无守卫）。 */
export interface CallFormContext {
  /** SDK 挂载 API 路径，如 jue.system.getSystemInfo */
  target: string;
  /** 版本（import 路径末尾目录名），如 2.25.0 */
  version: string;
  /** 平台守卫布尔变量名，如 isIOS；null 表示该场景不带平台守卫 */
  flag: string | null;
}

export interface CallForm {
  /** 稳定标识，用于场景 id 后缀与报告分组 */
  id: string;
  /** 人读说明 */
  description: string;
  /**
   * same：与规范形式语义等价（同一 API、同一版本、同一个运行端）。
   * degraded：改变了可解析性，期望不能沿用决策轴。
   */
  resolution: 'same' | 'degraded';
  /** 渲染可 lint 的代码；返回 null 表示本形式不适用于该上下文（如无守卫时早返回无意义）。 */
  render(ctx: CallFormContext): string | null;
}

/** 规范形式：项目原有的唯一骨架，必须逐字节保持原样（现有测试与产物依赖它）。 */
export const CANONICAL_FORM: CallForm = {
  id: 'canonical',
  description: 'import jue from ... + if (isFlag) { jue.module.method(); }',
  resolution: 'same',
  render({ target, version, flag }) {
    const importLine = `import jue from './jue/${version}';`;
    const call = `${target}();`;
    if (!flag) return `${importLine}\n${call}\n`;
    return `${importLine}\nif (${flag}) {\n  ${call}\n}\n`;
  },
};

/** SDK 根标识之外的分段，如 jue.system.getSystemInfo → ['system', 'getSystemInfo']。 */
function tailSegments(target: string): string[] {
  return target.split('.').slice(1);
}

/** 把一个调用表达式包进平台守卫（flag 为 null 时不加守卫）。 */
function wrap(importLine: string, body: string, flag: string | null): string {
  if (!flag) return `${importLine}\n${body}\n`;
  return `${importLine}\nif (${flag}) {\n  ${body}\n}\n`;
}

/**
 * 别名导入：import J from './jue/<V>'; J.module.method();
 * 语义与规范形式等价（同一绑定、同一版本、同一端），但根标识不是 sdkName。
 */
export const ALIAS_IMPORT_FORM: CallForm = {
  id: 'alias-import',
  description: 'import J from ... + J.module.method()  (根标识别名)',
  resolution: 'same',
  render({ target, version, flag }) {
    const call = `J.${tailSegments(target).join('.')}();`;
    return wrap(`import J from './jue/${version}';`, call, flag);
  },
};

/**
 * 解构导入：const { module } = jue; module.method();
 * 绑定仍然来自同一 import，但调用链的根不再指向 SDK 标识。
 */
export const DESTRUCTURED_FORM: CallForm = {
  id: 'destructured',
  description: 'const { module } = jue; module.method()  (解构后调用)',
  resolution: 'same',
  render({ target, version, flag }) {
    const segs = tailSegments(target);
    // jue.module.method → 解构出 module 后 module.method()；jue.method → 直接解构出方法名
    const local = segs[0];
    const importLine = `import jue from './jue/${version}';`;
    return wrap(importLine, `const { ${local} } = jue;\n${segs.join('.')}();`, flag);
  },
};

/**
 * 早返回守卫：function run() { if (!isFlag) return; jue.module.method(); }
 * 平台语义与 if (isFlag) { ... } 等价，但守卫是调用点的兄弟语句而非其祖先节点。
 * 无守卫上下文不适用 → 返回 null。
 */
export const EARLY_RETURN_FORM: CallForm = {
  id: 'early-return',
  description: 'function run() { if (!isFlag) return; jue.module.method(); }  (早返回守卫)',
  resolution: 'same',
  render({ target, version, flag }) {
    if (!flag) return null;
    const importLine = `import jue from './jue/${version}';`;
    return `${importLine}\nfunction run() {\n  if (!${flag}) return;\n  ${target}();\n}\n`;
  },
};

/**
 * 嵌套守卫：if (isFlag) { if (someCondition) { jue.module.method(); } }
 * 内层是与平台无关的业务条件，运行端仍由外层平台守卫决定。
 * 无守卫上下文不适用 → 返回 null。
 */
export const NESTED_GUARD_FORM: CallForm = {
  id: 'nested-guard',
  description: 'if (isFlag) { if (ready) { jue.module.method(); } }  (内层非平台条件)',
  resolution: 'same',
  render({ target, version, flag }) {
    if (!flag) return null;
    const importLine = `import jue from './jue/${version}';`;
    return `${importLine}\nif (${flag}) {\n  if (ready) {\n    ${target}();\n  }\n}\n`;
  },
};

/** 内置形式目录。synthesizeScenarios 默认只用 CANONICAL_FORM，需要时显式传入本表。 */
export const BUILTIN_FORMS: readonly CallForm[] = [
  CANONICAL_FORM,
  ALIAS_IMPORT_FORM,
  DESTRUCTURED_FORM,
  EARLY_RETURN_FORM,
  NESTED_GUARD_FORM,
];

/** 除规范形式外的全部内置形式（用于「形式缺口」报告）。 */
export const NON_CANONICAL_FORMS: readonly CallForm[] = BUILTIN_FORMS.filter(
  (f) => f.id !== CANONICAL_FORM.id,
);
