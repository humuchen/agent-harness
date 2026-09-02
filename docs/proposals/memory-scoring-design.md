# 记忆打分机制设计方案

## 背景

当前 agent-harness 记忆系统采用固定大小的滑动窗口（默认 20 条）进行上下文管理。
当窗口溢出时，按 FIFO 顺序淘汰最旧的对话轮次，并通过 `MemorySummarizer`
将其压缩为一条 system 摘要固定保留。

长期记忆（`longTerm: string[]`）通过 `remember()` 写入，注入系统提示词时**无过滤**
直接拼接所有笔记。这种机制存在以下问题：

1. **淘汰盲目**：滑动窗口仅按顺序淘汰，无法保障重要对话优先保留
2. **长期记忆无排序**：`longTerm` 中的所有笔记同等对待，无法筛选与当前输入相关的内容
3. **缺乏重要性评估**：无法区分「用户强调的关键约束」与「例行工具调用日志」

## 设计目标

引入一个**打分机制**，在不增加外部依赖（零 npm 依赖）的前提下，对记忆条目进行
重要性评估，从而：

1. 在滑动窗口溢出时，**优先淘汰低分条目**，保留高分条目
2. 在长期记忆注入系统提示词时，**按相关性排序并裁剪**，只注入 Top-K 相关笔记
3. 通过 `features.isEnabled('memoryScoring')` 开关控制，默认关闭（向后兼容）

## 复用已有模式

项目中 `selectToolsForInput`（`backend/core/src/tools.ts`）已实现了一个
**零依赖的轻量分词打分**：

```typescript
// 中文按字符二元组，英文按连续词 → 词重叠打分
function tokenize(text: string): string[] { ... }
// score = 名称直接命中(×5) + 词重叠(长度感权)
```

记忆打分机制可沿用这一思路，扩展为**多维重要性评估**：

| 维度 | 来源 | 权重 | 说明 |
|---|---|---|---|
| **相关性** | 关键词重叠 | 0.4 | 与当前用户输入 / 上一轮输入的词重叠度 |
| **重要性** | 消息角色 + 内容长度 + 关键词 | 0.3 | user 提问 > tool 结果 > assistant 回复 |
| **频次** | 历史提及次数 | 0.2 | 被多次引用 / 回复的轮次 |
| **时效性** | 距当前轮次距离 | 0.1 | 越近权重越高（递减） |

## 实施方案

### 1. 新增 `MemoryScorer` 接口

位于 `backend/core/src/memory.ts`：

```typescript
/**
 * 记忆条目重要性打分器。
 * 在滑动窗口溢出或长期记忆注入时调用，对消息 / 笔记进行评分，
 * 决定淘汰优先级与排序顺序。
 */
export interface MemoryScorer {
  /**
   * 对窗口内的每条消息打分（0~1）。
   * @param messages 当前窗口全部消息
   * @param context 当前用户输入（用于相关性计算）
   * @returns 每条消息对应的分数
   */
  scoreWindow(messages: Message[], context: string): Promise<number[]>;

  /**
   * 对长期记忆笔记打分（0~1）。
   * @param notes 全部长期笔记
   * @param context 当前用户输入
   * @returns 每条笔记对应的分数
   */
  scoreNotes(notes: string[], context: string): Promise<number[]>;
}
```

### 2. 默认启发式打分器 — `HeuristicMemoryScorer`

零依赖实现，基于 `selectToolsForInput` 的分词打分扩展：

```typescript
export class HeuristicMemoryScorer implements MemoryScorer {
  /**
   * 多维打分：
   * - 相关性（0.4）：与 context 的词重叠度
   * - 重要性（0.3）：user 问 > assistant 回 > tool 结果
   * - 时效性（0.1）：越靠近最后一条消息权重越高
   * - 频次（0.2）：关键词重复次数
   */
  async scoreWindow(messages: Message[], context: string): Promise<number[]> {
    const contextGrams = new Set(tokenize(context));
    const scores: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      let score = 0;

      // 1. 相关性（0.4）
      const text = messageText(m);
      const grams = new Set(tokenize(text));
      let overlap = 0;
      for (const g of contextGrams) {
        if (grams.has(g)) overlap++;
      }
      const relevance = contextGrams.size > 0
        ? overlap / contextGrams.size
        : 0;
      score += relevance * 0.4;

      // 2. 重要性（0.3）
      if (m.role === 'user') score += 0.3;
      else if (m.role === 'assistant') score += 0.15;
      else if (m.role === 'tool') score += 0.1;

      // 3. 时效性（0.1） —— 越靠后权重越高
      score += (i / messages.length) * 0.1;

      scores.push(Math.min(score, 1.0));
    }
    return scores;
  }

  async scoreNotes(notes: string[], context: string): Promise<number[]> {
    const contextGrams = new Set(tokenize(context));
    return notes.map((note) => {
      const grams = new Set(tokenize(note));
      let overlap = 0;
      for (const g of contextGrams) {
        if (grams.has(g)) overlap++;
      }
      const relevance = contextGrams.size > 0
        ? overlap / contextGrams.size
        : 0;
      const lengthFactor = Math.min(note.length / 200, 0.2); // 篇幅越长重要性越高，上限 0.2
      return Math.min(relevance * 0.4 + lengthFactor * 0.2 + 0.2, 1.0);
    });
  }
}
```

### 3. Memory 集成 — 打分驱动的淘汰

在 `Memory.add()` 中，当窗口溢出时，改为**按分数淘汰**而非 FIFO：

```typescript
add(msg: Message): void {
  this.window.push(msg);
  if (this.window.length > this.opts.maxWindow) {
    const evicted = this.evictWithScoring();
    if (this.opts.summarizer) {
      // 原有 summarizer 逻辑，evicted 现在按分数排序
      // ...
    }
  }
}

/** 按分数淘汰低分条目，保留高分条目 */
private evictWithScoring(scorer?: MemoryScorer): Message[] {
  if (!scorer) {
    // 回退到原有 FIFO 淘汰
    return this.evictFIFO();
  }

  // 计算所有非 system 消息的分数
  const scores = scorer.scoreWindow(this.window, this.lastInput ?? '');
  const indexed = this.window.map((m, i) => ({ msg: m, score: scores[i] ?? 0 }));

  // system 提示词永远保留（最高分）
  const sys = indexed.filter((x) => x.msg.role === 'system');
  const rest = indexed.filter((x) => x.msg.role !== 'system');

  // 按分数升序排序，淘汰最低分的条目
  rest.sort((a, b) => a.score - b.score);

  const toEvict = rest.splice(0, rest.length - budget);
  this.window = [...sys.map((x) => x.msg), ...rest.map((x) => x.msg)];
  return toEvict.map((x) => x.msg);
}
```

### 4. 长期记忆的相关性过滤

在 `systemContext()` 中，按与当前输入的相关性排序，只注入 Top-K：

```typescript
/** 注入长期记忆到系统提示词，按相关性排序并裁剪 */
async systemContextWithContext(context: string, scorer?: MemoryScorer, topK: number = 10): Promise<string> {
  if (!scorer || this.longTerm.length === 0) {
    // 回退到原有行为
    return this.longTerm.length
      ? `Long-term memory:\n- ${this.longTerm.join('\n- ')}`
      : '';
  }

  const scores = await scorer.scoreNotes(this.longTerm, context);
  const indexed = this.longTerm.map((note, i) => ({ note, score: scores[i] ?? 0 }));
  indexed.sort((a, b) => b.score - a.score);

  const top = indexed.slice(0, topK).map((x) => x.note);
  return top.length
    ? `Long-term memory:\n- ${top.join('\n- ')}`
    : '';
}
```

**注意**：这会改变 `systemContext()` 同步为异步，或新增一个异步变体。
`harness.ts` 主循环中需要调整调用时机。

### 5. 开关与配置

| 配置项 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| 记忆打分开关 | `MEMORY_SCORING` | `false` | `features.isEnabled('memoryScoring')` |
| 长期记忆 Top-K | `MEMORY_NOTES_TOPK` | `10` | 注入系统提示词的最大笔记数 |
| 相关性权重 | `MEMORY_SCORE_RELEVANCE` | `0.4` | 相关性打分维度权重 |
| 重要性权重 | `MEMORY_SCORE_IMPORTANCE` | `0.3` | 重要性打分维度权重 |
| 时效性权重 | `MEMORY_SCORE_RECENCY` | `0.1` | 时效性打分维度权重 |
| 频次权重 | `MEMORY_SCORE_FREQUENCY` | `0.2` | 频次打分维度权重 |

### 6. 与现有 summarizer 的协作

```
滑动窗口溢出流程（打分增强版）：

1. 计算所有消息重要性分数
2. 按分数排序，淘汰最低分的 (rest.length - budget) 条
3. 若淘汰的条目中有重要性较高的（score > 0.7），额外调用 summarizer 压缩
4. 低分条目直接丢弃，高分条目通过 summarizer 压缩后保留摘要
```

## 预期效果

| 场景 | 当前行为 | 打分优化后 |
|---|---|---|
| 窗口溢出 | 淘汰最旧轮次 | 淘汰最不重要轮次，保留用户强调的关键对话 |
| 长期记忆注入 | 拼接全部笔记 | 按相关性排序，裁剪到 Top-K，减少系统提示词体积 |
| 关键信息丢失 | 无法保证 | 高分条目优先保留，关键约束不会被盲目淘汰 |

## 实施优先级

1. **P1**：`HeuristicMemoryScorer` + `MemoryScorer` 接口 + 开关
2. **P2**：滑动窗口打分淘汰（淘汰低分条目而非 FIFO）
3. **P3**：长期记忆相关性排序 + Top-K 裁剪
4. **P4**：与 LLM summarizer 协作，高分条目通过 LLM 压缩而非直接丢弃
5. **P5**：统计记忆频次、用户显性反馈（👍/👎）作为打分信号
