# 生产部署检查单（评审 R7 落地）

> 定位：评审 R7 指出的三项「性能杠杆」**均非缺陷**，而是部署期配置决策。本页把散落在
> 各模块头注释与启动告警中的要求收敛为一页可勾选清单：每项给出变量、缺省值、生产建议、
> 验证方法与回退方式。
>
> 证据口径：所有变量名与缺省值均核对自源码（标注 file:line），与两份评审报告
> （`docs/05-analysis/project-health-review-2026-10-*.md`）配套使用；其中报告曾声称
> 「CONTEXT_COMPRESSION 默认关」一项已按源码更正（见 §1）。

---

## 1. 长对话成本护栏——**默认已在位，无需配置**（报告结论更正）

**源码事实**（`backend/core/src/harness.ts:488-501`）：每次发送 LLM 前**无条件**执行两级压缩——

1. `memory.foldStaleToolResults()`：把「N 组之前」的超长工具结果折叠为首尾摘要（不等预算击穿，每步主动执行）；
2. `memory.fitToBudget(budgetCap)`：确定性预算剪枝，目标占用 ≈ 上下文窗口的 68%（`0.8 × 0.85`）。

因此评审报告早先「未开启压缩时 token 成本随步数平方增长（O(steps²)）」的表述**已不成立**：
滑动窗口 + 每步主动折叠/剪枝使在途上下文有界。需要更正的两点认知：

| 项 | 事实 |
| --- | --- |
| `CONTEXT_COMPRESSION`（feature-flags.ts:33-38） | **已消费**（defaultValue=true）：`harness.ts` 默认 `Memory` 构造与 `runner.ts` 均据此装配启发式温摘要器——长对话超窗后旧轮次生成【历史摘要】节点保留语义锚点；显式设为非 `true`/`1`（`off`/`false`/`0` 等）即关闭、退回直接丢弃。不影响上述无条件两级预算剪枝（`foldStaleToolResults` + `fitToBudget`）。 |
| `JEV_CONTEXT_COMPRESS=on`（harness.ts:489-493） | 可选增强：在预算剪枝之后改用 Jev 重要性打分淘汰低分消息。需 Typesafe Jev 凭据；缺配/出错自动回落确定性剪枝。 |

**操作**：无必做项。长对话成本敏感的场景可评估开启 `JEV_CONTEXT_COMPRESS=on`；
**验证**：观察日志 `proactive context compression applied before LLM send`（harness.ts:495）；
**回退**：删除该变量即回到确定性剪枝。

---

## 2. RAG 生产路径——默认实现仅适用于冒烟/演示

默认组合是 `HashEmbedding`（确定性但无语义泛化，`services/rag/src/embed.ts:6` 自认）+
JSON 全量加载存储（`store.ts`）。文档量大时检索质量与内存/延迟均不可接受。生产部署必须
完成两项切换：

### 2.1 切远程 embedding

| 变量 | 缺省 | 生产建议 |
| --- | --- | --- |
| `RAG_EMBEDDING_API_KEY` | 空（缺省走 HashEmbedding） | 必配 |
| `RAG_EMBEDDING_BASE_URL` | `https://openrouter.ai/api/v1` | 按服务商调整 |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | 与索引维度一致 |

（证据：`services/rag/src/embed.ts:143-164`、`index.ts:11`）

### 2.2 切 qdrant 向量库

| 变量 | 缺省 | 生产建议 |
| --- | --- | --- |
| `RAG_STORE_BACKEND` | json | 设 `qdrant` |
| `QDRANT_URL` | 空（qdrant 模式必填，`qdrant.ts:70` 未配置即 fail-fast） | 必配 |
| `QDRANT_API_KEY` | 空 | 按部署 |
| `QDRANT_COLLECTION` | `rag_chunks` | 按命名规范 |

### 2.3 切换步骤与回退

1. 备份现有 JSON 索引（切换后语义与维度全变，**必须重建索引/回灌**，不可直接复用）；
2. 配置上表变量 → 重建索引 → 用 golden 回归套件跑 strict 门禁（`scripts/` 批跑 CLI，
   见 `docs/07-rag/`）→ 通过后放量；
3. **回退**：清掉上述变量即回默认实现（数据不互通，需各自维护）。

---

## 3. 数据库后端——仅多副本场景需要切换

单机 SQLite（WAL）默认即可；其单写者限制只在「跨会话高频写」或「多副本」场景成为瓶颈。

| 场景 | 操作 |
| --- | --- |
| 单实例 | 无操作。`DB_BACKEND` 缺省 sqlite（`backend/core/src/db-adapter.ts:4`）。 |
| 多副本 / 高频写 | `DB_BACKEND` 切 `mysql` 或 `postgres`（配对应连接 URL）。SQLite 方言 SQL 在适配器出口自动翻译（`db-dialect.ts`）；配置错误 fail-fast 不静默。 |

**多副本一致性自检**：`REPLICA_COUNT>1` 或设了 `REPLICA_ID` 时，启动自检（`server.ts:1988-2020`）
强制要求 `REDIS_URL` 已设且 `RUN_QUEUE_BACKEND=redis`、`AGENT_STORE=redis`，否则拒绝启动
（`REPLICA_CHECK=off` 可显式豁免，需自担风险）。teams 注册表（`TEAM_STORE`）缺省跟随
`AGENT_STORE`，无需单独配置。

---

## 4. 附：启动期会告警的其它生产必配项（速查）

以下项在源码中有明确的启动告警/默认值反转记录，集中备查：

| 变量 | 缺省 | 生产要求 | 证据 |
| --- | --- | --- | --- |
| `AH_AUTH_SECRET` / `AH_CRYPTO_KEY` | 未配置 → 每进程随机密钥，重启即全部会话失效 | **必配 64hex**（server.ts:398-400 启动告警） | server.ts:398 |
| `LOG_SCRUB_ENABLED` | `true`（P1-8 默认值反转） | 保持默认；仅本地调试临时关闭 | server.ts:403-406 |
| `MAX_SSE_CONNECTIONS` | 非零上限（P1-8 反转） | 保持默认 | run-queue.ts |
| `RUN_QUEUE_BACKEND` / `AGENT_STORE` | memory | 多副本必须 `redis`（自检拦截） | server.ts:1994-2003 |
| `TEAM_STORE` | 跟随 `AGENT_STORE` | 多副本无需单独设置 | server.ts:2066-2069 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 空（零开销跳过） | 需要分布式追踪时配置（此前「定义了但从未接通」已修复，见回归清单 #8） | server.ts:2108-2116 |
| `AGENT_SWEEP_INTERVAL_MS` / `AGENT_STALE_TIMEOUT_MS` | 60000 / 30000 | 保持默认（远程 agent 心跳超时自动下线） | server.ts:2070-2082 |
