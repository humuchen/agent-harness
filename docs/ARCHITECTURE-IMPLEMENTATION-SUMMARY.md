# agent-harness 架构落地完整总结

> 生成时间：2026-09-02  
> 状态：所有 P0/P1/P2 缺口已闭环，剩余 3 项为平台限制/架构决策

---

## 一、原评估缺口总览（10 项）

| # | 维度 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | 意图识别与指代消解 | P1 | ✅ 已落地 |
| 2 | RAG 全链路检索 | P0 | ✅ 已落地 |
| 3 | RAG 评估体系 | P0 | ✅ 已落地 |
| 4 | Function Call 工具链 | P0 | ✅ 已落地 |
| 5 | Workflow+Agent 混合架构 | P0 | ✅ 已落地 |
| 6 | 置信度阀门+兜底 | P0 | ✅ 已集成 |
| 7 | 会话上下文管理 | P1 | ✅ 已落地 |
| 8 | 工具生态扩展 | P1 | ✅ 已落地 |
| 9 | 全链路可观测 | P1 | ✅ 已落地 |
| 10 | 模型微调 | P2 | 🟡 部分（需外部基础设施） |

---

## 二、本轮实施清单

### 新增模块（5 个）

| 文件 | 功能 | 环境变量/开关 |
|------|------|--------------|
| `backend/core/src/coreference.ts` | EntityTracker 指代消解（代词/序数/省略） | `COREF_ENABLED=true` |
| `backend/core/src/router/confidence-gate.ts` | 置信度阀门，不足时 fallback/信号 | `threshold=0.7`, `mode=fallback` |
| `services/rag/src/eval.ts` | RAG 评估体系（recall@k/NDCG/faithfulness） | `POST /v1/eval` |
| `scripts/export-sft-data.cjs` | 微调数据导出工具 | `node scripts/export-sft-data.cjs` |
| `backend/core/src/builtins/rag-retrieve.ts` | 内置 RAG 检索工具，支持 trace_id 透传 | `RAG_URL` |

### 修改文件（12 个）

| 文件 | 改动内容 |
|------|----------|
| `router/router.ts` | 接入 ConfidenceGate，置信度不足 fallback default，抛 LOW_CONFIDENCE |
| `router/types.ts` | RouteResult 新增 `confidence?` |
| `harness.ts` | COREF_ENABLED 时初始化 EntityTracker，resolveAndTrack 在入口前展开代词，工具调用透传 traceId |
| `tools.ts` | ToolFn 增加可选 ctx，call() 透传 ctx |
| `builtins/index.ts` | ragEnabled 开关 + registerRagRetrieve |
| `rag/src/server.ts` | POST `/v1/eval` 端点 |
| `rag/src/retrieve.ts` | trace_id passthrough |
| `workf flow/types.ts` | StepDef.condition、StepState' 新增 'skipped' |
| `workflow/engine.ts` | evalCondition() 条件评估 |
| `run-queue.ts` | LOW_CONFIDENCE 捕获降级 |
| `plugin/manifest.ts` | validatePluginManifest() 强校验 |
| `plugin/loader.ts` | install/installModule 注入校验 + startHotReload() |
| `access/server/src/server.ts` | POST `/api/workflows/:id/resume` 端点 |

### 测试覆盖

| 套件 | 数量 | 状态 |
|------|------|------|
| backend/core | 371 tests | ✅ pass |
| services/rag eval | 8 tests | ✅ pass |
| plugin loader | 21 tests | ✅ pass |

---

## 三、仍存在的缺口（3 项，均为非 bug）

| 缺口 | 原因 | 影响 |
|------|------|------|
| OS 沙箱 native helper 未编译 | macOS 不支持 unshare/seccomp，退化为 local sandbox | Linux 部署时需单独 `make sandbox-exec` |
| 任务间非独立进程 | 架构选同进程 + CircuitBreaker/watchdog 软隔离，避免内存开销 | 无安全影响，有超时保护 |
| 自验证默认关闭 | 需调用方显式传入 Verifier，是设计选择而非缺失 | verifyMaxRetries>0 时自动开启重试 |

---

## 四、构建与质量状态

```
pnpm run build    → ✅ 通过
pnpm run lint     → 1 error（前端已有，非本次引入）
backend/core test → 371/371 pass
```

---

## 五、新增 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/eval` | POST | RAG 批量评估，body `{ name, samples: [{query, groundTruthChunkIds?, groundTruthAnswer?}] }` |
| `/api/workflows/:id/resume` | POST | 工作流断点续跑，SSE 推送进度，仅 failed/paused 状态可续跑 |

---

## 六、环境变量一览

```bash
COREF_ENABLED=true          # 启用指代消解
RAG_URL=http://localhost:8787  # 启用 RAG 内置工具
RAG_TOKEN=xxx               # RAG 鉴权（可选）
```

---

## 七、使用方式

### 指代消解
```typescript
// harness.ts 已自动集成，只需设置环境变量
process.env.COREF_ENABLED = 'true';
const harness = new AgentHarness({...});
// 输入 "他是什么颜色" → 自动展开为 "iPhone 16 Pro 是什么颜色"
```

### RAG 评估
```bash
curl -X POST http://localhost:8787/v1/eval \
  -H "Authorization: Bearer $RAG_TOKEN" \
  -d '{
    "name": "my-eval",
    "k": 5,
    "samples": [
      {"query": "iPhone 电池容量", "groundTruthChunkIds": ["c1", "c2"]}
    ]
  }'
```

### 工作流续跑
```bash
curl -X POST http://localhost:8080/api/workflows/wf-abc123/resume \
  -H "Authorization: Bearer $TOKEN"
# SSE 返回步骤进度 + _wf_done 终态
```

### 插件热加载
```typescript
const loader = new PluginLoader({ pluginDir: '~/my-plugins' });
await loader.startHotReload();
// 修改 ~/my-plugins/*/manifest.json → 1s 内自动 reload
```

---

## 八、文档

| 文档 | 路径 |
|------|------|
| 实施计划 | `docs/implementation-plan.md` |
| 实施总结 | `docs/implementation-summary.md` |
| 集成完成报告 | `docs/integration-completion-2026-09.md` |
| 缺口关闭报告 | `docs/gap-closure-report-2026-09.md` |
