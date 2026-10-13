# lint-agent

一套 DSL 下发到 **H5 / Android / iOS / 鸿蒙** 四端，各端 SDK 的 API 可用性随版本/平台变化——有的某端完全不支持、有的要到某个 SDK 版本才支持。这些约束散落在文档和版更记录里，新人反复踩坑，AI Coding 更不知情。

`lint-agent` 把一条约束沉淀成**一行数据**，交给一个**固定的 ESLint 规则引擎**在 CI 拦截违规写法：

```js
import jue from '@/sdk/jue/2.6.0';

export function saveUser(user) {
  if (isIOS) {
    // ❌ 被拦截：jue.storage.setSync 在 iOS 需 jue ≥ 2.12.0，当前 2.6.0
    jue.storage.setSync('user', user);
  }
}
```

```
error  jue.storage.setSync 在 iOS 需 jue ≥ 2.12.0，当前 2.6.0，请改用异步 jue.storage.set
```

满足版本要求、或走兜底实现的等价写法则放行。

---

## 核心思想：LLM 只产数据，规则代码固定

这是本项目最关键的取舍，也是它区别于「让 LLM 直接写 lint 规则」的地方：

- **LLM 只产出「声明」**：从文档提取 `Constraint[]` 数据行（API 路径 target、约束名、提示语、可用性条件），**不写任何规则代码、不产出 selector**。selector 由引擎从 `target` 段数机械推导，杜绝 LLM 写错 AST 层级。
- **规则引擎只有一个**：通用规则 `pg/unsupported-api`，运行时读约束数据。selector 匹配与条件判定在引擎里实现一次，约束从 10 条涨到 1000 条，**规则代码零增长**。
- **判定逻辑收敛为纯函数** `isViolation`：`unsupported`（某端不可用）/ `min_version`（某端 ≥ 指定版本才可用）两类原语，所有约束共享同一引擎，杜绝判定逻辑重复与漂移。
- **每条约束可追溯**：`evidence` 字段逐字摘录文档原句，作为约束的审计锚点——每条规则都能回答「文档哪句话支撑你」。
- **自纠错 Agent 闭环**：`generate` 是「提取 → 校验（覆盖率 + 引擎自检 + 语义评审）→ LLM 修正 → 重复直到通过或上限」的闭环。每轮感知失败、决策修正策略、行动后再感知，收敛过程可量化。

**为什么是专用 Agent 形态，而非通用 ReAct 外壳**：本项目的校验失败只有四类（漏提 / 幻觉 / 语义不符 / 自检失败），对应四个固定修正策略——决策空间离散可枚举，用代码编码策略即可。校验器是确定性程序（正则 / ESLint Linter），感知层不需要 LLM。LLM 只在需要泛化的环节出场：提取（自然语言 → 结构化数据）、修正（带完整失败上下文重生成）、语义评审与文档差分（对照文档的忠实度判定）。每一步可复现、可审计、成本可控。

## 三个技术亮点

1. **按「调用点」解析版本，而非全局唯一版本**。SDK clone 到项目目录，版本写在 import 路径末尾：
   ```js
   import jueNew from '@/sdk/jue/2.25.0';
   import jueOld from '@/sdk/jue/2.6.0';
   ```
   引擎用 ESLint 的 scope manager 追踪 identifier → import 绑定，[按调用点](src/engine/resolve.ts)取它自己的版本号，**同一文件多版本共存也能正确判定**。
2. **按「运行时守卫」推断运行端**。平台不是配置项，而是从 AST 祖先节点反推「候选运行端集合」——识别 `if (isIOS)`、`if (environment === 'ios')`、取反 `!isIOS`、`||` 并集，甚至 `else` 分支的补集。命中节点落在哪条分支，就按那条分支的语义判定。
3. **三级校验，解析失败绝不静默跳过**。每条约束带 `level`（`error` / `warn`）与 `onResolveFail`（`warn` / `skip`）：
   | 场景                                               | 行为                                           |
   | -------------------------------------------------- | ---------------------------------------------- |
   | 版本 / 平台均解析成功且违规                        | 报 `error`                                     |
   | 天生提醒类（废弃迁移、跨端语义不确定）             | 命中即报 `warn`                                |
   | 版本 / 平台解析失败（无 import / 无版本 / 无守卫） | 按 `onResolveFail` 显式降级（`warn` / `skip`） |
   | 版本无法静态提取（动态 import 路径，如模板字符串） | 跳过不报（版本不可判定）                       |

---

## 实测结果

> 样例文档 `cross-platform-pitfalls.md`（88 条 API 路径）· `npm test` / `npm run verify:lint` / `npm run eval`（语义层默认开启）实测。

| 指标                       | 实测结果                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| 文档 API 路径              | 88 条唯一路径，其中 2 条仅出现在 `[跳过]` 章节（不可静态检测的语义模式，仅留档），预期不提取、不计漏提 |
| 生成约束                   | **86 条**，覆盖率 **100%**（漏提 0 · 幻觉 0）                                                          |
| 引擎自检                   | **86/86 通过**，展开 **470** 个「版本 × 端」边界场景判定一致；版本清单归因 0 处缺项                    |
| 忠实度评审（LLM-as-judge） | 5 批全部通过                                                                                           |
| 文档差分（oracle）         | 32 批全部通过、0 幻觉引用（86 个场景因文档未言明判 `unclear` 跳过，不计失败）                          |
| 自纠错闭环                 | 3 轮内收敛，LLM 调用失败每轮归零；修复前对比：漏提 16 → 0                                              |
| 单元测试                   | **173 个用例 / 15 份测试文件**，LLM 全程脚本替身驱动，不依赖网络                                       |
| 端到端验证                 | 真实 jue 样例代码命中 4 处违规，合规对照 0 误报                                                        |

`generate` 输出收敛分析表，量化 Agent 每轮的感知-修正效果（轮次 × 约束数 / 漏提 / 幻觉 / 自检失败 / 语义失败 / 修正数 / LLM 失败 / Token / 耗时）；任何一道校验未过，`eval` 以非零退出码拦截，不把"没验出问题"和"没有问题"混为一谈。

**两项已固化的改进**：

- **selector 机械推导**：引擎自检曾发现「6 条 selector 层级错误」（3 段路径被 LLM 写成 4 层 `callee.object.object.object`），机械推导后该类缺陷降为 0——`targetToSelector` 从根源消除，不再依赖 LLM 写对 AST 层级。
- **批次级降级（`agent/heal-batch.ts`）**：`heal_*` 修正曾出现「一条数据格式不合法 → 整批作废 → 漏提 3 轮修不回」（实测 9 条漏提因一个坏 `name` 全部作废）。改为「先整批、失败再逐条」，保留已通过校验的部分；先探测第一条，失败则判定系统性故障立刻放弃，避免无效重试风暴。修复后同类场景逐条救回、第 2 轮收敛。

> **快照口径提醒**：`examples/expected/constraints.json`（86 条）是端到端验证用的已提交快照，`verify/verify.mjs` 读它、运行时零 LLM，因此 CI 不受生成波动影响。修改文档后需 `npm run generate && npm run constraints:snapshot` 重新对齐。

---

## 快速开始

```bash
npm install
cp .env.example .env          # 填入你的 LLM_API_KEY 等
npm run generate              # 从样例文档提取约束数据
```

`.env` 关键配置：

```bash
LLM_PROVIDER=openai          # openai | anthropic
LLM_API_KEY=sk-...           # 或 OPENAI_API_KEY / ANTHROPIC_API_KEY
LLM_BASE_URL=...             # 兼容 OpenAI 接口的国内网关，如 https://api.deepseek.com
LLM_MODEL=deepseek-chat      # 或 glm-4.7 等
```

## CLI

| 命令       | 作用                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | 文档 → 自纠错闭环提取（extract → eval → heal，最多 3 轮）→ 约束落盘 + 收敛分析表 + 可运行 flat config                                                                                        |
| `eval`     | 独立校验：覆盖率（漏提 / 幻觉）+ 引擎自检（场景跑真实 Linter 验接线）；语义层默认开启（忠实度评审 + 文档差分，需 API Key），`--no-semantic` 关闭；`--no-narrow-context` 退回全文上下文做对照 |

`generate` 首次运行用默认 jue 配置（`defaultEngineConfig`）自动写出 `output/engine-config.json`（sdkName + 平台守卫映射 + 版本序清单）。需要覆盖默认值时直接编辑该文件即可，下次 `generate` 会尊重你的修改。

```bash
# 提取约束 + 产出可运行 ESLint 配置（同时写出 engine-config.json）
lint-agent generate --from examples/input/cross-platform-pitfalls.md

# 校验 generate 产物：覆盖率（漏提/幻觉）+ 引擎自检（场景跑真实 Linter）+ 语义层（默认开启）
lint-agent eval --from examples/input/cross-platform-pitfalls.md
# 关闭语义层（零 LLM 快速基线，无需 API Key）
lint-agent eval --from examples/input/cross-platform-pitfalls.md --no-semantic
```

---

## 架构

```
                ┌──────────────────────────────────────────────────────────┐
                │              自纠错 Agent 闭环                           │
   文档 ───────▶ │  extract(LLM) → 约束数据 → 校验(覆盖率+引擎自检+评审) │ ─▶ output/constraints.json
                │       ↑                          ↓ fail?                │ ─▶ output/eslint.config.mjs
                │       └── LLM 修正 ←──────────────┘                      │
                │  重复直到通过或 maxRounds=3，每轮落盘 trace + 收敛表      │
                └──────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                                output/logs/agent-trace.jsonl
```

- **Skill** **`extract-patterns`**：文档分块 → `Constraint[]`，Zod 校验 + 按 target 去重 + 同 target 冲突检测（跨章节矛盾显式上报，不静默吞掉）。selector 不由 LLM 产出，由 `targetToSelector(target, sdkName)` 从 target 段数机械推导（2段→`callee.object`、3段→`callee.object.object`），杜绝层级写错。
- **自纠错闭环** **`self-heal`**：初始提取后自动跑覆盖率 + 引擎自检 + 语义评审；漏提 → LLM 补提取；幻觉 → 直接移除；语义失败 → LLM 对照文档修正；自检失败 → LLM 带不匹配场景代码 + 期望/实际差异修正。每轮记录 `HealRound`（约束数 / 漏提 / 幻觉 / 自检失败 / 语义失败 / 修正数 / LLM 调用失败 / Token / 耗时），输出收敛分析表。
- **语义评审** **`judge`**：LLM-as-judge 分批对照文档原文评审约束忠实度（conditions / level / evidence / target），堵上「数据自洽但与文档不符」的缺口。
- **文档差分** **`oracle`**（`eval`，语义层默认开启）：比 judge 更强的正确性校验——oracle LLM **看不到任何约束数据**，只拿「**该 API 的文档条目 + 全局约定**」（输入视角收窄）+ 合成的具体业务场景代码（版本×端边界），**先逐字引用原句再独立判定**该报 error / warn / 放行，再与引擎真实 lint 结果差分。平台抄错、版本抄错时引擎自检天然自洽，差分却双向现形；引用无法逐字核对的判定一律作废为 `unclear`（见 [doc-context.ts](src/engine/doc-context.ts)）。
- **结构化输出**：`chatJSON` 优先使用 API 原生结构化输出（OpenAI `json_schema` / Anthropic tool use），不支持时自动回退到 `json_object` + Zod 校验 + 修复循环。
- **Few-shot 提示**：提取 prompt 内嵌 3 个示例（2段路径、3段路径、跳过），引导 LLM 正确输出约束格式。
- **`pg/unsupported-api`** **引擎**：selector 匹配 → 调用点解析 → 三级校验，命中即 report。ESLint 9 不再支持按条指定 severity，故拆成 `pg/unsupported-api`（error）与 `pg/unsupported-api-warn`（warn）两条规则，共享同一套约束与解析逻辑。

## 约束数据模型

一条约束 = 一行数据，是 LLM 的唯一产物：

```ts
type Platform = 'h5' | 'android' | 'ios' | 'harmony';

type Condition =
  | { kind: 'unsupported'; platform: Platform } // 某端完全不可用
  | { kind: 'min_version'; platform: Platform; minVersion: string }; // 某端 ≥ minVersion 才可用

interface Constraint {
  name: string; // kebab-case 人读标识（展示 / 消息）
  target: string; // 确定性身份：SDK 挂载 API 路径，如 jue.system.getSystemInfo（去重与评估匹配键）
  selector: string; // esquery AST selector——由 targetToSelector(target) 机械推导，不由 LLM 产出
  message: string; // 违规时报告给开发者的提示语
  conditions: Condition[]; // 空 = 无条件全禁用；平台/版本行 = 条件禁用
  level: 'error' | 'warn'; // 硬校验 / 天生提醒
  onResolveFail: 'warn' | 'skip'; // 版本/平台解析失败时的降级策略
  evidence: string; // 文档原文字句引用——约束的审计锚点，供人工追溯与语义评审
}

interface EngineConfig {
  sdkName: string; // 追踪的导入绑定名，如 'jue'
  guards: {
    booleanFlags: Record<string, Platform>; // { isIOS: 'ios', isAndroid: 'android', ... }
    envVar: string; // 字符串环境变量名，如 'environment'
    envValues: Record<string, Platform>; // 取值 → 端：{ ios: 'ios', android: 'android', ... }
  };
  order: string[]; // SDK「目录名 → 序号」有序清单，越靠后越新（单一公共版本号空间）
}
```

- 「全端禁用」= `conditions: []`
- 「iOS 2.6 以下不可用」= `{ kind: 'min_version', platform: 'ios', minVersion: '2.6' }`
- 「某端完全不可用」= `{ kind: 'unsupported', platform: 'ios' }`
- 版本比较用团队维护的「SDK 目录名 → 序号」清单，**不用 semver / 字典序**——适配非语义化目录名场景。
- 未来新增语义条件（import / 类型 / 作用域）只扩 `Condition` 原语，不动引擎。

## 可靠性设计

- **三层校验，锚点各异，各管一个独立失效面**：① 覆盖率（锚=文档正则，零 LLM）抓「漏提 / 幻觉」；② 引擎自检（锚=真实 Linter，零 LLM）把每条约束展开成「版本×端」边界场景跑一遍，抓「引擎没按数据执行」（selector / 解析 / severity 接线断）；③ 语义层（锚=文档，默认开启）含忠实度评审与文档差分，抓「数据自洽但与文档不符」（版本号 / 平台抄错）——自检的场景期望由数据自身推导，这类错误它天然抓不到。
- **每条约束带 evidence**：文档原文字句引用，语义评审验证其逐字存在（防伪证），人工可据此审计每条规则的出处。
- **LLM 输出三层防线**：① API 原生结构化输出（OpenAI `json_schema` / Anthropic tool use）→ ② Zod 校验 → ③ 校验失败带错误回传修复循环。第一层不支持时自动降级到 `json_object` + 围栏剥离。
- **selector 机械推导**：`targetToSelector(target, sdkName)` 从 target 段数机械推导 esquery selector——2段→2层 callee、3段→3层 callee，**一层不多一层不少**。消除了 LLM 写错 AST 层级（如 3 段路径写成 4 层 `callee.object.object.object`）的整类错误。
- **自纠错闭环**：提取后自动校验（覆盖率 + 引擎自检 + 语义评审），失败时 LLM 修正并重试，最多 3 轮。收敛过程可量化（每轮约束数 / 漏提 / 幻觉 / 自检失败 / 语义失败 / 修正数 / LLM 调用失败 / Token / 耗时）；`healedCount` 只计真实变更，杜绝指标虚高。LLM 调用失败不中断循环，但记入 `llmFailures` 并打 warn，绝不静默吞异常。
- **同 target 冲突显式上报**：跨章节对同一 API 给出不一致条件时，去重保留首次出现，但冲突记入 `conflicts` 并在 generate 输出中告警，不静默吞掉。
- **调用失败指数退避**：只对 429 / 5xx / 超时重试，优先尊重服务端 `retry-after`。
- **保守判定防漏报**：`conditions` 空 → 报；非空但缺引擎配置 / 版本清单 / 目录名 → 报。**配置缺失宁可误报、绝不放行漏报**。

## 校验方式（eval）

仓库里不再维护手写的「正确性基准」——用人工写的 `expected-rules.json` 去验 LLM 自动提取，本质是让「人工答案」反向背书「生成器」，是循环论证（且手写基线自身会漏：样例中的 `jue.device.getIdfv` 就曾被人工基线漏掉，LLM 反而提对了）。`eval` 有三层锚点不同的校验：

| 步骤                 | 锚点         | 判什么                                                                                                                       | 输出                                      | 依赖           |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------- |
| 覆盖率               | 原文文档     | 正则抽取 `jue.module.method` 全路径，与生成约束的 `target` 做差集                                                            | `missed`（漏提）/ `hallucinated`（幻觉）  | 无 LLM         |
| 引擎自检             | 真实 Linter  | 每条约束展开成「版本×端」边界场景（阈值下/阈值上、unsupported 端、每个非条件端、无守卫降级），跑 `Linter` 断言引擎按数据执行 | 逐场景期望 vs 实际                        | 无 LLM         |
| 版本清单归因         | 引擎配置     | 每个 `minVersion` 必须在 `config.order` 里，否则该约束在已知版本空间内**一条「该拦」场景都构造不出来**，自检失败也会归错因   | 逐条 minVersion 清单缺项明细              | 无 LLM         |
| 忠实度评审（语义层） | 约束 vs 文档 | LLM-as-judge 逐条评审 conditions / level / evidence / target 是否忠实于文档原文                                              | 逐条 ✔/✘ + 偏差说明                       | 语义层（默认） |
| 文档差分（语义层）   | 文档         | oracle LLM 只看文档、对场景代码独立判定 error/warn/ok/unclear，与引擎真实 lint 结果差分                                      | 逐场景 oracle 判定 vs 引擎实际 + 文档依据 | 语义层（默认） |

三层校验各回答一个问题，互不替代：

- **覆盖率**回答「有没有」——有没有漏掉 API、有没有凭空编造。
- **版本清单归因**回答「**验没验到**」——`compare()` 对清单外版本保守判违规（返回 -1），所以 `min-<端>-at` 场景会「期望放行、实际拦截」而自检失败：这个缺陷**不会静默漏过**，但**归因是错的**（报告显示 selector/接线问题，真因是版本清单缺项，或 LLM 把版本抄成了一个根本不存在的值）。更隐蔽的是 `min-<端>-below`（该拦的场景）在清单外版本下**根本生成不出来**——该约束在已知版本空间里一条正向验证场景都没有。因此这里做一次零 LLM 的确定性归因，把「哪条约束、哪一端、哪个版本」直接摆出来，并明确两条修法：文档真引入了新版本 → 补 `engine-config.json` 的 `order`；版本号抄错 → 修约束数据。它同样进入自纠错闭环（第 5 类策略 `heal_versions`，prompt 明确允许"原样返回"，禁止为迎合清单而篡改版本号）。
- **引擎自检**回答「响不响」——规则是否真的在 ESLint 里生效。它曾揪出系统性问题：`jue.event.on()` 这类 3 级调用，selector 被 LLM 错写成 4 级节点（`callee.object.object.object`），规则永不命中；该缺陷纯看 JSON 永远发现不了。现已通过 `targetToSelector` 机械推导从根源消除，自检随之演变为引擎的端到端回归网（改引擎任何一层立刻知道有没有改挂）。**但自检回答不了「对不对」**：场景的期望由约束数据自身推导，题面与答案同源——平台抄错、版本抄错时，用错误数据合成的「违规代码」在错误规则下照样「正确命中」，自检全绿。
- **语义层**回答「对不对」。忠实度评审让 LLM 看着约束数据对照文档（快、便宜，但存在「看着数据评数据」的锚定偏差）；**文档差分**彻底切断同源：oracle 的输入只有文档原文和合成场景代码（场景 id 用中性序号，连约束名都看不到），独立给出该报/该放的第二意见，与引擎真实判定比对——文档说「鸿蒙不支持」、约束误写成「iOS 不支持」时，iOS 场景（oracle 判放行 / 引擎拦截）与鸿蒙场景（oracle 判拦截 / 引擎放行）会**双向现形**。两条判定链路（文档→提取→引擎 vs 文档→oracle 直判）只共享文档，LLM 在两类任务上的错误不相关；oracle 判 `unclear`（文档没说清）或调用失败时跳过，不拿猜测当信号。

**文档差分的作用域（如实声明）**：

- 参与差分的是 `determinate` 场景（版本与平台均静态确定）；无守卫降级、动态 import 等 `resolution` 场景的期望依赖引擎自身降级策略，oracle 无从独立判定，由零 LLM 的引擎自检覆盖。
- oracle 判 `unclear`（文档对该端未言明）的场景跳过不判失败、不影响退出码，仅作覆盖度量记录——约束本就常只针对单端，「没说就是支持」不应由 oracle 假设。
- 差分是高性价比的**证伪装置**（可靠逼出「数据自洽但与文档不符」这类缺陷），而非形式化证明：两条判定链路共享文档，同族模型仍可能产生相关性误读。故 `engine/doc-context.ts` 做了两道零成本加固：**输入视角收窄**（只喂该 API 的文档条目而非全文，实测上下文约 -90%，切断共享语境）+ **引用先行**（oracle 必须先逐字摘录文档原句，经 `validateCitation` 校验逐字存在，引不出就必须判 `unclear`——编一句像样的依据换不来通过）。
- oracle 调用失败的批次显式计入 `failedBatches`，`eval` 把「本轮结论不完整」计入失败原因与非零退出码——不静默跳过，避免差分退化成概率性校验。
- 加固生效情况随产物落盘（`output/eval-result.json` 的 `semantic.oracleHardening`），「差分通过」是可审计的通过。

结果写入 `output/eval-result.json`；出现幻觉、引擎自检失败、忠实度评审失败或文档差分不一致，`eval` 以非零退出码拦截。

## 目录结构

```
.
├── examples/                          # 样例踩坑文档 + 约束快照
├── src/
│   ├── engine/                        # 单引擎：conditions(isViolation/compare) + unsupported-api 规则 + resolve + doc-context(输入视角收窄) + 数据文件读写
│   ├── skills/                        # 唯一 Skill：extract-patterns（文档 → Constraint[]，含冲突检测）
│   ├── agent/                         # extract（初始提取）+ self-heal（自纠错闭环）+ judge（忠实度评审）+ oracle（文档差分）+ trace（可审计日志）
│   ├── llm/                           # OpenAI / Anthropic 双 provider 客户端 + prompts
│   ├── cli/                           # lint-agent 入口（generate / eval / config）
│   ├── types/                         # 类型 + Zod schema
│   └── utils/                         # env / file / logger
├── tests/                             # Vitest 单测（引擎 / 解析 / 提取流水线 / 覆盖率 / 场景合成 / 文档差分 / JSON 提取 / 自纠错闭环）
├── verify/                            # 真实样例代码端到端验证 + 快照 evidence 回填工具
└── docs/design.md                     # 设计决策记录
```

## 工程质量

- 单元测试 **173 个用例 / 15 份测试文件**（Vitest，LLM 全程脚本替身驱动、不依赖网络），覆盖单引擎 `isViolation` / `compare` 边界、版本与平台解析、初始提取流水线、自纠错闭环（漏提补齐 / 幻觉移除 / 语义修正 / 自检失败修正 / **版本清单缺项修正** / 冲突透传）、同 target 冲突检测、覆盖率差集、边界场景合成（含多端约束逐端覆盖的回归保护与调用形式目录）、版本清单归因、文档切片与引用校验、文档差分（平台抄错双向现形 / unclear 跳过 / 场景隔离 / 幻觉引用作废）、JSON 提取与格式修复、结构化输出、CLI `--no-*` 开关解析、批次级降级（整批失败→逐条救回 / 系统性故障放弃 / 逐条上限）；`tsc --noEmit`（含 tests）通过。
- `verify/` 用真实 jue 样例代码跑通「文档 → 约束数据 → 单引擎接入 → ESLint 抓真实违规写法」，并断言合规对照不漏报；约束数据用已提交的固定快照 `examples/expected/constraints.json`，运行时无需 LLM。
- 自带 `eslint` 自检与 `prettier` 格式化（`npm run lint` / `npm run format`）；CI 跑 typecheck + test + build + lint + verify:lint + format:check（Node 20 / 22 双版本矩阵）。

## 边界与下一步

- `generate` 是 LLM 驱动的非确定流程，单次运行不保证收敛；`eval` 以非零退出码拦下未收敛产物，CI 侧用固定快照验证、运行时零 LLM，不受生成波动影响。
- 语义条件（L3：import / 类型 / 作用域）尚未实现，未来只扩 `Condition` 原语、不动引擎。
- 语义评审与 `evidence` 已落地；历史快照的 `evidence` 为空占位，有效 API Key 下运行 `npm run snapshot:backfill-evidence` 一键回填（校验引用逐字存在于文档后才落盘）。
- 自纠错闭环已能自动补提漏掉的 API、移除幻觉约束、修正语义与行为失败，但 LLM 修正质量取决于模型能力；极端情况下 3 轮内仍无法收敛，需人工介入。
- 自动提 PR、批量文档提取 / 并发生成、跨文档去重、感知层（监听新踩坑工单 / 版本发布触发规则增删）待扩展。
- `Constraint[]` 数据层的更多消费端待扩展：MCP server / LSP 注入（让 AI Coding 在写代码时查询 API 可用性，而非等 lint 事后拦截）、按 SDK 版本生成的类型定义（把拦截移到更左侧的 IDE / tsc）。
- 样式类风险（CSS 属性在 DSL 上的可用性）无法用 JS AST 检测，提取阶段需正确识别并跳过。

## 技术栈

Node 20+ · TypeScript (ESM) · ESLint 9 · OpenAI / Anthropic SDK · Zod · Commander · Vitest · Prettier
