/**
 * 错误分类（fail-closed 的表达载体）。
 *
 * 重构要点：过去工具无论后端是否可用都返回 `{ ok: true }`，导致「假成功」——
 * 例如没有真实号源也能"预约成功"。现在所有失败都必须以 MaError 显式表达，
 * 并由工具层转成结构化 JSON 回灌模型，让模型据实告知用户 / 转人工。
 */

export type MaErrorCode =
  /** 依赖的后端未配置（缺 baseUrl/token/密钥）——运维问题，不可重试。 */
  | 'NOT_CONFIGURED'
  /** 入参不合法。 */
  | 'INVALID_ARGUMENT'
  /** 目标资源不存在（如号源/院区/线索）。 */
  | 'NOT_FOUND'
  /** 业务冲突（如号源已满、重复认领）。 */
  | 'CONFLICT'
  /** 鉴权失败（webhook 验签 / 管理令牌）。 */
  | 'UNAUTHORIZED'
  /** 上游服务返回错误。 */
  | 'UPSTREAM_ERROR'
  /** 上游超时。 */
  | 'UPSTREAM_TIMEOUT'
  /** 本地库读写失败。 */
  | 'DB_ERROR';

/** 各错误码对应的 HTTP 状态（服务端路由直接复用）。 */
const HTTP_STATUS: Record<MaErrorCode, number> = {
  NOT_CONFIGURED: 503,
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  DB_ERROR: 500,
};

/** 可重试的错误码（发件箱 / HTTP 客户端据此决定退避重试）。 */
const RETRYABLE: ReadonlySet<MaErrorCode> = new Set<MaErrorCode>([
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'DB_ERROR',
]);

export class MaError extends Error {
  readonly code: MaErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: MaErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MaError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  /** 结构化输出（工具返回值 / HTTP 响应体共用）。 */
  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      error: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** 快捷构造：后端未配置。message 需给出**可操作**的修复指引。 */
export function notConfigured(what: string, envHint: string): MaError {
  return new MaError('NOT_CONFIGURED', `${what} 未配置，无法获取真实数据（请设置 ${envHint}）`, {
    missingEnv: envHint,
  });
}

/** 把任意异常规范化为 MaError（未知异常归为 DB_ERROR/UPSTREAM_ERROR 由调用方指定）。 */
export function toMaError(e: unknown, fallback: MaErrorCode = 'UPSTREAM_ERROR'): MaError {
  if (e instanceof MaError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new MaError(fallback, msg);
}

/** 统一把 MaError / 未知异常转成工具返回的结构化 JSON（工具层绝不抛错中断主循环）。 */
export function errorResult(e: unknown, fallback: MaErrorCode = 'UPSTREAM_ERROR'): Record<string, unknown> {
  return toMaError(e, fallback).toJSON();
}
