/**
 * 跨运行时 SSE 解析原语（多平台客户端基石）。
 *
 * 把 `text/event-stream` 响应体解析为异步迭代器，逐帧产出 JSON 事件。
 * 不依赖任何框架：浏览器 / Node 18+ / React Native(配 fetch polyfill) / Edge 均可使用。
 * 只处理 `data:` 帧（服务端所有事件均以此格式下发）。
 */

export interface SseOptions {
  /** 中断信号；触发后迭代器在下一个读取边界安全退出。 */
  signal?: AbortSignal;
}

/**
 * 将 SSE 响应体解析为事件异步迭代器。
 * 每遇到 `\n\n` 边界即切出一帧，提取所有 `data:` 行拼接后 JSON.parse。
 * 单帧解析失败会被跳过（不让一个坏帧拖垮整条流）。
 */
export async function* parseSse(
  response: Response,
  opts: SseOptions = {}
): AsyncGenerator<unknown> {
  const body = response.body;
  if (!body) throw new Error('SSE response has no body');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushFrame = function* (frame: string): Generator<unknown> {
    const dataLines = frame
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith('data:'));
    if (dataLines.length === 0) return;
    const data = dataLines
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data.trim()) return;
    try {
      yield JSON.parse(data);
    } catch {
      // 跳过畸形帧，保持流健壮。
    }
  };

  try {
    while (true) {
      if (opts.signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* flushFrame(frame);
      }
    }
    // 收尾：处理流末尾可能残留的最后一帧（无尾随 \n\n）。
    if (buffer.trim().length) yield* flushFrame(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已释放或连接已断，忽略 */
    }
  }
}
