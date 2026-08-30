/**
 * 错误文案归一化（纯函数，零依赖）。
 * ----------------------------------------------------------------
 * 把「任意异常」翻译成一句用户能看懂的中文。此前各面板各自
 * `String(e?.message ?? e)`，同一类问题在 UI 上有七八种说法
 * （HTTP 401 / "HTTP 401" / "Failed to fetch" / "Unauthorized"…），这里收敛为唯一口径。
 *
 * 本模块刻意不 import 任何组件（保持纯函数，便于单测与服务端复用）；
 * 「归一化 + 弹出通知」的组合见 ./errors.ts。
 *
 * 归一化顺序：
 *   1) HTTP 状态码（ApiError.status）→ 分档文案；4xx 优先透传服务端 error 文案；
 *   2) 网络层失败 → 「网络异常」；
 *   3) 其余 → 原样透传（保留排查线索）。
 */

/** 网络层失败的特征串（fetch 在断网 / DNS 失败 / CORS 被拦时的 message）。 */
const NETWORK_HINTS = [
  'failed to fetch',
  'networkerror',
  'network request failed',
  'load failed',
  'err_network',
  'err_internet_disconnected',
  'err_connection'
];

type UnknownRecord = Record<string, unknown>;

function asRecord(e: unknown): UnknownRecord | null {
  return e && typeof e === 'object' ? (e as UnknownRecord) : null;
}

/** 取错误上的 HTTP 状态码（无则 undefined）。 */
export function errorStatus(e: unknown): number | undefined {
  const rec = asRecord(e);
  const s = rec?.status;
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  // 兜底：部分错误把状态码写进了 message（如 "HTTP 401"）。
  const candidates =
    typeof e === 'string'
      ? [e]
      : typeof rec?.message === 'string'
      ? [rec.message]
      : [];
  for (const c of candidates) {
    const m = /^\s*HTTP\s+(\d{3})\s*$/i.exec(c);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** 原始 message（Error / string / 其它对象的安全降级）。 */
function rawMessage(e: unknown): string {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string') return e;
  const rec = asRecord(e);
  const m = rec?.message;
  if (typeof m === 'string' && m.trim()) return m;
  try {
    return String(e);
  } catch {
    return '';
  }
}

/**
 * 是否「用户主动中止」：点停止按钮、切页取消请求、AbortController.abort()。
 * 这类中断不是故障，不应弹错误通知（否则每次「停止运行」都弹一条红条）。
 */
export function isAbortError(e: unknown): boolean {
  const rec = asRecord(e);
  if (!rec) return false;
  if (rec.name === 'AbortError' || rec.name === 'UserStoppedRun') return true;
  const msg = typeof rec.message === 'string' ? rec.message.toLowerCase() : '';
  return msg.includes('aborted') || msg.includes('signal is aborted');
}

/**
 * 把任意异常归一化为用户可读文案。
 * @param fallback 完全无法识别时的兜底文案。
 */
export function errorMessage(e: unknown, fallback = '操作失败，请稍后重试'): string {
  const raw = rawMessage(e).trim();
  const status = errorStatus(e);
  // 「纯粹的状态码占位串」（如 "HTTP 401"）没有信息量，应让位给分档文案。
  const bare = /^\s*HTTP\s+\d{3}\s*$/i.test(raw);

  if (status !== undefined) {
    switch (status) {
      case 400:
        // 4xx 里服务端通常已给出人话（如「用户名已被占用」），优先透传。
        return raw && !bare ? raw : '请求参数有误';
      case 401:
        return '登录已失效，请重新登录';
      case 403:
        return '没有权限执行该操作';
      case 404:
        return '请求的资源不存在';
      case 409:
        return raw && !bare ? raw : '资源冲突';
      case 422:
        return raw && !bare ? raw : '请求未通过校验';
      case 429:
        return '请求过于频繁，请稍后再试';
      default:
        if (status >= 500) return `服务暂时不可用（${status}），请稍后重试`;
        if (status >= 400) return raw && !bare ? raw : `请求失败（${status}）`;
        break;
    }
  }

  if (!raw) return fallback;
  if (NETWORK_HINTS.some((h) => raw.toLowerCase().includes(h)))
    return '网络异常，请检查连接后重试';
  if (bare) return `请求失败（${raw.trim()}）`;
  return raw;
}
