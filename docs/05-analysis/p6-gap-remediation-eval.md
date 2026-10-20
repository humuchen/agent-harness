# P6 差距收口评估方案（time travel 完整版 / RAG 生态深度 / 观测评估生态）

> 背景与基线：`docs/05-analysis/langchain-langgraph-comparison.md` §5/§7。三批实施后 13 项候选已落 11 项（提交 f090b2e / caf95bb），剩余 3 处明确不对齐项，本文逐项给出现状、方案选项、推荐路线、工作量、风险与验收标准，供排期决策。
> 评估日期：2026-10-08。验证基线：core 724/724、rag 34/34、webapp 410/410。

---

## 方案一：time travel 完整版（全量快照链 + 任意中间态回溯）

### 1.1 现状与差距

- 现有：单份最新检查点（store 按 def.id 存 latest）+ lite 跃迁历史（`WorkflowRun.history`，仅状态快照不含产出，上限 20）+ `POST /api/workflows/:id/rerun`（只能从最新快照按 step 分叉）。
- 差距（对齐 LangGraph `get_state_history()` + `update_state(checkpoint_id)`）：无法**列出**历史中间态、无法**回溯到任意历史点**重放（只能对当前态做下游重置）。

### 1.2 方案选项

| 选项 | 设计 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 快照内嵌 run | `WorkflowRun.snapshots?: WorkflowSnapshot[]`，波次收敛 / awaiting 进出 / failed / rerun 重置前追加「steps 状态 + outputs 引用」浅拷贝，上限 SNAPSHOT_MAX=50 | 零 store 接口改动；三后端（Volatile/SQLite/PG）自动获得；与 lite history 同构，实现面最小 | run 体积增长（用 SNAPSHOT_OUTPUT_MAX 截断 + 数量封顶控制）；超出上限丢最旧 |
| B. store 扩展快照表 | `WorkflowStore` 增加 `saveSnapshot / listSnapshots`，三后端各建表实现 | 无数量上限、可按 runId 全量查 | 接口变更 + 三后端实现 + 存量迁移；claim/对账逻辑需兼容 |
| C. COW + diff 链 | 快照只存与前者的增量，回溯时重放 | 体积最小 | 实现与调试复杂度最高，回放正确性难测，不建议首期 |

### 1.3 推荐路线

**先 A 后 B**：A 覆盖 95% 使用场景（plan/工作流 run 波次通常 < 10，50 上限充足）；若后续出现「长 run 全量回放」需求再升级 B（A 的快照结构可直接平移进 B 的表）。

关键设计点（A）：
- 快照结构：`{ id, ts, action, steps: Record<stepId,{state,attempts,output}>, error? }`——outputs 为该时点真实产出（截断 SNAPSHOT_OUTPUT_MAX=64KB/项，与 REPLAY_DETAIL_MAX 同纪律）。
- 回溯 API：`DagEngine.rollbackTo(workflowId, snapshotId)`——把快照写回 `run.steps/outputs`、`state='pending'`，复用既有 `/resume` 执行；`resetRunForRerun` 语义被其覆盖（rerun = 回溯到最新快照 + 下游重置的糖，可作为后续重构项，不强制）。
- 服务端：`POST /api/workflows/:id/rollback {snapshotId}`（鉴权 `workflow:run`，与 rerun 同级）+ `GET` 快照列表随既有检查点快照返回（零新端点）。
- 前端：执行详情抽屉时间线加「回滚到此点」入口（复用「从此步重跑」的 planRerunFrom 双路径模式）。

### 1.4 工作量与风险

- 工作量：A ≈ **3–4 人日**（引擎 6 个快照点 + rollback 纯函数与 API + server 路由 + 前端入口 + 测试 8–10 用例）；升级 B 再 +2–3 人日。
- 风险：① 检查点体积膨胀（缓解：截断 + 封顶 + 大产出不进快照的可配置开关）；② 前端三级恢复镜像 `PlanWfRunMirror` 需把 snapshots 纳入白名单并限幅（有 wfSnapshot 截断先例，风险低）；③ awaiting 态回溯与审批工单的交互（回溯后旧 approvals 保留，语义=「重新走一遍门」，需在文档明示）。
- 验收标准：三波 DAG 第 3 波失败 → 回溯到第 1 波后快照 → resume 重放，第 1 波产出复用（executor 调用计数不增）；快照上限 50 触发丢最旧；单检查点体积基准 ≤ 512KB。

---

## 方案二：RAG 生态深度（loaders / 结构感知切分 / 高级检索）

### 2.1 现状与差距

- 现有：ingest 只接受纯文本（抽取由调用方负责）；`chunkText` 固定滑窗；检索 = 稠密 + BM25 + MMR；`VectorStore` 已可插拔（Memory/Qdrant）；`generate.ts` 已有 LLMProvider 抽象；`eval.ts` 已有评估骨架。
- 差距（对齐 LangChain document loaders / text splitters / ParentDocument·HyDE·multi-query）：无文档格式加载、无结构感知切分、无高级检索编排。

### 2.2 硬约束

**rag 服务 stdlib-only 纪律**（`package.json.dependencies = {}`）：PDF/DOCX 解析不能引入 npm 解析器，只能走「外部解析旁路」（对齐 embed-server 模式：`RAG_LOADER_PDF_URL` 指向外部抽取服务）或可选依赖开关。

### 2.3 分期路线

**一期：loaders 接口 + 结构感知 splitter（≈ 3 人日）**
- `loaders.ts`：`DocumentLoader` 接口（`load(source): Promise<{text, meta}>`）；内置 `MarkdownLoader / TextLoader / UrlLoader`（fetch + 正文标签提取，纯 JS）；PDF/DOCX 走外部旁路 loader（env 配置，缺省关闭并明示）。
- `splitter.ts`：`recursiveSplitter`——按标题层级（#~####）→ 段落 → 句子递归切分，chunk 携带 `heading_path` 结构元数据（进 `Chunk.metadata`，Qdrant payload 天然支持）。
- 验收：多级标题 markdown 切分不跨标题断义、heading_path 正确；ingest→retrieve 端到端回归 rag 34 用例不红。

**二期：高级检索编排（≈ 3 人日）**
- ParentDocument（≈ 2d）：小块检索命中 → 按 `metadata.parent_id` 返回父块；需 splitter 同时产出父子两级 chunk（子检索/父返回），Memory 与 Qdrant 均为纯编排（payload 关联），无新依赖。
- multi-query（≈ 1d）：LLM 改写 3–5 个查询并行检索 → 按分数融合去重（复用 `generate.ts` LLM 抽象 + 既有融合逻辑）。
- HyDE（≈ 1d，可选）：假设文档检索，依赖 LLM，作为 `RAG_RETRIEVAL_MODE` 开关项。

**2.4 风险与验收**

- 风险：外部解析旁路的可用性依赖部署形态（缓解：loader 失败明确报错不静默，符合红线 3）；Qdrant scroll 聚合父块的分页成本（缓解：parent 聚合走 `getChunks` 既有分页）。
- 验收：`eval.ts` golden 问答集上，结构感知切分 + ParentDocument 相对固定滑窗基线 nDCG@5 不降且语义完整性（人工抽检）提升。

---

## 方案三：观测 / 评估生态（LangSmith 对位）

### 3.1 现状与差距

- 现有：per-step trace 采集（StepTraceNode → 检查点持久化）+ Prometheus metrics + structLog + Jev 决策观测 + RAGEvaluator + golden-set。
- 差距：① trace **随检查点易失**（服务重启/覆盖即丢，无跨 run 查询）；② golden 数据集无版本化与批跑对比；③ 无标准导出通道（接外部观测栈需逐家适配）。

### 3.2 方案选项

| 选项 | 设计 | 取舍 |
| --- | --- | --- |
| A. 自建轻量观测 | run 级 trace 落库（`run_traces` 表：runId/defId/steps trace JSON/用量/成本）+ 只读 API + 复用执行详情抽屉渲染 | 0 新依赖、复用已有组件与纪律；查询能力弱于 SaaS 但够用 |
| B. OTel 导出器 | LLM/工具调用按 OTel GenAI 语义约定（`gen_ai.*` span）导出，接入任意兼容后端 | 标准化最佳；依赖放 access 层避免污染 core |
| C. 接 Langfuse/LangSmith SaaS | 客户端 SDK 直传 | 数据出境与 BYOK 密钥合规问题，**不做** |

### 3.3 推荐路线：A 为主线，B 留接口

- **一期（≈ 2 人日）**：`run_traces` 落库（DbWorkflowStore 同款 DbAdapter，SQLite/PG 自动双支持）+ `GET /api/run-traces?runId=` + 抽屉「历史执行」入口（现在执行详情只看得到最新检查点，落库后可回看任意历史 run——与方案一的快照互补：快照管「状态可回放」，run_traces 管「过程可检索」）。
- **二期（≈ 2 人日）**：golden 数据集版本化（JSON 数据集文件 + 版本号）+ 批跑命令 + 与上一版的逐项 diff 报告（markdown），接入 CI 可选门禁。
- **三期（≈ 3 人日，可选）**：OTel 导出器（access 层可选项，`OTEL_EXPORTER_OTLP_ENDPOINT` 配置启用）。
- 验收：任一历史 run 的 LLM/工具/护栏事件可在抽屉按时间线还原（服务重启后仍可查）；golden 数据集改动一键批跑并输出与上版逐项对比。

---

## 总体排期建议（按价值/成本排序）

| 序 | 项 | 人日 | 理由 |
| --- | --- | --- | --- |
| 1 | 方案三一期：run_traces 落库 + 抽屉 | 2 | 直接解决「重启后过程不可查」，复用度最高 |
| 2 | 方案二一期：loaders + 结构感知 splitter | 3 | RAG 实用性主缺口 |
| 3 | 方案一 A：快照内嵌 + rollback | 3–4 | 可靠性补完，与现有恢复链最贴 |
| 4 | 方案二二期：ParentDocument / multi-query | 3 | 检索质量增益 |
| 5 | 方案三二期：golden 数据集批跑 | 2 | 回归防线固化 |
| 6 | 方案一 B / 方案三三期 OTel | 按需 | 触发条件：长 run 回放需求 / 外部观测对接需求 |

合计 ≈ **11–15 人日**；全部完成后，对比文档 §7 的三项「不对齐」仅剩「LangSmith SaaS 级闭环」一项以「自建 + 标准导出」形式覆盖（C 路线明确不做）。
