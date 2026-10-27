/**
 * JSON 安全解析（P1#24 收敛）：三插件此前 6+ 处各自 try/catch JSON.parse → fallback
 * （cs index.ts / reminders-trigger.ts、memo store.ts、ma library-repo.ts 等），统一为一个原语。
 *
 * 契约：绝不抛错。非法 JSON / 非字符串输入一律返回 fallback。
 * 注意：仅解析字符串输入——调用方若拿到的是已反序列化对象，应自行判型，
 * 不要把对象塞进来期待透传（保持原语语义最窄、最可预期）。
 */
export function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
