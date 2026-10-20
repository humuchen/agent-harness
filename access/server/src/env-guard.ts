/**
 * env-guard —— 平台鉴权凭证的环境边界收口（插件 worker 沙箱·第一阶段）。
 *
 * 背景：插件与宿主同进程运行，插件代码可以直接读 process.env——ctx.env 白名单
 * （plugin-bootstrap.ts 的 PLUGIN_ENV_COMPAT）只收窄了「经 PluginContext 契约面」
 * 的注入，挡不住插件绕过契约直接读环境。完整隔离需 worker/OS 沙箱（独立立项）；
 * 本模块先把「插件无正当依赖」的平台鉴权凭证从环境中摘除：
 *
 *   UI_TOKENS            多用户静态令牌（secret -> username 明文映射）
 *   UI_JWT_SECRET        会话 JWT 签名密钥
 *   UI_SESSION_SECRET    会话加密密钥
 *   UI_ROLE_PERMISSIONS  RBAC 角色-权限配置（含授权面）
 *
 * server 启动最早处调用 scrubSensitiveEnv() 后，上述键从 process.env 删除、值
 * 收进本模块私有 Map；宿主代码统一经 getSecret(key) 读取（scrub 前等价于直读，
 * scrub 后从受保护副本取，行为不变）。插件直接读 process.env.UI_TOKENS 等
 * 将得到 undefined——泄露面从「任意插件可读全部凭证」收窄到「仅剩设计内注入
 * 的 ctx.env 白名单键」。
 *
 * 不纳入 scrub 的键（均有设计内正当依赖，见各自注释）：
 * - ADMIN_API_KEY / OPEN_API_KEY：插件回调 /api/run 的管理凭证（PLUGIN_ENV_COMPAT）
 *   与 core LLM 调用密钥（core 直接读 process.env）；
 * - 数据库连接串等：待 worker 沙箱落地后随第二阶段收口。
 */

/** 需要从环境摘除的平台鉴权凭证键。 */
const SENSITIVE_ENV_KEYS = [
  'UI_TOKENS',
  'UI_JWT_SECRET',
  'UI_SESSION_SECRET',
  'UI_ROLE_PERMISSIONS',
] as const;

const captured = new Map<string, string>();
let scrubbed = false;

/**
 * 把敏感键从 process.env 摘除并收进受保护副本。幂等（多次调用只生效一次）。
 * 必须在任何插件代码被 require 之前、以及第一次鉴权读取之前调用。
 */
export function scrubSensitiveEnv(): void {
  if (scrubbed) return;
  scrubbed = true;
  for (const k of SENSITIVE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) {
      captured.set(k, v);
      delete process.env[k];
    }
  }
}

/**
 * 读取平台凭证的统一入口（宿主代码替代 process.env 直读）。
 * scrub 后从受保护副本取；未 scrub（如单测直接调用被测函数）时回落直读，
 * 两种形态行为一致。
 */
export function getSecret(key: string): string | undefined {
  const c = captured.get(key);
  if (c !== undefined) return c;
  return process.env[key];
}

/** 测试辅助：清空 scrub 状态（重置 captured 与幂等标记）。 */
export function resetEnvGuardForTest(): void {
  captured.clear();
  scrubbed = false;
}

/** 测试辅助：当前是否已执行 scrub。 */
export function isEnvScrubbedForTest(): boolean {
  return scrubbed;
}
