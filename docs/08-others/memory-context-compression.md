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

`Memory.add()` 在每次写入后检查**两类**触发条件，任一命中即进入淘汰：

- **条数溢出**（`window.length > maxWindow`）：常规滑动窗口。
- **token 护栏溢出**（`lastPromptTokens / lastWindow ≥ compressThreshold`，默认 0.8）：
  独立于 `CONTEXT_COMPRESSION` 特性开关的安全兜底——即便未开启摘要也会触发 FIFO 淘汰，
  避免大上下文撑爆后模型直接 400。占用率由 harness 在发射 `llm:usage` 时经 `setContextUsage()` 喂入。

淘汰流程（`rest` 为剔除真实 system 后的可淘汰部分，且保留各自在 `window` 中的原始下标供打分器对齐）：

1. **区分 system 消息**：真实 system 提示词永远保留在最前；仅淘汰非 system 消息 + 旧的过期摘要。
2. **计算双预算并取交集**：
   - 条数预算 `countBudget = maxWindow - sys.length - (summarizer ? 1 : 0)`；
   - token 预算 `tokenBudget = keepWithinTokenBudget(rest, tokenTarget)`，`tokenTarget` 由
     `computeOvershoot()` 反推（目标历史 = 当前历史 − 超出量，而非旧实现的固定比例，避免固定开销
     （长系统提示 + 大工具 schema）导致压缩空转）；
   - `budget = min(countBudget, tokenBudget)`，二者任一触发都要满足。
3. **原子组对齐**（`alignEvictionCut` + `groupIndexOf`）：切点必须落在「原子组」边界上——
   `assistant(tool_calls)` 必须与其后随的全部 `tool` 结果同组整体保留/淘汰，绝不能从中间切断
   （否则留下孤儿 tool 结果 / 孤儿 tool_call，provider 会以 400 `invalid_request_error` 拒绝）。
   同时**最后一组（当前轮次）永不淘汰**，避免刚拿到的工具结果被自己挤掉。
4. **调用 summarizer**：
   - **同步返回**（启发式）：立即写入 `summaryText`，插入 `【历史摘要】\n...` system 节点
   - **异步返回**（LLM）：暂存 `pendingSummary` Promise，窗口先**不含**摘要节点；等待 `flushSummary()` 落地后补入
5. **token 护栏兜底（内容瘦身 `shrinkToTokenBudget`）**：组对齐淘汰受「当前轮次不可切」限制，可能压不到目标
   （例如最后一组本身就是大体积工具结果）。此时对大消息做**内容瘦身**——保留消息本体与 `tool_call_id`、
   只压缩正文——既真实降低上下文占用，又绝不破坏 tool 配对。分两级：先保护当前轮次，仍不达标再放行瘦身当前轮次自救。

### 压缩标记 `compressed` 的语义（per-report）

- `compactCount`：会话级累计压缩（淘汰/瘦身）次数，供运维视图。
- `_compressedSinceReport`：**自上次用量上报以来**是否压缩过，`consumeCompressed()` 读取即清零
  （per-report 语义）。前端「已压缩」徽标据此渲染，**不做会话级 OR 累加**——否则会重现
  「徽标亮起后永不消失、与真实用量变化脱钩」的假象。
- **仅「token 压力驱动的额外淘汰/瘦身」会置位该标记**，而非任意淘汰。判定依据：
  `memory.ts` 的 `add()` 中 `tokenBudget < countBudget`（token 约束比 maxWindow 条数约束更紧，
  即本次淘汰超出了常规滑动所需），或 token 护栏的内容瘦身（`shrinkToTokenBudget`）、
  或发送前的主动 `fitToBudget` 真正改动了历史。
  - 单纯因 `maxWindow` 超限的 FIFO 轮转**不算压缩**，不会点亮徽标——否则窗口填满后每步都滑动，
    徽标会随每次询问永久点亮（"每次都显示已压缩"的误报正源于此）。
  - 因此徽标只在「上下文被主动压低」时点亮，窗口回落、无 token 压力时自动熄灭。

### 工具调用 ↔ 结果配对的「双保险」（修复 tool id 未找到 400）

压缩层只保证「历史淘汰不切断配对」，但配对断裂还可能发生在**解析**与**发送**两处，均已加固：

1. **解析端** `normalizeToolCallIds(shared.ts)`：模型返回的 `tool_calls` 若缺失 id 或 id 重复，
   统一补齐为稳定唯一的 id（`call_${i}_${Date.now().toString(36)}` 或 `${raw}__dup${i}`），
   避免空/重复 id 进入记忆后被后续淘汰逻辑误判。
2. **发送端** `sanitizeToolPairing(harness.ts)`：在把 `memory.history()` 交给 LLM **之前**清洗副本——
   丢弃无对应 pending call id 的孤儿 tool 结果、丢弃缺 id 的 tool_call、剥离末步被预算截断而
   缺结果的孤儿 tool_call。**只改发送副本，不动 Memory 存储**。
3. **兜底补齐**：harness 工具执行循环对超时/取消/预算截断而**未真正执行的调用**，统一回填占位
   tool 结果（`[aborted]` / `[skipped]`），保证 `tool_calls` 与结果严格一一对应。

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

    // ① 主动压缩（主流做法：发送前按真实 payload 估算封顶，而非被动等调用失败再补救）。
    //    预算 = min( 窗口 × 0.8 × 0.85, 已成功接收的最大 prompt × 0.7 )。
    //    免费模型真实窗口常远小于回退值 128K，故用「自适应已接收上限」做硬约束，
    //    避免 100% 卡死无回应。
    const budgetCap = ...;
    if (memory.fitToBudget(budgetCap)) { /* 记录压缩发生 */ }

    // ② 发送前经 sanitizeToolPairing 清洗：丢弃孤儿 tool 结果 / 缺 id 的 tool_call，
    //    剥离末步被截断的孤儿 tool_call（只改发送副本，不动 Memory 存储）
    let messages = sanitizeToolPairing(memory.history());

    // ③ LLM 调用（解析端经 normalizeToolCallIds 补齐缺失/重复 id）——
    //    包在「溢出自愈」重试环里：若 LLM 返回「超出上下文窗口」类错误
    //    （覆盖 400/413 及中英文文案，含 MiniMax 等免费模型），逐步 fitToBudget
    //    压缩历史后重试（最多 OVERFLOW_MAX_RETRIES=4 次），而非让整轮运行失败。
    //    首次成功后将 resp.usage.prompt_tokens 记为 maxAcceptedPrompt，
    //    后续步直接用其 0.7 倍作为保守预算上限，避免反复溢出。
    // ... tool 执行（超时/取消/预算截断的调用统一回填占位结果，保证一一对应）
    memory.add(userMsg);
    memory.add(assistantMsg);      // assistant(tool_calls) 与 tool 结果以原子组写入
    memory.add(toolResult);
    // 发射 llm:usage 时经 consumeCompressed() 上报「自上次上报以来是否压缩」，读取即清零
}
```

### 为什么需要「主动压缩 + 溢出自愈」（而非仅依赖被动护栏）

旧实现只在 `memory.add()` 里**被动**触发压缩，且依赖 `setContextUsage` 回灌的
`promptTokens / window >= 0.8`。但对免费模型（如 `minimax-m2.7:free`），前端模型目录
取不到真实 `context_length`，后端回退到 `128000`，导致真实已占满 ~32K 窗口时
`ratio` 仅 ~25%，**压缩护栏永不触发**；而 `maxWindow=20` 只裁条数不裁体积，巨大 tool
结果仍把真实 payload 撑爆 → 模型 400 / 无回应。主动压缩在**发送前**按真实 payload 估算
封顶，溢出自愈则在调用失败时按真实 `prompt_tokens` 逐次收窄重试，二者结合彻底消除
「显示已压缩但用量不变、最终 100% 卡死」的现象。

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
| 压缩触发阈值（token 占用率） | `compressThreshold` | `0.8` | `Memory` 选项，由 `runner.ts` 装配；独立于特性开关的 token 护栏 |
| 记忆后端 | `MEMORY_BACKEND` | `sqlite` | `runner.ts` (`getMemoryStore`) |
| 文件后端目录 | `MEMORY_DIR` | `./data/memory` | `runner.ts` |
| SQLite 数据库文件 | `MEMORY_SQLITE_FILE` | `./data/memory.db` | `runner.ts` |
| Session 缓存上限 | `SESSION_MEMORY_MAX` | `256` | `runner.ts` |
