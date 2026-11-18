# RFC：core 公共 API 面收敛（P2-7）

> 状态：**草案（待评审）** · 提案编号：P2-7 · 影响面：`backend/core`、`access/server`、`plugins/*`、`examples/*`
> 结论先行：**不收缩既有符号（371 个导出全部保留兼容），只给「新增」立规矩 + 分层入口给「未来」留路。**
> 评审通过后按 §6 分阶段落地；本文档即唯一权威规格，落地实现不得与本稿签名漂移。

---

## 1. 问题陈述（现状量化，2026-11-18 实测）

`backend/core/src/index.ts` 是 core 唯一公共门面（`package.json.exports` 仅暴露 `"."`，
deep import 已被 ESM exports 封装挡住——这点是对的，问题在门面太宽）：

| 维度 | 实测值 | 说明 |
| --- | --- | --- |
| `export *` 行 | **52** | 全部为通配重导出，逐文件聚合一处 |
| 具名导出块 | 5 | `guardrails` / `db-dialect` 等补充块 |
| 运行时导出符号 | **371** | `Object.keys(import('@agent-harness/core'))` 实测（不含纯类型） |
| 上游消费点 | 155 处 | access/server 64 + plugins 61 + examples 30（`from '@agent-harness/core'`） |

三个具体风险（均已可从代码实证）：

1. **隐式公共 API 无边界**：core 内部任何一个文件新增 `export`，都会**自动**进入公共 API——
   371 个符号中无一是「有意公开」的显式决定。内部重构（如改名一个内部函数）即等价于
   破坏公共 API，且无任何 CI 信号提示「这是对外契约」。
2. **类型/运行时双面漂移无守护**：core 已有 `guardrails-surface.test.cjs`（P1#21 G1）为
   **单模块**锁导出面快照，但 index.ts 主门面无同款守护——重导出链上的任何一层
   `export *` 漏搬/误删，都只在消费方 `tsc` 报错时才被发现（P1 并行实现期已实际发生过
   签名漂移，见 `P2-P3-design.md` §8.3）。
3. **升级破坏面不可评估**：无「哪些符号属于稳定契约、哪些只是顺手导出」的分级，导致任何
   core 版本升级都必须按「371 个全部可能破坏」做全量回归，成本封顶不下来。

## 2. 非目标（明确不做）

- **不做** breaking change：371 个既有符号全部保留，155 个消费点零改动——plugins 生态
  （medical-aesthetics-lead 等已交付插件）的导入面不动。
- **不做** tree-shaking 优化论证：core 唯一消费形态是 server 进程整包加载，收益可忽略；
  也不以此为由改 exports 形态。
- **不做** 语义收敛（合并/改名既有符号）：那是 P3+ 的接口治理，本 RFC 只管「面」。

## 3. 方案选项

### 选项 A：主门面导出面快照棘轮（守卫先行）

把 `guardrails-surface.test.cjs` 的快照模式**推广到主门面**：

- 新增 `backend/core/test/index-surface.test.cjs`：快照锁定当前 371 个运行时符号 +
  `.d.ts` 类型面清单（生成式基线文件 `test/index-surface.snapshot.json`）。
- 语义与 no-explicit-any 棘轮同构：**存量锁死、增量显式**——任何人想让新符号进公共面，
  必须同时更新基线文件（diff 可见、评审可拦）；漏更新 CI 直接红。
- 快照与实现漂移时（如子模块 export * 断链），测试给出「缺失符号清单」而非模糊的
  上游 tsc 错误。

优点：零行为风险、纯测试资产、当天可落地。
缺点：不解决「门面语义分层」，371 个符号的**认知负担**仍在。

### 选项 B：分层 subpath 入口（面向未来，不迁移存量）

`package.json.exports` 增加语义子入口，新代码优先从子入口导入：

```jsonc
"exports": {
  ".":            { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./harness":    { "types": "./dist/entrypoints/harness.d.ts",  "default": "./dist/entrypoints/harness.js" },
  "./workflow":   { "types": "./dist/entrypoints/workflow.d.ts", "default": "./dist/entrypoints/workflow.js" },
  "./guardrails": { "types": "./dist/entrypoints/guardrails.d.ts", "default": "./dist/entrypoints/guardrails.js" },
  "./llm":        { "types": "./dist/entrypoints/llm.d.ts",      "default": "./dist/entrypoints/llm.js" }
}
```

- 每个入口是**逐符号具名导出**的小门面（`src/entrypoints/harness.ts` 等 5 个新文件，
  各 15-30 行），语义边界即文件边界。
- 主门面 `"."` 保持 `export *` 现状不动——存量消费者零迁移。
- lint 层面（`eslint-plugin-import` 或轻量自定义规则）对 **access/server 的新增文件**
  提示走子入口（非强制，plugins 豁免）。

优点：为「按域理解 core」提供官方地图；未来若要冻结主门面，子入口就是现成的
承载面。
缺点：多一层目录与入口维护；若子入口长期无人走，反成死代码。

### 选项 C：主门面逐符号显式清单（371 行 export）

把 index.ts 改为 371 个具名导出，杜绝 `export *` 的隐式性。

优点：彻底显式。
缺点：**一次性 68 行 → 370+ 行大改，回归面覆盖 155 个消费点，与「先守卫后治理」的
团队铁律冲突；且 P2/P3 设计（`P2-P3-design.md` §0.1）要求 core 侧新增能力「接口 +
默认实现」渐进演进而非冻结**。不推荐，记录在案。

## 4. 推荐路线：A → B，两阶段

| 阶段 | 内容 | 验收 | 工作量 |
| --- | --- | --- | --- |
| 一（守卫） | 选项 A 全量落地：`index-surface.test.cjs` + 基线快照进 CI | ① 基线文件与 dist 实测 371 符号一致；② 删任一子模块 `export *` 行 CI 红并输出缺失清单；③ 新增导出未登记基线 CI 红 | 1 人日 |
| 二（分层） | 选项 B 落地 5 个子入口 + 新代码导入约定 | ① `pnpm --filter @agent-harness/core run build` 产出 5 个 entrypoints；② server 新增模块走子入口的示例 PR 合入；③ 主门面快照不变（零破坏证明） | 1.5 人日 |

阶段一先行独立合入（不依赖阶段二评审）；阶段二的入口清单（harness / workflow /
guardrails / llm / 其余暂缓）在阶段一合入后单独小评审定稿。

## 5. 关键设计细节（阶段一）

- **快照基线**：`backend/core/test/index-surface.snapshot.json`——运行时符号按
  `Object.keys(...)` 排序落 JSON；类型面以 `dist/index.d.ts` 顶层 `export` 声明名为准
  （tsc `--declaration` 产物，构建后生成）。两清单合并为单一基线文件，字段：
  `{ "runtime": [...371], "types": [...] }`。
- **再生成**：`node --test` 内不生成基线（防 CI 误写）；基线更新走显式脚本
  `scripts/update-core-surface.cjs`（node 22 原生 fetch/ESM，零依赖），PR diff 人工确认。
- **测试断言三层**：① 基线 ⊆ 实测（漏导出 = 红，报缺失清单）；② 实测 ⊆ 基线
  （未登记新增 = 红，报越权清单）；③ 排序一致（防 diff 噪声）。
- **与 `guardrails-surface.test.cjs` 关系**：不替代——模块级快照继续锁「拆分等价」，
  主门面快照锁「聚合完整」，二者互补。

## 6. 迁移与兼容

- 阶段一零迁移：只加测试与基线文件，core/ server/ plugins 代码零改动。
- 阶段二零迁移：子入口纯增量，主门面语义不变；`.eslint-any-baseline.json` 同款
  「存量豁免、增量收敛」思路照搬（不新增 lint 强制规则，先靠评审约定）。
- 未来若冻结主门面（不在本 RFC 范围）：子入口已就绪，届时只需一次性把 155 个消费点
  分批改道，基线快照做棘轮递减。

## 7. 风险与开放问题

- **快照漂移噪音**：上游 tsc 剥离注释（`removeComments: true`，提交 66bd190）等构建
  变化可能引发类型面声明顺序变动——基线**按名排序**存储规避。
- **子入口选型争议**：5 个入口的划分是否贴合未来使用方式（尤其 `workflow` 与
  `plan.ts` 的归属）——留给阶段二小评审，本 RFC 不锁死。
- **plugins 兼容承诺**：plugins 目录的 61 处导入是「对外生态接口」，任何后续冻结动作
  需单独发插件生态迁移公告，本 RFC 期内不触发。

## 8. 决策请求

需要团队评审拍板三件事：

1. 接受「A 先行」路线（阶段一 1 人日，无需等阶段二）；
2. 认可 371 个既有符号全部按现状视为「已承诺公共 API」；
3. 阶段二的 5 个子入口清单授权单独小评审定稿。

---

*附：本 RFC 的量化数据可在任一环境用
`node -e "import('@agent-harness/core').then(m=>console.log(Object.keys(m).length))"`
（需先 `pnpm --filter @agent-harness/core run build`）复现。*
