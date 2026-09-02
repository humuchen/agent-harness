# 记忆系统与上下文压缩机制

## 概述

agent-harness 实现了一个三层、可插拔的记忆系统：短期滑动窗口、长期笔记、压缩摘要。
上下文压缩机制位于 `backend/core/src/` 核心层，由 `access/server/src/runner.ts`
在装配阶段配置。

## 1. 记忆数据模型 — `backend/core/src/memory.ts`

### `Memory` 类三层状态

| 层级 | 字段 | 说明 |
|---|---|---|
| **短期窗口** | `window: Message[]` | 对话滚动窗口，默认 20 条（`MEMORY_WINDOW`），超过后滑动淘汰 |
| **长期笔记** | `longTerm: string[]` | 通过 `remember()` 写入，注入系统提示词作为长期上下文 |
| **压缩摘要** | `summaryText: string \| null` | 上下文压缩产物，定为一条 `system` 消息固定保留 |

### 窗口结构约束

```
window 结构约束：
  - 真实 system 提示词（SYS）永远在最前，无法被淘汰
  - 至多 1 条【历史摘要】system 节点（压缩摘要，随淘汰旧轮次更新）
  - 预留 1 个「摘要槽位」：即使摘要为空，槽位也保留，防止窗口超出 maxWindow
```

## 2. 存储后端 — `backend/core/src/memory-store.ts`

### 三种后端（均零 npm 依赖）

| 后端 | 环境变量 | 说明 |
|---|---|---|
| `VolatileMemoryStore` | `MEMORY_BACKEND=volatile` | 纯内存 Map，无持久化 |
| `FileMemoryStore` | `MEMORY_BACKEND=file` 或 `MEMORY_DIR` | 按 `sessionKey` 分桶 JSON 文件，原子写（tmp+rename），崩溃安全 |
| `SqliteMemoryStore` | `MEMORY_BACKEND=sqlite`（默认） | Node 22+ 内置 `node:sqlite`，多租户生产推荐 |

### `PersistedMemory` 接口

```typescript
interface PersistedMemory {
  window: Message[];       // 滑动窗口
  longTerm: string[];      // 长期笔记
  summary?: string;        // 压缩摘要（可选）
}
```

### 进程内缓存

- `sessionMemories: Map<string, Memory>` — 按 `sessionKey` 复用进程内 Memory 实例，实现连续对话
- LRU 淘汰：`SESSION_MEMORY_MAX=256`（默认），淘汰最久未使用的 session 记忆
- `invalidateSessionMemory(sessionKey)` — 清空某 session 的进程内缓存

## 3. 滑动窗口淘汰 + 压缩逻辑 — `memory.ts` `add()` 方法

当 `window.length > maxWindow` 时触发淘汰：

1. **区分 system 消息**：真实 system 提示词永远保留在最前；仅淘汰非 system 消息 + 旧的过期摘要
2. **计算预算**：`budget = maxWindow - sys.length - (summarizer ? 1 : 0)` —— 若有 summarizer，预留 1 个槽位给摘要
3. **淘汰最旧轮次**：`evicted = rest.slice(0, rest.length - budget)`
4. **调用 summarizer**：
   - **同步返回**（启发式）：立即写入 `summaryText`，插入 `【历史摘要】\n...` system 节点
   - **异步返回**（LLM）：暂存 `pendingSummary` Promise，窗口先**不含**摘要节点；等待 `flushSummary()` 落地后补入

### `flushSummary()` 方法

```typescript
async flushSummary(): Promise<void> {
    if (!this.hasPendingSummary || !this.pendingSummary) return;
    const s = await this.pendingSummary;
    this.summaryText = s || null;
    this.pendingSummary = null;
    this.hasPendingSummary = false;
    // 重建窗口：sys + summaryNode + rest
    ...
}
```

**关键设计**：`MemorySummarizer` 契约允许返回 `string | Promise<string>`，
异步摘要器不会阻塞 `add()`。摘要在 `harness.ts` 主循环顶部 `await memory.flushSummary()` 落地。

## 4. 摘要器类型 — `access/server/src/runner.ts`

### 启退控制

| 开关 | 变量 | 默认 | 说明 |
|---|---|---|---|
| **特性开关** | `CONTEXT_COMPRESSION` | `false` | 环境变量或 `features.isEnabled('contextCompression')` |
| **模式选择** | `COMPRESSION_MODE` | `heuristic` | `heuristic` / `llm` |
| **窗口大小** | `MEMORY_WINDOW` | `20` | 滑动窗口最大消息数 |

### 装配逻辑

```typescript
const enableCompression = isEnabled('contextCompression');
const compressionMode = (process.env.COMPRESSION_MODE || 'heuristic').toLowerCase();
const useLlmSummarizer = enableCompression && compressionMode === 'llm' && llmKind === 'openrouter';

let summarizer: MemorySummarizer | undefined;
if (enableCompression) {
    summarizer = useLlmSummarizer ? createLLMSummarizer(llm, accountModel) : heuristicSummarizer;
}
```

> **注意**：即使设置 `COMPRESSION_MODE=llm`，在 `mock` 模式下也会自动回退为启发式摘要（因为 LLM 不可用）。

### 启发式摘要器

```typescript
const heuristicSummarizer: MemorySummarizer = ({ previous, evicted }) => {
    // 统计 user 请求数 / tool 调用数 / 工具清单
    // 生成固定模板摘要
    // 增量合并: previous.slice(-220) + 新摘要，避免跨多次压缩无限膨胀
};
```

### LLM 摘要器

```typescript
function createLLMSummarizer(llm, modelLabel): MemorySummarizer {
    const SYSTEM = '你是上下文压缩器。...';
    return async ({ previous, evicted }) => {
        // 把 evicted 轮次拼接为 transcript
        // 调用 LLM 生成 ≤400 字摘要
        // 失败时回退到 previous 摘要
    };
}
```

## 5. 主循环集成 — `backend/core/src/harness.ts`

```
for (let step = 0; step < maxSteps; step++) {
    await memory.flushSummary();   // ← 每步顶部落地异步摘要
    // ... 预算熔断检查
    const messages = memory.history();  // 读取包含摘要的节点窗口
    // ... LLM 调用
    // ... tool 执行
    memory.add(userMsg);
    memory.add(assistantMsg);
    memory.add(toolResult);
}
```

## 6. 跨运行记忆恢复

- `hasPersistence` 时，`harness.run()` 会先 `load()` 历史，执行后 `save()` —— 摘要随持久化保存/恢复
- `load()` 恢复时会从 `data.summary` 字段恢复 `summaryText`，并在窗口中重建摘要节点

## 7. 长期记忆注入

`Memory.systemContext()` 将 `longTerm` 笔记拼接为：
```
Long-term memory:\n- note1\n- note2
```
并注入系统提示词，实现跨 run 的长期上下文传递。

## 配置汇总

| 配置项 | 环境变量 | 默认值 | 作用域 |
|---|---|---|---|
| 上下文压缩开关 | `CONTEXT_COMPRESSION` | `false` | 特性开关 (`feature-flags.ts`) |
| 压缩模式 | `COMPRESSION_MODE` | `heuristic` | `runner.ts` |
| 窗口大小 | `MEMORY_WINDOW` | `20` | `runner.ts` |
| 记忆后端 | `MEMORY_BACKEND` | `sqlite` | `runner.ts` (`getMemoryStore`) |
| 文件后端目录 | `MEMORY_DIR` | `./data/memory` | `runner.ts` |
| SQLite 数据库文件 | `MEMORY_SQLITE_FILE` | `./data/memory.db` | `runner.ts` |
| Session 缓存上限 | `SESSION_MEMORY_MAX` | `256` | `runner.ts` |
