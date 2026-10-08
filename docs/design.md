# 设计决策记录：jue SDK 约束的「版本解析 + 平台守卫 + 校验级别」

> 本文是对 [README.md](../README.md)「单引擎 + 数据文件」基线的补充决策记录，聚焦新一轮定位后的三个核心问题：**校验对象是 jue SDK 挂载 API、版本来自 import 路径、平台来自运行时守卫**，以及由此引入的**三级校验**。

## 1. 背景与前提修正

早期样例把约束写成 JS 内置 API（`Array.prototype.at`、`?.`、`replaceAll`…），据此曾得出「用 repo 级 `SupportMatrix.target`（每端一个当前 SDK 目录名）判定」的结论。复核真实场景后修正：

- **校验对象不是内置 API，而是 jue SDK 的挂载 API**：`jue.xxx` / `jue.module.method`（多层挂载）。
- **版本不来自 repo 级配置，而来自 import 路径**：`import jue from '.../jue/<版本>'`，版本 = 路径末尾目录名；同一个代码库里可能同时存在多个 jue 版本。
- **平台不是构建目标，而是运行时注入**：`if (isIOS)` / `if (isAndroid)` 这类守护闭包里才确定平台。
- **存在「平台 / 版本不确定」的条目**：不能硬报，只能降级为提示或跳过，但文档必须保留。

因此 `SupportMatrix.target`（「每端一个当前版本」）不再成立，改为**按调用点解析版本 + 按守卫解析平台**。

## 2. 核心决策（一句话）

判定链从「约束 + 全局矩阵」改为「**约束 + 调用点级解析（版本 = import、平台 = 守卫）+ 三级校验（error/warn/skip）**」：

```
命中 selector（根标识为 jue 的调用 / 成员访问）
  ├─ ① 版本解析：scope 追 jue 绑定 → import jue from '.../jue/<V>' → 提取 V
  │        └─ 失败（动态路径 / 全局注入 / 别名）→ 按 onResolveFail 降级
  ├─ ② 平台解析：沿 AST 祖先找守卫（布尔 flag / environment 字符串）→ 推断候选端集合
  │        └─ 失败（无守卫 / 守卫形态不识别）→ 按 onResolveFail 降级
  └─ ③ 判定：拿 (actualVersion, 候选端集合) 调 isViolation；集合内任一端违规即报
           unsupported     → 报
           min_version     → compare(V, minVersion, order) < 0 才报
```

## 3. 数据模型

`Condition` 不变；`Constraint` 增加两个字段表达「级别」与「解析失败降级」：

```ts
type Platform = 'h5' | 'android' | 'ios' | 'harmony';

type Condition =
  | { kind: 'unsupported'; platform: Platform }
  | { kind: 'min_version'; platform: Platform; minVersion: string };

type Level = 'error' | 'warn';
type ResolveFail = 'warn' | 'skip';

interface Constraint {
  name: string; // kebab-case
  selector: string; // 匹配「根标识为 jue 的调用」（不随挂载深度变化）
  message: string;
  conditions: Condition[]; // [] = 全端无条件禁用
  level: Level; // 'error'：硬规则；'warn'：天生提醒类（如废弃迁移提示）
  onResolveFail: ResolveFail; // 版本/平台解析失败时的降级：'warn' | 'skip'
}
```

其中「`[跳过]`」类条目（无法静态检测的语义模式，如 BigInt 作参数、运行时布局）**不被提取成 `Constraint`**，只在文档留档。

引擎运行时配置（取代 `SupportMatrix`）：

```ts
interface EngineConfig {
  sdkName: string; // 追踪的导入绑定名，如 'jue'
  guards: {
    booleanFlags: Record<string, Platform>; // 布尔注入变量：{ isIOS: 'ios', isAndroid: 'android', isHarmony: 'harmony', isH5: 'h5' }
    envVar: string; // 字符串环境变量名，如 'environment'
    envValues: Record<string, Platform>; // envVar 取值 → 端（四端枚举）：{ ios: 'ios', android: 'android', h5: 'h5', harmony: 'harmony' }
  };
  order: string[]; // jue「目录名 → 序号」有序清单（越靠后越新）
}
```

- `target` **废弃**：每端当前版本不再由 repo 配置给出，而是按调用点从 import 解析。
- `order` **单清单**：已确认 jue 使用单一公共版本号空间（各端阈值不同、空间相同，如 `iOS ≥ 2.25.0`、`Android ≥ 2.10.0`）。多版本共存不影响该清单（见 §4）。

## 4. 版本解析器（import → 版本）

对命中节点，从根标识（`jue`）出发：

1. 用 ESLint scope 追 `jue` 的 binding，找其 `ImportBinding` 定义。
2. 取 `ImportDeclaration.source.value`（如 `'src/jue/2.25.0'`），按约定从路径末尾提取目录名 `2.25.0`。

失败情形与降级（对应样例 #95–#100）：

| 失败情形            | 示例                               | 降级                               |
| ------------------- | ---------------------------------- | ---------------------------------- |
| import 路径动态拼接 | `import jue from \`.../jue/${v}\`` | `skip`（版本根本不可静态提取）     |
| 全局注入、无 import | 未显式 import jue                  | `warn`                             |
| 别名引用            | `import jue as j`                  | `warn`（需别名追踪，暂按失败处理） |

**多版本共存**：jue 支持一个应用内多版本共存（页面嵌套页面，各页 import 不同版本），且开发者常意识不到。因版本解析按调用点逐次进行，每个调用点天然对照自身 import 的版本，不受共存影响——这正是 `target` 必须废弃、不能用单个全局版本的原因。在此基础上，可加一条 `warn`：同一文件内出现多个不同 jue 版本时提示，把「用户意识不到的多版本」显式暴露出来。

## 5. 平台解析器（守卫 → 候选端集合）

判定对象是「该调用路径可能运行的端集合」，而非单一端。沿 AST 祖先找最近的守卫，支持三种形态：

| 守卫形态                 | 示例                                                        | 推断结果                    |
| ------------------------ | ----------------------------------------------------------- | --------------------------- |
| 布尔注入变量（真值）     | `if (isIOS) { … }`                                          | `{ ios }`                   |
| 字符串环境变量相等       | `if (environment === 'ios')`                                | `{ ios }`                   |
| 多值并集                 | `if (environment === 'ios' \|\| environment === 'android')` | `{ ios, android }`          |
| 取反 / else 分支（补集） | `else`、`if (!isIOS)`、`if (environment !== 'ios')`         | 全集 `\ { ios }` = 其余三端 |

- 判定：`isViolation` 在候选端集合内逐端检查，**任一端违规即报**；补集分支对「非此端」的三端分别检查。
- 首版从**最近一层**守卫推断；多层嵌套守卫的组合（交集）属后续增强。
- 配置（§3）同时提供 `booleanFlags` 与 `envVar + envValues` 两类映射，`environment` 取值枚举为四端。

失败情形与降级：

| 失败情形                                                        | 降级                                       |
| --------------------------------------------------------------- | ------------------------------------------ |
| 调用不在任何平台守卫闭包内                                      | `warn`（jue 调用可被点到，应提示而非跳过） |
| 守卫形态不识别（复杂布尔 / 解构取 flag / 无法判定 envVar 取值） | `warn`                                     |

## 6. 校验级别与最终 severity

| 条件                                         | 结果                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| `level='error'` 且版本、平台均解析成功且违规 | report **error**                                          |
| `level='error'` 但解析失败                   | `onResolveFail='warn'` → report **warn**；`'skip'` → 不报 |
| `level='warn'`（天生提醒类）                 | 一律 report **warn**                                      |

「规则命中但解析失败」不再静默跳过，而是按 `onResolveFail` 显式降级，杜绝漏报。

## 7. 与现有实现的差距

| 现状（已实现）                                                 | 目标                                                            | 改动                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `isViolation(conditions, matrix)` 用 `matrix.target[p]` 比版本 | 按调用点传 `(actualVersion, platform, order)`                   | 改 `isViolation` 签名与实现                             |
| `SupportMatrix { target, order }`                              | `EngineConfig { sdkName, platformFlags, order }`                | 类型 + schema + 落地读取                                |
| `createUnsupportedApiRule` 只按 selector 分组 report           | visitor 内做版本/平台解析，按 level/onResolveFail 决定 severity | 引入 `context.sourceCode` scope/祖先遍历                |
| `Constraint` 无 level                                          | 增加 `level` / `onResolveFail` 字段                             | schema + 提取 prompt                                    |
| —                                                              | `[跳过]` 条目识别为「不产出约束」                               | extract-patterns prompt 增加「不可静态检测 → 跳过」指令 |

## 8. 落地顺序

1. 类型与 schema：`Constraint` 加 `level`/`onResolveFail`，`EngineConfig` 取代 `SupportMatrix`，`isViolation` 改签名。
2. 版本解析器 + 平台解析器（纯函数层，先脱离 ESLint 可单测）。
3. `createUnsupportedApiRule` 接入 scope / 祖先解析与 severity 决策。
4. `extract-patterns` prompt 增加 `selector`（根标识 jue）+ `level`/`onResolveFail` + 「跳过不可静态检测」指令。
5. 样例数据 [cross-platform-pitfalls.md](../examples/input/cross-platform-pitfalls.md) 已按 jue 重写，作为生成与评估基线。

## 9. 已确认的结论

- **版本空间**：单一公共版本空间，`order` 用单清单。但 jue 支持应用内多版本共存（嵌套页面），故必须按调用点从 import 解析版本（§4），不能用全局 `target`。
- **平台守卫**：需同时支持 `environment`（字符串，枚举为四端）与布尔 flag 两类，且需推断 `else` / 取反的「非此端」补集（§5）。
