# lint-agent

> 跨端 DSL 规则自治维护 Agent：把团队散落在文档里的「版本差异 / 踩坑经验」，变成会在 CI 里拦你的 lint 规则。

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
- **自纠错 Agent 闭环**：`generate` 是「提取 → 校验（覆盖率 + 行为 + 语义）→ LLM 修正 → 重复直到通过或达到上限」的闭环。每轮感知失败、决策修正策略、行动后再感知，收敛过程可量化。

**为什么是专用 Agent 形态，而非通用 ReAct 外壳**：本项目的校验失败只有四类（漏提 / 幻觉 / 语义不符 / 行为失败），对应四个固定修正策略——决策空间离散可枚举，用代码编码策略即可。校验器是确定性程序（正则 / ESLint Linter），感知层不需要 LLM。LLM 只在需要泛化的环节出场：提取（自然语言 → 结构化数据）、修正（带完整失败上下文重生成）、语义评审（约束 vs 文档忠实度判定）。每一步可复现、可审计、成本可控。

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

> 样例文档 `cross-platform-pitfalls.md`（89 条 API 路径）`generate` 自纠错闭环 + `eval`：

`generate` 命令输出收敛分析表，量化 Agent 每轮的感知-修正效果：

```
======== 自纠错收敛分析 ========
  轮次   约束数    漏提    幻觉  行为失败  语义失败    修正数  LLM失败   Token     耗时
     1     85       3      0       0        0        3       0   12500     8.3s
     2     88       0      0       0        0        0       0       0     0.1s
──────────────────────────────────────────────────────────────────
合计                                                12500     8.4s
收敛: 全部通过（2 轮）
```

| 指标             | 结果                                                        |
| ---------------- | ----------------------------------------------------------- |
| 约束总数         | 88 条（初始提取 85 + 自纠错补提 3）                         |
| 行为校验         | 88/88 通过（跳过 not-fire 13 条）                           |
| 漏提             | 0 条（自纠错闭环自动补提，初始提取漏掉的 3 条全部回补）     |
| 幻觉             | 0 条                                                        |
| 收敛轮次         | 2 轮（第 1 轮发现 3 条漏提 → LLM 补提取 → 第 2 轮全部通过） |
| 提取耗时 / Token | 约 8s / 1.3w（含自纠错闭环）                                |

**三项改进的效果**：

- **selector 机械推导**：行为校验从「6 条 selector 层级错误」降为 0——`targetToSelector` 从根源消除，不再依赖 LLM 写对 AST 层级。
- **自纠错闭环**：初始提取漏提的 3 条 API（`getBoundingClientRect` / `onMediaStateChange` / `watchLocation`）在第 1 轮被覆盖率校验发现，LLM 补提取后第 2 轮全部通过。
- **Few-shot 提示**：prompt 内嵌 3 个示例（2段路径、3段路径、跳过），引导 LLM 正确输出约束格式，减少初始提取的漏提率。

覆盖率中的 `jue.module.method` 是文档里的占位符（非真实 API），不计为漏提。13 条 not-fire 跳过是因为 `level: 'warn'` 或空 `conditions`（全禁）天生没有「放行」用例。

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

| 命令       | 作用                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `generate` | 文档 → 自纠错闭环提取（extract → eval → heal，最多 3 轮）→ 约束落盘 + 收敛分析表 + 可运行 flat config                        |
| `eval`     | 独立校验：覆盖率（漏提 / 幻觉）+ 行为（规则是否真的 fire / not-fire）；`--semantic` 追加 LLM-as-judge 语义校验（需 API Key） |

`generate` 首次运行用默认 jue 配置（`defaultEngineConfig`）自动写出 `output/engine-config.json`（sdkName + 平台守卫映射 + 版本序清单）。需要覆盖默认值时直接编辑该文件即可，下次 `generate` 会尊重你的修改。

```bash
# 提取约束 + 产出可运行 ESLint 配置（同时写出 engine-config.json）
lint-agent generate --from examples/input/cross-platform-pitfalls.md

# 校验 generate 产物：覆盖率（漏提/幻觉）+ 行为（规则是否生效）；--semantic 追加语义校验
lint-agent eval --from examples/input/cross-platform-pitfalls.md
lint-agent eval --from examples/input/cross-platform-pitfalls.md --semantic
```

---

## 架构

```
                ┌──────────────────────────────────────────────────────────┐
                │              自纠错 Agent 闭环                           │
   文档 ───────▶ │  extract(LLM) → 约束数据 → eval(覆盖率+行为+语义)    │ ─▶ output/constraints.json
                │       ↑                          ↓ fail?                │ ─▶ output/eslint.config.mjs
                │       └── LLM 修正 ←──────────────┘                      │
                │  重复直到通过或 maxRounds=3，每轮落盘 trace + 收敛表      │
                └──────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                                output/logs/agent-trace.jsonl
```

- **Skill `extract-patterns`**：文档分块 → `Constraint[]`，Zod 校验 + 按 target 去重 + 同 target 冲突检测（跨章节矛盾显式上报，不静默吞掉）。selector 不由 LLM 产出，由 `targetToSelector(target, sdkName)` 从 target 段数机械推导（2段→`callee.object`、3段→`callee.object.object`），杜绝层级写错。
- **自纠错闭环 `self-heal`**：初始提取后自动跑覆盖率 + 行为 + 语义三道校验；漏提 → LLM 补提取；幻觉 → 直接移除；语义失败 → LLM 对照文档修正；行为失败 → LLM 带合成用例代码 + lint 输出修正。每轮记录 `HealRound`（约束数 / 漏提 / 幻觉 / 行为失败 / 语义失败 / 修正数 / LLM 调用失败 / Token / 耗时），输出收敛分析表。
- **语义评审 `judge`**：LLM-as-judge 分批对照文档原文评审约束忠实度（conditions / level / evidence / target），堵上「数据自洽但与文档不符」的缺口——minVersion 抄错、platform 写偏这类错误行为校验发现不了。
- **结构化输出**：`chatJSON` 优先使用 API 原生结构化输出（OpenAI `json_schema` / Anthropic tool use），不支持时自动回退到 `json_object` + Zod 校验 + 修复循环。
- **Few-shot 提示**：提取 prompt 内嵌 3 个示例（2段路径、3段路径、跳过），引导 LLM 正确输出约束格式。
- **`pg/unsupported-api` 引擎**：selector 匹配 → 调用点解析 → 三级校验，命中即 report。ESLint 9 不再支持按条指定 severity，故拆成 `pg/unsupported-api`（error）与 `pg/unsupported-api-warn`（warn）两条规则，共享同一套约束与解析逻辑。

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

- **三道互补校验，覆盖三类缺口**：覆盖率校验（锚=文档正则）抓「漏提 / 幻觉」；行为校验（锚=ESLint Linter）抓「规则不生效」；语义评审（锚=LLM 对照文档）抓「数据自洽但与文档不符」——minVersion 抄错、platform 写偏、level 标错都能通过前两道，只有语义评审能发现。
- **每条约束带 evidence**：文档原文字句引用，语义评审验证其逐字存在（防伪证），人工可据此审计每条规则的出处。
- **LLM 输出三层防线**：① API 原生结构化输出（OpenAI `json_schema` / Anthropic tool use）→ ② Zod 校验 → ③ 校验失败带错误回传修复循环。第一层不支持时自动降级到 `json_object` + 围栏剥离。
- **selector 机械推导**：`targetToSelector(target, sdkName)` 从 target 段数机械推导 esquery selector——2段→2层 callee、3段→3层 callee，**一层不多一层不少**。消除了 LLM 写错 AST 层级（如 3 段路径写成 4 层 `callee.object.object.object`）的整类错误。
- **自纠错闭环**：提取后自动校验（覆盖率 + 行为 + 语义），失败时 LLM 修正并重试，最多 3 轮。收敛过程可量化（每轮约束数 / 漏提 / 幻觉 / 行为失败 / 语义失败 / 修正数 / LLM 调用失败 / Token / 耗时）；`healedCount` 只计真实变更，杜绝指标虚高。LLM 调用失败不中断循环，但记入 `llmFailures` 并打 warn，绝不静默吞异常。
- **同 target 冲突显式上报**：跨章节对同一 API 给出不一致条件时，去重保留首次出现，但冲突记入 `conflicts` 并在 generate 输出中告警，不静默吞掉。
- **调用失败指数退避**：只对 429 / 5xx / 超时重试，优先尊重服务端 `retry-after`。
- **保守判定防漏报**：`conditions` 空 → 报；非空但缺引擎配置 / 版本清单 / 目录名 → 报。**配置缺失宁可误报、绝不放行漏报**。

## 校验方式（eval）

仓库里不再维护手写的「正确性基准」——用人工写的 `expected-rules.json` 去验 LLM 自动提取，本质是让「人工答案」反向背书「生成器」，是循环论证（且手写基线自身会漏：样例中的 `jue.device.getIdfv` 就曾被人工基线漏掉，LLM 反而提对了）。`eval` 以**两道零人工、零 LLM 的校验为基座，一道 LLM-as-judge 语义校验为增强**，锚点分别是「文档」「引擎」和「约束 vs 文档的忠实度」：

| 步骤     | 锚点         | 判什么                                                                            | 输出                                     | 依赖         |
| -------- | ------------ | --------------------------------------------------------------------------------- | ---------------------------------------- | ------------ |
| 覆盖率   | 原文文档     | 正则抽取 `jue.module.method` 全路径，与生成约束的 `target` 做差集                 | `missed`（漏提）/ `hallucinated`（幻觉） | 无 LLM       |
| 行为校验 | 单引擎       | 每条约束自动合成 fire（必命中）/ not-fire（必放行）代码，跑 `Linter` 断言真的生效 | 逐条 ✔/✘                                 | 无 LLM       |
| 语义校验 | 约束 vs 文档 | LLM-as-judge 逐条评审 conditions / level / evidence / target 是否忠实于文档原文   | 逐条 ✔/✘ + 偏差说明                      | `--semantic` |

- **覆盖率**回答「有没有漏掉 / 凭空多出规则」——从文档抽 API 路径，和生成结果比对，识别漏提与幻觉。
- **行为校验**回答「规则写了到底生不生效」——曾揪出系统性问题：`jue.event.on()` 这类 3 级调用，selector 被 LLM 错写成 4 级节点（`callee.object.object.object`），导致规则永不命中。这种缺陷纯看 JSON 数据永远发现不了，必须跑起来。现已通过 `targetToSelector` 纯函数机械推导 selector 从根源消除——target 有几段、AST 层级就有几层，一层不多一层不少。
- **语义校验**回答「约束数据自洽，但它忠实于文档吗」——minVersion 抄错（文档 2.10.0 提成 2.12.0）、platform 写偏、level 标错都能通过前两道校验（行为校验用同一份数据既生成用例又生成期望，天然自洽）。语义评审与 `evidence` 字段配套：评审会验证 evidence 逐字存在于文档（防伪证），使行为校验不再有循环论证残留。

结果写入 `output/eval-result.json`；任一行为校验失败、出现幻觉、或语义校验发现不符，`eval` 以非零退出码拦截。

## 目录结构

```
.
├── examples/                          # 样例踩坑文档 + 约束快照
├── src/
│   ├── engine/                        # 单引擎：conditions(isViolation/compare) + unsupported-api 规则 + resolve + 数据文件读写
│   ├── skills/                        # 唯一 Skill：extract-patterns（文档 → Constraint[]，含冲突检测）
│   ├── agent/                         # extract（初始提取）+ self-heal（自纠错闭环）+ judge（语义评审）+ trace（可审计日志）
│   ├── llm/                           # OpenAI / Anthropic 双 provider 客户端 + prompts
│   ├── cli/                           # lint-agent 入口（generate / eval / config）
│   ├── types/                         # 类型 + Zod schema
│   └── utils/                         # env / file / logger
├── tests/                             # Vitest 单测（引擎 / 解析 / 提取流水线 / 覆盖率 / 行为合成 / JSON 提取 / 自纠错闭环）
├── verify/                            # 真实样例代码端到端验证 + 快照 evidence 回填工具
└── docs/design.md                     # 设计决策记录
```

## 工程质量

- 单元测试 **77 个用例 / 9 份测试文件**（Vitest），覆盖单引擎 `isViolation` / `compare` 边界、版本与平台解析、初始提取流水线、自纠错闭环（脚本化 LLM 驱动全流程：漏提补齐 / 幻觉移除 / 语义修正 / 行为修正 / 冲突透传）、同 target 冲突检测、覆盖率差集、行为用例合成、JSON 提取与格式修复、结构化输出；`tsc --noEmit`（含 tests）通过。
- `verify/` 用真实 jue 样例代码跑通「文档 → 约束数据 → 单引擎接入 → ESLint 抓真实违规写法」，并断言合规对照不漏报；约束数据用已提交的固定快照 `examples/expected/constraints.json`，运行时无需 LLM。
- 自带 `eslint` 自检与 `prettier` 格式化（`npm run lint` / `npm run format`）；CI 跑 typecheck + test + build + lint + format:check。

## 边界与下一步

- 语义条件（L3：import / 类型 / 作用域）尚未实现，未来只扩 `Condition` 原语、不动引擎。
- 语义评审与 `evidence` 已落地；历史快照的 `evidence` 为空占位，有效 API Key 下运行 `npm run snapshot:backfill-evidence` 一键回填（校验引用逐字存在于文档后才落盘）。
- 自纠错闭环已能自动补提漏掉的 API、移除幻觉约束、修正语义与行为失败，但 LLM 修正质量取决于模型能力；极端情况下 3 轮内仍无法收敛，需人工介入。
- 自动提 PR、批量文档提取 / 并发生成、跨文档去重、感知层（监听新踩坑工单 / 版本发布触发规则增删）待扩展。
- `Constraint[]` 数据层的更多消费端待扩展：MCP server / LSP 注入（让 AI Coding 在写代码时查询 API 可用性，而非等 lint 事后拦截）、按 SDK 版本生成的类型定义（把拦截移到更左侧的 IDE / tsc）。
- 样式类风险（CSS 属性在 DSL 上的可用性）无法用 JS AST 检测，提取阶段需正确识别并跳过。

## 技术栈

Node 20+ · TypeScript (ESM) · ESLint 9 · OpenAI / Anthropic SDK · Zod · Commander · Vitest · Prettier
