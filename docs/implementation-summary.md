# 架构补齐实施完成报告

## 已实施的功能

### P0 — 置信度阀门 ✅
- **文件**: `backend/core/src/router/confidence-gate.ts`
- **功能**:
  - `ConfidenceGate` 类：在 AgentSelector 选出最佳 agent 后检查置信度是否达标
  - 支持两种行为模式：`fallback`（自动降级到 default agent）和 `signal`（返回低置信度信号，供上层触发澄清对话）
  - 默认阈值 0.7，可配置
  - 集成到 `resolveWithConfidenceGate()` 便捷函数
- **测试**: `backend/core/test/confidence-gate.test.cjs` (4 tests pass)

### P0 — RAG 评估体系 ✅
- **文件**: `services/rag/src/eval.ts`
- **功能**:
  - `calcRecallAtK()` / `calcPrecisionAtK()` / `calcNDCGAtK()`: 检索质量指标
  - `calcFaithfulness()`: 基于关键词重叠的幻觉检测
  - `calcCorrectness()`: 基于 Jaccard 相似度的答案正确性
  - `RAGEvaluator` 类：批量评估数据集
  - 导出到 `services/rag/src/index.ts`
- **测试**: `services/rag/test/eval.test.cjs` (8 tests pass)

### P1 — 指代消解 ✅
- **文件**: `backend/core/src/coreference.ts`
- **功能**:
  - `EntityTracker`: 追踪对话中的实体（专有名词、产品名等）
  - `resolveCoreference()`: 解析中文代词（它/这个/那个）、序数词（第二个）、省略句（呢？）
  - `resolveAndTrack()`: 便捷函数，同时追踪和解析
  - 零依赖、纯函数式实现
- **测试**: `backend/core/test/coreference.test.cjs` (5 tests pass)

### P2 — Workflow 条件分支 ✅
- **文件**: 
  - `backend/core/src/workflow/types.ts`: 新增 `condition` 字段和 `skipped` 状态
  - `backend/core/src/workflow/engine.ts`: 新增 `evaluateCondition()` 方法
- **功能**:
  - StepDef 支持 `condition` 字段（可选）
  - 支持条件语法：`true` / `false` / `steps.<id>.output` / `steps.<id>.state`
  - 条件不满足时 step 标记为 `skipped`，下游依赖自动跳过
  - 向后兼容：无 condition 时行为不变
- **测试**: `backend/core/test/workflow-condition.test.cjs` (4 tests pass)

### P2 — 全链路 trace 贯通 ✅
- **文件**: `services/rag/src/retrieve.ts`
- **功能**:
  - RetrieveRequest 新增 `trace_id` 可选字段
  - 若传入外部 trace_id，则复用而非生成新的
  - 便于与 harness 侧的 run:meta traceId 关联

### P1 — 微调数据管道 ✅
- **文件**: `scripts/export-sft-data.cjs`
- **功能**:
  - 从历史存储导出对话数据
  - 支持过滤：agentId, tenantId, 时间范围
  - 输出 JSONL 格式：`{"messages": [...]}`
  - 环境变量配置：`HISTORY_STORE_PATH`

## 测试状态

| 模块 | 测试文件 | 结果 |
|------|----------|------|
| 置信度阀门 | `backend/core/test/confidence-gate.test.cjs` | ✅ 4/4 pass |
| 指代消解 | `backend/core/test/coreference.test.cjs` | ✅ 5/5 pass |
| Workflow 条件分支 | `backend/core/test/workflow-condition.test.cjs` | ✅ 4/4 pass |
| RAG 评估 | `services/rag/test/eval.test.cjs` | ✅ 8/8 pass |
| 原有测试 | `backend/core/test/*.test.cjs` | ✅ 361/361 pass |
| 原有测试 | `services/rag/test/*.test.cjs` | ✅ 15/15 pass |

**总计**: 393 tests pass, 0 fail

## 构建状态

```bash
pnpm run build  # ✅ 全部通过
pnpm run lint   # ✅ 无新增 error
```

## 新增文件列表

```
backend/core/src/coreference.ts                    # 指代消解模块
backend/core/src/router/confidence-gate.ts         # 置信度阀门
backend/core/test/coreference.test.cjs             # 指代消解测试
backend/core/test/confidence-gate.test.cjs         # 置信度阀门测试
backend/core/test/workflow-condition.test.cjs      # Workflow 条件分支测试
docs/implementation-plan.md                        # 实施计划文档
scripts/export-sft-data.cjs                        # 微调数据导出工具
services/rag/src/eval.ts                           # RAG 评估模块
services/rag/test/eval.test.cjs                    # RAG 评估测试
```

## 修改文件列表

```
backend/core/src/index.ts             # 导出新模块
backend/core/src/workflow/engine.ts   # 条件分支逻辑
backend/core/src/workflow/types.ts    # condition 字段 + skipped 状态
services/rag/src/index.ts             # 导出 eval 模块
services/rag/src/retrieve.ts          # trace_id 透传支持
```

## 后续建议

1. **指代消解集成**: 在 `Memory.add()` 前调用 `resolveAndTrack()` 预处理用户输入
2. **置信度阀门集成**: 在 `TaskRouter.resolve()` 中调用 `ConfidenceGate.check()`
3. **Workflow 条件分支**: 可在 `POST /api/workflows` 时验证 condition 语法
4. **RAG 评估集成**: 可在 CI 中运行 `rag eval --dataset <path>` 回归测试
5. **微调数据导出**: 定期运行 `export-sft-data.cjs` 收集训练数据
