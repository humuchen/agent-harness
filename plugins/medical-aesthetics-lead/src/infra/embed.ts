/**
 * 文本嵌入（语义检索用）——查询实时嵌入与 seed 批量落库共用的唯一入口。
 *
 * 契约：OpenAI 兼容的 embeddings 端点（可对接 OpenAI / Azure OpenAI /
 * Ollama / vLLM / LocalAI 等）：
 *   POST {baseUrl}{MA_EMBED_PATH 默认 /v1/embeddings}
 *   body:  { model, input }   （无模型名时退化为 { input }）
 *   resp:  { data: [ { embedding: number[] }, ... ] }   或自定义 { embedding: number[] }
 *
 * 失败处理（fail-soft，绝不伪造向量）：
 * - 未配置 MA_EMBED_BASE_URL → 返回 null，检索退化为词面+意图；
 * - 网络/超时/解析异常 → 捕获返回 null，不阻断主流程。
 */

import { getConfig } from '../config';
import { HttpClient } from './http';

/** 实时/批量嵌入单段文本；未配置或失败返回 null。 */
export async function embedText(text: string): Promise<number[] | null> {
  const cfg = getConfig();
  if (!cfg.embed.enabled) return null;
  const endpoint = (process.env.MA_EMBED_PATH ?? '/v1/embeddings').trim() || '/v1/embeddings';
  const model = cfg.embed.model;
  try {
    const client = new HttpClient(cfg.embed, 'EMBED');
    const res = await client.json<{
      data?: Array<{ embedding?: number[] }> | null;
      embedding?: number[];
    }>({
      method: 'POST',
      path: endpoint,
      body: model ? { model, input: text } : { input: text },
    });
    // OpenAI 兼容：data[0].embedding
    if (res?.data && Array.isArray(res.data) && Array.isArray(res.data[0]?.embedding)) {
      return res.data[0].embedding;
    }
    // 自定义端点：顶层 embedding
    if (Array.isArray(res?.embedding)) return res.embedding;
    return null;
  } catch {
    return null; // 嵌入失败不阻断词面+意图检索
  }
}
