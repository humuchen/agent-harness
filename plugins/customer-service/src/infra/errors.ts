/**
 * 错误归一化（供工具返回结构化结果）。
 */

/** 统一工具错误结果（前端/日志可识别 error=true）。 */
export function errorResult(e: unknown): { error: true; message: string } {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
  return { error: true, message };
}

/** fail-closed：能力依赖的上游未配置时返回此结果（绝不伪造数据）。 */
export function notConfiguredResult(capability: string): { error: true; code: 'NOT_CONFIGURED'; message: string } {
  return {
    error: true,
    code: 'NOT_CONFIGURED',
    message: `capability "${capability}" is not configured (upstream not enabled); refusing to fabricate data`,
  };
}
