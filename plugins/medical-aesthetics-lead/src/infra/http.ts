/**
 * 真实 HTTP 客户端（外部 CRM / HIS / KB 服务的唯一出网通道）。
 *
 * 能力：
 * - 真实 `fetch` 调用（Node 18+ 内置 undici），无任何 mock 分支；
 * - 超时：AbortSignal.timeout，超时归类为 UPSTREAM_TIMEOUT；
 * - 退避重试：仅对网络异常 / 429 / 5xx 重试，指数退避 + 抖动；4xx 立即失败（不可重试）；
 * - 幂等键：写操作带 `Idempotency-Key`，配合发件箱重投不会造成上游重复建单；
 * - 脱敏：日志/错误信息中 token 一律不出现，响应体截断，避免把患者隐私写进日志。
 *
 * 与既有 `HarnessClient` 的差异：那里未配置密钥会退化为 dry-run 打印；本模块**不做 dry-run**，
 * 未配置直接由调用方 fail-closed 报错，确保「数据来源真实」这一硬约束。
 */

import { MaError } from './errors';
import type { UpstreamConfig } from '../config';

/** 请求选项。 */
export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 相对路径（如 `/v1/leads`）或查询参数已拼好的路径。 */
  path: string;
  /** 查询参数（自动 URL 编码，undefined/空值自动跳过）。 */
  query?: Record<string, string | number | undefined>;
  /** JSON 请求体。 */
  body?: unknown;
  /** 幂等键（写操作强烈建议传，重投安全）。 */
  idempotencyKey?: string;
  /** 额外请求头。 */
  headers?: Record<string, string>;
  /** 覆盖超时。 */
  timeoutMs?: number;
  /** 覆盖重试次数。 */
  retries?: number;
  /** 404 是否视为正常返回 null（查询类常用），缺省 false（抛 NOT_FOUND）。 */
  allow404?: boolean;
}

/** 上游名（错误信息里标明是哪个系统挂了，便于运维定位）。 */
export type UpstreamName = 'CRM' | 'HIS' | 'KB' | 'EMBED';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 指数退避 + 抖动，避免重试风暴。 */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 250);
}

/** 截断上游响应体，避免把大段内容/隐私写进日志与错误信息。 */
function truncate(s: string, max = 400): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
}

/**
 * 真实 REST 客户端。构造时不发请求；每次调用都真实出网。
 * 未配置（enabled=false）时构造方直接 fail-closed，本类不承担该判断。
 */
export class HttpClient {
  constructor(
    private readonly cfg: UpstreamConfig,
    private readonly upstream: UpstreamName
  ) {}

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  /** 发起一次 JSON 请求，返回解析后的响应体（T）。allow404 时 404 返回 null。 */
  async json<T>(opts: HttpRequestOptions): Promise<T | null> {
    const retries = opts.retries ?? this.cfg.retries;
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    const url = this.buildUrl(opts.path, opts.query);
    const method = opts.method ?? 'GET';

    let lastErr: MaError | null = null;
    // attempt 0 为首次请求，之后为重试
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.once<T>(url, method, opts, timeoutMs);
      } catch (e) {
        const err = e instanceof MaError ? e : new MaError('UPSTREAM_ERROR', String(e));
        // 不可重试错误（4xx / 参数错误 / NOT_FOUND / CONFLICT）立即上抛
        if (!err.retryable || attempt === retries) throw err;
        lastErr = err;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastErr ?? new MaError('UPSTREAM_ERROR', `${this.upstream} 请求失败`);
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const q = qs.toString();
    return `${this.cfg.baseUrl}${p}${q ? `?${q}` : ''}`;
  }

  /** 单次真实请求（不含重试逻辑）。 */
  private async once<T>(
    url: string,
    method: string,
    opts: HttpRequestOptions,
    timeoutMs: number
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      ...opts.headers,
    };

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        // 真实超时控制；超时会抛 TimeoutError（name='TimeoutError'）
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new MaError('UPSTREAM_TIMEOUT', `${this.upstream} 请求超时（${timeoutMs}ms）`, {
          upstream: this.upstream,
          method,
        });
      }
      // 网络层错误（DNS/连接拒绝等）可重试
      throw new MaError('UPSTREAM_ERROR', `${this.upstream} 网络错误：${(e as Error).message}`, {
        upstream: this.upstream,
        method,
      });
    }

    if (resp.status === 404 && opts.allow404) return null;

    if (!resp.ok) {
      const text = truncate(await resp.text().catch(() => ''));
      // 4xx 归为不可重试；429 与 5xx 可重试
      if (resp.status === 429 || resp.status >= 500) {
        throw new MaError('UPSTREAM_ERROR', `${this.upstream} 返回 ${resp.status}：${text}`, {
          upstream: this.upstream,
          status: resp.status,
        });
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new MaError('UNAUTHORIZED', `${this.upstream} 鉴权失败（${resp.status}），请检查访问令牌`, {
          upstream: this.upstream,
          status: resp.status,
        });
      }
      if (resp.status === 404) {
        throw new MaError('NOT_FOUND', `${this.upstream} 资源不存在：${text}`, {
          upstream: this.upstream,
        });
      }
      if (resp.status === 409) {
        throw new MaError('CONFLICT', `${this.upstream} 业务冲突：${text}`, { upstream: this.upstream });
      }
      throw new MaError('INVALID_ARGUMENT', `${this.upstream} 拒绝请求（${resp.status}）：${text}`, {
        upstream: this.upstream,
        status: resp.status,
      });
    }

    if (resp.status === 204) return null;
    const raw = await resp.text();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new MaError('UPSTREAM_ERROR', `${this.upstream} 返回非 JSON 响应：${truncate(raw)}`, {
        upstream: this.upstream,
      });
    }
  }
}
