# lint-agent

> 跨端 DSL 规则自治维护工具：把团队散落在文档里的「版本差异 / 踩坑经验」，变成会在 CI 里拦你的 lint 规则。

一套 DSL 被下发到 **H5 / Android / iOS / 鸿蒙** 四端，同一份代码由各端 SDK 解析渲染。但 DSL 能用的 API / 语法取决于各端 SDK 的能力与版本——有的 API 某端完全不支持、有的要到某个 SDK 版本才支持。这些约束散落在文档和版更记录里，新人反复踩坑，AI Coding 更不会知道这些团队私有知识。

`lint-agent` 把一条约束沉淀成**一行数据**，交给一个**固定的 ESLint 规则引擎**在 CI 里拦截违规写法：

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

等价写法（满足版本要求、或走兜底实现）则放行。

---

## 核心思想：LLM 只产数据，规则代码固定

这是本项目最关键的取舍，也是它区别于「让 LLM 直接写 lint 规则」的地方：

- **LLM 只产出「声明」**：从文档提取 `Constraint[]` 数据行（约束名、esquery selector、提示语、可用性条件），**不写任何规则代码**。
- **规则引擎只有一个**：通用规则 `pg/unsupported-api`，运行时读约束数据。selector 匹配与条件判定在引擎里实现一次，约束从 10 条涨到 1000 条，**规则代码零增长**。
- **判定逻辑收敛为纯函数** `isViolation`：`unsupported`（某端不可用）/ `min_version`（某端 ≥ 指定版本才可用）两类原语，所有约束共享同一引擎，杜绝判定逻辑重复与漂移。

一次运行**全程只有 `extract-patterns` 这一次 LLM 调用**，规则行为可预测、可审计（每步落盘 trace）。

## 三个技术亮点

1. **按「调用点」解析版本，而非全局唯一版本**。SDK 是 clone 到项目目录的私有文件夹，版本写在 import 路径末尾：

   ```js
   import jueNew from '@/sdk/jue/2.25.0';
   import jueOld from '@/sdk/jue/2.6.0';
   ```

   引擎用 ESLint 的 scope manager 追踪 identifier → import 绑定，[按调用点](src/engine/resolve.ts)取它自己的版本号，**同一文件多版本共存也能正确判定**。

2. **按「运行时守卫」推断运行端**。平台不是配置项，而是从 AST 祖先节点反推「候选运行端集合」——识别 `if (isIOS)`、`if (environment === 'ios')`、取反 `!isIOS`、`||` 并集，甚至 `else` 分支的补集。命中节点落在哪条分支，就按那条分支的语义判定。

3. **三级校验，解析失败绝不静默跳过**。每条约束带 `level`（`error` / `warn`）与 `onResolveFail`（`warn` / `skip`）：

   | 场景                                   | 行为                                    |
   | -------------------------------------- | --------------------------------------- |
   | 版本 / 平台均解析成功且违规            | 报 `error`                              |
   | 天生提醒类（废弃迁移、跨端语义不确定） | 命中即报 `warn`                         |
   | 版本无法静态提取（动态 import 路径）   | 按 `onResolveFail` 显式降级，不静默跳过 |

## 架构

```
                ┌──────────────────────────────────────────────┐
                │                 确定性流水线                  │
   文档 ───────▶ │  extract(LLM) → 约束数据 → 固定引擎运行       │ ─▶ output/constraints.json
                │   每步落盘 trace，失败记录不中断               │ ─▶ output/eslint.config.mjs
                └──────────────────────────────────────────────┘
                                   │
                                   ▼
                       output/logs/agent-trace.jsonl
```

- **唯一 Skill `extract-patterns`**：文档 → `Constraint[]`（含 esquery selector），Zod 校验 + 按名去重；全程唯一一次 LLM 调用。
- **`pg/unsupported-api` 引擎**：selector 匹配 → 调用点解析 → 三级校验，命中即 report。ESLint 9 不再支持按条指定 severity，故拆成 `pg/unsupported-api`（error）与 `pg/unsupported-api-warn`（warn）两条规则，共享同一套约束与解析逻辑。
- **确定性问题不用 LLM planner**：`needsPlanner()` 恒为 `false`，`auto` / `state` 模式走确定性状态机；`llm` 模式保留「每步问 LLM」仅供对比实验。

## 约束数据模型

一条约束 = 一行数据，是 LLM 的唯一产物：

```ts
type Platform = 'h5' | 'android' | 'ios' | 'harmony';

type Condition =
  | { kind: 'unsupported'; platform: Platform } // 某端完全不可用
  | { kind: 'min_version'; platform: Platform; minVersion: string }; // 某端 ≥ minVersion 才可用

interface Constraint {
  name: string; // kebab-case 标识
  selector: string; // esquery AST selector，精确匹配违规节点
  message: string; // 违规时报告给开发者的提示语
  conditions: Condition[]; // 空 = 无条件全端禁用；平台/版本行 = 条件禁用
  level: 'error' | 'warn'; // 硬校验 / 天生提醒
  onResolveFail: 'warn' | 'skip'; // 版本/平台解析失败时的降级策略
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

- **LLM 输出三层防线**：JSON 提取（剥 markdown 围栏 + 兜底截取）→ Zod 校验 → 校验失败带错误回传修复。
- **调用失败指数退避**：只对 429 / 5xx / 超时重试，优先尊重服务端 `retry-after`。
- **四道防死循环闸**：提取只做一次、`maxSteps` 硬上限、动作合法性校验、完成判据单点定义。
- **保守判定防漏报**：`conditions` 空 → 报；非空但缺引擎配置 / 版本清单 / 目录名 → 报。**配置缺失宁可误报、绝不放行漏报**。

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

| 命令       | 作用                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `generate` | 文档 → 跑 Agent 循环 → 约束落盘 `output/constraints.json` + 产出可运行 flat config `output/eslint.config.mjs` |
| `eval`     | 约束 + 期望基线 → 量化指标（准确率 / FP / FN）                                                                |
| `config`   | 生成引擎运行时配置 `output/engine-config.json`（sdkName + 平台守卫映射 + 版本序清单）                         |

```bash
# 提取约束 + 产出可运行 ESLint 配置
lint-agent generate --from examples/input/cross-platform-pitfalls.md

# 量化评估（期望基线已与样例文档对齐，缺省使用默认 jue 引擎配置）
lint-agent eval --from examples/input/cross-platform-pitfalls.md \
  --expect examples/expected/expected-rules.json

# 生成引擎配置：jue 绑定名 + 平台守卫 + 版本序
lint-agent config --sdk-name jue \
  --flag isIOS=ios --flag isAndroid=android \
  --env-var environment --env-value ios=ios --env-value android=android \
  --order 2.0.0,2.5.0,2.10.0,2.15.0,2.20.0,2.25.0,2.30.0
```

## 目录结构

```
.
├── examples/                          # 样例踩坑文档 + eval 期望基线
├── src/
│   ├── engine/                        # 单引擎：conditions(isViolation/compare) + unsupported-api 规则 + resolve + 数据文件读写
│   ├── skills/                        # 唯一 Skill：extract-patterns（文档 → Constraint[]）
│   ├── agent/                         # loop / planner / executor / reflector / trace
│   ├── llm/                           # OpenAI / Anthropic 双 provider 客户端 + prompts
│   ├── cli/                           # lint-agent 入口（generate / eval / config）
│   ├── types/                         # 类型 + Zod schema
│   └── utils/                         # env / file / logger
├── tests/                             # Vitest 单测（引擎 / 解析 / 状态机 / 循环 / eval 匹配 / JSON 提取）
├── verify/                            # 真实样例代码端到端验证
└── docs/design.md                     # 设计决策记录
```

## 效果评估

`lint-agent eval` 以 `examples/expected/expected-rules.json` 为基准，把提取出的约束接进引擎，用 ESLint `Linter` 真实验证用例，输出量化指标到 `output/eval-result.json`：

| 指标                  | 口径                                        |
| --------------------- | ------------------------------------------- |
| 约束匹配 accuracy     | 按约束名 + 平台覆盖语义匹配                 |
| 误报率 FP / 漏报率 FN | 用例级，用 `Linter` 真实验证 expected 用例  |
| Token 消耗 / 耗时     | 全程累计（几乎全部来自提取这一轮 LLM 调用） |

> 期望基线 `expected-rules.json` 已与 `cross-platform-pitfalls.md` 对齐：83 条 jue 规则 + 15 条用例（覆盖 `min_version` / `unsupported` / `warn` 三类原语的正反例）。`eval` 缺省加载默认 jue 引擎配置，也可用 `--config` 覆盖。

## 工程质量

- 单元测试 **77 个用例 / 11 份测试文件**（Vitest），覆盖单引擎 `isViolation` / `compare` 边界、版本与平台解析、状态机、主循环、eval 语义匹配、JSON 提取与格式修复；`tsc --noEmit` 通过。
- `verify/` 用真实 jue 样例代码跑通「文档 → 约束数据 → 单引擎接入 → ESLint 抓真实违规写法」，并断言合规对照不漏报。
- 自带 `eslint` 自检与 `prettier` 格式化（`npm run lint` / `npm run format`）；CI 跑 typecheck + test + build + format:check。

## 边界与下一步

- 语义条件（L3：import / 类型 / 作用域）尚未实现，未来只扩 `Condition` 原语、不动引擎。
- 自动提 PR、批量文档提取 / 并发生成、跨文档去重、感知层（监听新踩坑工单 / 版本发布触发规则增删）待扩展。
- 样式类风险（CSS 属性在 DSL 上的可用性）无法用 JS AST 检测，提取阶段需正确识别并跳过。

## 技术栈

Node 20+ · TypeScript (ESM) · ESLint 9 · OpenAI / Anthropic SDK · Zod · Commander · Vitest · Prettier

## License

[MIT](./LICENSE)
