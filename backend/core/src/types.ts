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
  /** 纯文本内容（向后兼容）；多模态时可为 ContentBlock[]。 */
  content?: string | ContentBlock[];
  tool_calls?: ToolCall[];
  // 工具结果消息引用原始调用的 id 与工具名称
  tool_call_id?: string;
  name?: string;
}

/**
 * 多模态消息内容块（OpenAI / Claude 兼容）。
 * 支持 text（纯文本）与 image_url（图片 Base64）两种块。
 */
export interface ContentBlock {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' };
}

/** 已上传文件元信息（服务端返回 / 前端存储用）。 */
export interface UploadedFileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  /** 服务端 URL，可直接用于 <img src>。 */
  url: string;
  /** 上传时间戳。 */
  uploadedAt: number;
}

// 工具参数的类 JSON-Schema 描述。
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // 工具来源标注：'harness'（内置环境工具）/ 'mcp:<serverName>'（来自某 MCP 服务）/ 'mock' 等。
  // 仅用于可视化与可观测，不参与业务逻辑。
  source?: string;
}

/** LLM 返回的 token 用量（如适配器能拿到）。可选，缺失时视为 0。 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 供应商侧 prompt 缓存命中的 token 数（OpenAI/OpenRouter 经 `prompt_tokens_details.cached_tokens` 返回）。用于缓存命中率统计。 */
  cached_tokens?: number;
}

export interface LLMResponse {
  content: string;
  tool_calls: ToolCall[];
  /** 本次调用的 token 用量，用于成本记账与配额（部分适配器可能不返回）。 */
  usage?: TokenUsage;
  /** 本次调用实际使用的模型标识（来自响应 `data.model`，OpenRouter 多模型降级时可能与请求不同）。
   *  用于按模型计价与可观测；适配器拿不到时留空，由 harness 回落到配置的 model。 */
  model?: string;
}

/** 每次 LLM 调用可选的附带信息（如取消信号）。第三个参数，调用方可忽略。 */
export interface LLMCallOptions {
  // 超时 / 用户主动取消时触发；适配器应将其透传给底层 fetch 以尽早中止请求。
  signal?: AbortSignal;
  /**
   * token 级流式回调（可选）。支持流式（stream）的适配器在逐 delta 到达时调用，
   * 用于实现打字机式实时输出。不提供时适配器走一次性返回（向后兼容）。
   */
  onToken?: (delta: string) => void;
  /**
   * 推理过程流式回调（可选）。部分推理模型（如 DeepSeek-R1 / OpenRouter reasoning）
   * 在 delta 中携带 reasoning 字段，适配器逐段回调，用于渲染「思考过程」折叠块。
   */
  onReasoning?: (delta: string) => void;
}

export type LLM = (
  messages: Message[],
  tools: ToolSchema[],
  options?: LLMCallOptions
) => Promise<LLMResponse>;

/** 从 Message.content 中提取纯文本（兼容 ContentBlock[] 多模态结构）。 */
export function messageText(msg: Message | undefined): string {
  if (!msg?.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((b): b is ContentBlock & { text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}
