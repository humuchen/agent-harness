/**
 * 指代消解器（P1）：把多轮对话中的代词/省略解析为完整实体引用。
 *
 * 设计目标：
 * - 支持中文代词映射（它/它们/这个/那个 → 前文名词）
 * - 支持省略补全（"第二个呢？" → "查询第二个 [实体]？"）
 * - 基于实体追踪表（EntityTracker）记录每轮出现的专有名词
 * - 零依赖、纯函数式，结果可缓存
 *
 * 使用场景：
 * - Memory 层在 add() 前预处理用户输入
 * - 路由层在 classify() 前展开指代
 */

export interface EntityReference {
  /** 原文中出现的指代表达 */
  mention: string;
  /** 解析后的实际实体 */
  resolved: string;
  /** 来源轮次（0 = 当前轮，>0 = 历史轮） */
  sourceTurn?: number;
}

export interface CorefResult {
  /** 是否发生了指代解析 */
  hasCoreference: boolean;
  /** 解析结果列表 */
  references: EntityReference[];
  /** 展开后的完整输入 */
  expandedInput: string;
}

/** 中文代词映射表 */
const PRONOUN_MAP: Record<string, string> = {
  // 单数
  '它': '该实体',
  '它的': '该实体的',
  '这个': '该实体',
  '这个的': '该实体的',
  '那个': '该实体',
  '那个的': '该实体的',
  '此': '该实体',
  '其': '该实体',
  '其的': '该实体的',
  // 复数
  '它们': '这些实体',
  '它们的': '这些实体的',
  '这些': '这些实体',
  '这些的': '这些实体的',
  '那些': '这些实体',
  '那些的': '这些实体的',
  // 人称代词（需要结合上下文）
  '他': '该用户',
  '她': '该用户',
  '他们': '这些用户',
  '她们': '这些用户',
};

/** 序数词映射 */
const ORDINAL_MAP: Record<string, number> = {
  '第一': 1,
  '首个': 1,
  '第一个': 1,
  '第二': 2,
  '第二个': 2,
  '第三': 3,
  '第三个': 3,
  '第四': 4,
  '第四个': 4,
  '第五': 5,
  '第五个': 5,
};

/**
 * 实体追踪器：记录对话历史中出现的实体，供指代消解使用。
 */
export class EntityTracker {
  private entities: Array<{ text: string; turn: number; type: 'person' | 'thing' | 'concept' }> = [];
  private entityCounts = new Map<string, number>();

  /** 追踪本轮输入中出现的新实体 */
  trackTurn(input: string, turn: number): void {
    // 简单启发式：识别连续大写字母词、中文专有名词（含特定标记）
    const newEntities = extractEntities(input);
    for (const entity of newEntities) {
      this.entities.push({ ...entity, turn });
      const count = this.entityCounts.get(entity.text) ?? 0;
      this.entityCounts.set(entity.text, count + 1);
    }
  }

  /** 获取最新出现的实体（用于代词解析） */
  getLatestEntity(n = 1): string[] {
    return this.entities
      .slice(-n)
      .map((e) => e.text);
  }

  /** 获取按出现频率排序的实体 */
  getTopEntities(limit = 5): string[] {
    return [...this.entityCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([text]) => text);
  }

  /** 清空追踪器 */
  clear(): void {
    this.entities = [];
    this.entityCounts.clear();
  }
}

/** 从文本中提取实体（简化版：识别连续大写字母词、中文专有名词） */
function extractEntities(text: string): Array<{ text: string; type: 'person' | 'thing' | 'concept' }> {
  const results: Array<{ text: string; type: 'person' | 'thing' | 'concept' }> = [];
  
  // 英文大写词（公司名、产品名等）
  const enProper = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  for (const w of enProper) {
    if (w.length > 2) {
      results.push({ text: w, type: 'thing' });
    }
  }
  
  // 中文专有名词（含特定后缀）
  const zhProper = text.match(/[\u4e00-\u9fa5]{2,}(?:公司|银行|医院|学校|产品|项目|系统|平台|服务)/g) || [];
  for (const w of zhProper) {
    results.push({ text: w, type: 'thing' });
  }
  
  // 去除重复
  const seen = new Set<string>();
  return results.filter((e) => {
    if (seen.has(e.text)) return false;
    seen.add(e.text);
    return true;
  });
}

/**
 * 核心指代消解函数。
 * @param input 当前轮用户输入
 * @param tracker 实体追踪器（包含历史实体信息）
 * @param history 历史消息数组（用于更精确的解析）
 */
export function resolveCoreference(
  input: string,
  tracker: EntityTracker,
  history: Array<{ role: string; content: string }> = []
): CorefResult {
  const references: EntityReference[] = [];
  let expanded = input;

  // 1. 代词替换
  for (const [pronoun, replacement] of Object.entries(PRONOUN_MAP)) {
    if (expanded.includes(pronoun)) {
      // 获取最近的实体作为替代
      const latest = tracker.getLatestEntity(1);
      if (latest.length > 0) {
        const resolved = latest[0] ?? '';
        if (resolved) {
          references.push({
            mention: pronoun,
            resolved: resolved,
            sourceTurn: undefined,
          });
          expanded = expanded.split(pronoun).join(resolved);
        }
      }
    }
  }

  // 2. 序数词补全（"第二个" → "查询第二个 [实体]"）
  for (const [ordinal, num] of Object.entries(ORDINAL_MAP)) {
    if (expanded.includes(ordinal)) {
      const latest = tracker.getLatestEntity(1);
      if (latest.length > 0) {
        const resolved = latest[0] ?? '';
        if (resolved) {
          references.push({
            mention: ordinal,
            resolved: `${resolved}（第${num}个）`,
            sourceTurn: undefined,
          });
          // 补全省略部分
          expanded = expanded.replace(ordinal, `${resolved}（第${num}个）`);
        }
      }
    }
  }

  // 3. 省略句检测（"呢？" "怎么样？" "好吗？"）
  const ellipsisPatterns = [/^[^？?]*[呢？?]$/, /怎么样[？?]/, /好吗[？?]/];
  for (const pattern of ellipsisPatterns) {
    if (pattern.test(expanded)) {
      const latest = tracker.getLatestEntity(1);
      if (latest.length > 0) {
        const resolved = latest[0] ?? '';
        if (resolved) {
          references.push({
            mention: expanded.trim(),
            resolved: `查询${resolved}的状态`,
            sourceTurn: undefined,
          });
          expanded = `查询${resolved}的状态`;
          break;
        }
      }
    }
  }

  return {
    hasCoreference: references.length > 0,
    references,
    expandedInput: expanded,
  };
}

/**
 * 便捷函数：直接解析输入并更新追踪器。
 */
export function resolveAndTrack(
  input: string,
  tracker: EntityTracker,
  turn: number
): { resolved: string; references: EntityReference[] } {
  // 先追踪当前轮的实体
  tracker.trackTurn(input, turn);
  
  // 再解析指代
  const result = resolveCoreference(input, tracker);
  
  return {
    resolved: result.expandedInput,
    references: result.references,
  };
}
