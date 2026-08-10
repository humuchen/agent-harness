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
    fn: ToolFn
  ): void {
    this.tools.set(name, {
      schema: { name, description, parameters },
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
