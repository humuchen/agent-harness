/**
 * 插件服务端扩展的 JSON 请求体读取（统一安全基线）。
 *
 * P1 资源基线：字节上限默认 1MB（此前 memo 无上限——单个大 body 可打满插件进程内存），
 * 可经 opts.maxBytes 覆盖（保留插件刻意的差异化配置）。超限直接断开连接并返回空对象，
 * 与各插件既有「解析失败返回 {}」的容错语义一致。
 */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export function readJsonBody(
  req: import('node:http').IncomingMessage,
  opts: { maxBytes?: number } = {}
): Promise<Record<string, unknown>> {
  const maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES);
  return new Promise((resolve) => {
    let data = '';
    let total = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      total += c.byteLength;
      if (total > maxBytes) {
        aborted = true;
        try { req.destroy(); } catch { /* 已断开则忽略 */ }
        resolve({});
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => { if (!aborted) resolve({}); });
  });
}
