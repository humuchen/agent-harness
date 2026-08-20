import { ToolSchema } from './types';

export type ToolFn = (args: Record<string, unknown>) => Promise<unknown> | unknown;

interface RegisteredTool {
  schema: ToolSchema;
  fn: ToolFn;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  /**
   * 注册一个工具到工具注册表中
   * @param name - 工具的唯一标识名称
   * @param description - 工具的功能描述
   * @param parameters - 工具的参数定义，采用 JSON Schema 格式
   * @param fn - 工具的执行函数，接收参数并返回执行结果
   * @param source - 可选，工具的来源标识（如 MCP 服务名称）
   */
  register(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    fn: ToolFn,
    source?: string
  ): void {
    this.tools.set(name, {
      schema: { name, description, parameters, source },
      fn,
    });
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  /**
   * 遍历全部已注册工具（含执行函数），供插件系统把「插件专属 ToolRegistry」合并进
   * 进程共享的插件工具注册表（自动加插件前缀做命名空间隔离）。属通用能力，不影响既有调用方。
   */
  entries(): Array<{ name: string; schema: ToolSchema; fn: ToolFn }> {
    return [...this.tools.entries()].map(([name, t]) => ({ name, schema: t.schema, fn: t.fn }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 从注册表中移除某个工具（用于断开 MCP 服务时清理其工具）。 */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const t = this.tools.get(name);
    if (!t) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return t.fn(args);
  }

  /**
   * 将另一个注册表的（经 filter 过滤后的）工具合并进当前注册表（用于共享 MCP 工具到各次运行）。
   * @param filter 可选：返回 true 才合并；缺省合并全部。常用于按 MCP server 名收窄。
   * @param name 工具名（如 `server__tool`）；@param source 工具来源标记（如 `mcp:server`）。
   */
  mergeFrom(
    other: ToolRegistry,
    filter?: (name: string, source?: string) => boolean
  ): void {
    for (const [name, entry] of other.tools) {
      if (filter && !filter(name, entry.schema.source)) continue;
      if (!this.tools.has(name)) this.tools.set(name, entry);
    }
  }
}

// 便捷辅助函数：构建 JSON-Schema 的 object 类型参数块。
export function objectParams(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
  };
}

/**
 * 按用户输入的相关性，从全量工具中选出「本步最可能需要」的子集，
 * 用于降低简单输入（如「你好」）首呼时全量 18 个工具 schema 的固定开销。
 *
 * 设计目标（零依赖、零额外 LLM 调用）：
 *  - 用输入文本与「工具名 + 描述 + 来源」做轻量词重叠打分（中文按字符二元组、英文按词）。
 *  - `allowTools` 为硬允许集（来自 AgentCard.assembly.tools 或核心环境工具），始终保留，永不裁掉。
 *  - `topK` 限制最大发出数量；当得分普遍极低（寒暄类）且超出允许集时返回空集。
 *  - 评分采用「名称命中权重高、描述命中权重低」的启发式，避免把无关工具选入。
 *
 * 注意：这只影响「发送给 LLM 的 schema 子集」，本地执行仍走全量注册表；
 * 若模型请求了未发出的工具，由 harness 主循环用全量 schema 重试兜底（见 harness.ts）。
 */
export interface ToolSelectOptions {
  /** 硬允许集：这些工具无条件保留（如 card 声明 / 核心环境工具）。 */
  allowTools?: string[];
  /** 最多发出的工具数（含 allowTools）。默认 8。 */
  topK?: number;
}

export function selectToolsForInput(
  all: ToolSchema[],
  input: string,
  opts: ToolSelectOptions = {}
): ToolSchema[] {
  const topK = opts.topK && opts.topK > 0 ? opts.topK : 8;
  const allow = new Set(opts.allowTools ?? []);
  if (!input || !input.trim() || all.length === 0) {
    // 无输入或空注册表：仅返回硬允许集（可能为空）。
    return all.filter((t) => allow.has(t.name));
  }

  const grams = tokenize(input);
  const scored = all.map((t) => {
    const hay = [t.name, t.description ?? '', t.source ?? ''].join(' ');
    let score = 0;
    // 名称直接命中（含子串）给高权重。
    if (t.name && input.toLowerCase().includes(t.name.toLowerCase())) score += 5;
    for (const g of grams) {
      if (!g) continue;
      if (hay.toLowerCase().includes(g.toLowerCase())) score += g.length >= 2 ? 1 : 0.3;
    }
    return { t, score, allowed: allow.has(t.name) };
  });

  const allowed = scored.filter((s) => s.allowed).map((s) => s.t);
  const candidates = scored
    .filter((s) => !s.allowed && s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.t);
  // 先放硬允许集，再补相关性最高的候选，直到达到 topK。
  const picked = [...allowed];
  for (const c of candidates) {
    if (picked.length >= topK) break;
    picked.push(c);
  }
  return picked;
}

/** 极简分词：中文按字符二元组，英文/数字按连续词。零依赖。 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  // 英文/数字词
  const en = lower.match(/[a-z0-9_]+/g);
  if (en) out.push(...en);
  // 中文二元组（覆盖大部分中文触发词重叠）
  const cjk = lower.match(/[一-鿿]/g);
  if (cjk) {
    for (let i = 0; i < cjk.length - 1; i++) out.push(cjk[i] + cjk[i + 1]);
    if (cjk.length === 1) out.push(cjk[0]);
  }
  return out;
}

