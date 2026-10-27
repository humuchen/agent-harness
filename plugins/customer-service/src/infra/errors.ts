/**
 * 错误归一化（供工具返回结构化结果）。
 *
 * P1#25：通用 errorResult 已上移到 plugin-kit 的 simpleErrorResult（各工具文件
 * 经别名 import 调用点零改动）；本文件保留 cs 特有的 NOT_CONFIGURED 结果形态。
 */

/** fail-closed：能力依赖的上游未配置时返回此结果（绝不伪造数据）。 */
export function notConfiguredResult(capability: string): { error: true; code: 'NOT_CONFIGURED'; message: string } {
  return {
    error: true,
    code: 'NOT_CONFIGURED',
    message: `capability "${capability}" is not configured (upstream not enabled); refusing to fabricate data`,
  };
}
