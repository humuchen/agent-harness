// Agent Harness 的核心契约。
// 具体的 LLM 后端只需满足 `LLM` 类型：
//   (messages, toolSchemas) => Promise<{ content, tool_calls }>
// 通过实现该函数即可接入任意提供商（OpenAI / Claude / 本地模型等）。

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content?: string;
  tool_calls?: ToolCall[];
  // 工具结果消息引用原始调用的 id 与工具名称
  tool_call_id?: string;
  name?: string;
}

// 工具参数的类 JSON-Schema 描述。
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  tool_calls: ToolCall[];
}

export type LLM = (
  messages: Message[],
  tools: ToolSchema[]
) => Promise<LLMResponse>;
