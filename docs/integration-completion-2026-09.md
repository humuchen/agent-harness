# 架构缺口集成完成报告

## 本次实施（2026-09-02）

将上一轮创建的模块从「孤立代码」集成到实际运行链路。

---

## 改动清单

| 文件 | 改动内容 |
|------|----------|
| `backend/core/src/router/router.ts` | 接入 ConfidenceGate，置信度不足时 fallback，异常时由调用方捕获 |
| `backend/core/src/router/types.ts` | RouteResult 新增 `confidence?: number` 字段 |
| `backend/core/src/harness.ts` | 启用 `COREF_ENABLED=true` 时调 resolveAndTrack() 展开指代；工具调用透传 traceId |
| `backend/core/src/tools.ts` | ToolFn 签名增加可选 ctx 参数；ToolRegistry.call() 透传 ctx |
| `backend/core/src/builtins/index.ts` | 新增 `ragEnabled` 开关；注册 builtin__rag_retrieve |
| `backend/core/src/builtins/rag-retrieve.ts` | **新文件**：RAG 检索内置工具，支持 trace_id 透传、超时、降级 |
| `services/rag/src/server.ts` | 新增 `POST /v1/eval` 评估端点 |
| `access/server/src/run-queue.ts` | 捕获 LOW_CONFIDENCE 异常并发 warn 事件，降级到 default agent |
| `backend/core/test/rag-retrieve.test.cjs` | **新文件**：RAG 工具注册测试 |

---

## 各维度落地状态（最终版）

| # | 维度 | 状态 | 说明 |
|---|------|------|------|
| 1 | 意图识别与指代消解 | ✅ **已集成** | 指代消解模块 → harness 入口（COREF_ENABLED）；意图识别一直有效 |
| 2 | RAG 全链路检索 | ✅ **已落地** | embed/bm25/rerank/cache/trace + builtin__rag_retrieve 工具 |
| 3 | RAG 评估体系 | ✅ **已落地** | eval.ts + POST /v1/eval 端点 |
| 4 | Function Call 工具链 | ✅ **已落地** | ToolCall 类型 + Harness 执行 + defineTool + builtin__rag_retrieve |
| 5 | Workflow+Agent 混合架构 | ✅ **已落地** | DagEngine + 条件分支 + 补偿回滚 + 续跑 |
| 6 | 置信度阀门+兜底 | ✅ **已集成** | ConfidenceGate → TaskRouter，LOW_CONFIDENCE 由 run-queue 捕获降级 |
| 7 | 会话上下文管理 | ✅ **已落地** | Memory + HeuristicMemoryScorer + 打分淘汰 |
| 8 | 工具生态扩展 | ✅ **已落地** | defineTool + builtins + MCP + PluginManifest + builtin__rag_retrieve |
| 9 | 全链路可观测 | ✅ **已落地** | OTLP telemetry + traceId 贯穿 harness→tool；workflow 事件流 |
| 10 | 模型微调 | 🟡 **部分** | export-sft-data.cjs 已建，训练管道需外部基础设施 |

---

## 测试结果

```
backend/core: 371 tests pass, 0 fail
services/rag eval.test.cjs: 8 tests pass
全部通过，构建干净
```

---

## 环境变量开关

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `COREF_ENABLED` | 关闭 | 启用指代消解预处理 |
| `RAG_URL` | 无 | 配置后自动启用 builtin__rag_retrieve |
| `RAG_TOKEN` | 无 | RAG 服务鉴权 token |
| `RAG_TIMEOUT_MS` | 10000 | RAG 工具调用超时 |

---

## API 端点

```
POST /v1/eval  — RAG 批量评估
  Body: { name, k?, samples: [{ query, groundTruthChunkIds?, groundTruthAnswer? }] }
  Response: { dataset, sampleCount, metrics: [{name, value, unit}], sampleResults? }

工具 builtin__rag_retrieve（配置 RAG_URL 后自动可用）
  Arguments: { query, top_k?, score_threshold?, trace_id? }
  Response: { trace_id, n_results, latency_ms, results: [{chunk_id, score, content}] }
```

---

## 后续建议

1. **微调训练管道**：接 SFT 训练脚本（如 LLaMA-Factory），定期用 export-sft-data.cjs 产出数据集
2. **结果断言验证**：在 verify gate 中引入断言式验证（PASS_TO_PASS），目前仅过程级验证
3. **整轮重试**：run 失败时依据错误类型自动重投（当前仅 LLM/MCP 故障自动处理）
4. **OS 级沙箱**：Linux 上编译 sandbox-exec.c 并使用 `sandbox-backend=os`，macOS 退化为 hardened local
