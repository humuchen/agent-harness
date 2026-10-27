/**
 * JSON 响应助手（P1#24 收敛）：三插件此前各写一份逐字符几乎相同的
 * json() / send()（cs routes.ts / ma routes.ts / memo server-routes.ts），统一收敛到 kit。
 *
 * 语义与各插件原实现一致（ma 原用 writeHead，本实现 statusCode+setHeader 与 cs/memo
 * 相同——headers 均在 res.end 时一并发出，行为等价）：
 *  - 设置 statusCode + content-type: application/json; charset=utf-8；
 *  - JSON.stringify(body) 后 res.end。
 */
export function jsonReply(
  res: import('node:http').ServerResponse,
  code: number,
  body: unknown
): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
