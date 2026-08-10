import { ToolSchema } from './types';

export type ToolFn = (args: Record<string, unknown>) => Promise<unknown> | unknown;

interface RegisteredTool {
  schema: ToolSchema;
  fn: ToolFn;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

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

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const t = this.tools.get(name);
    if (!t) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return t.fn(args);
  }

  /** 将另一个注册表的全部工具合并进当前注册表（用于共享 MCP 工具到各次运行）。 */
  mergeFrom(other: ToolRegistry): void {
    for (const [name, entry] of other.tools) {
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
