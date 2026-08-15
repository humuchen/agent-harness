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
