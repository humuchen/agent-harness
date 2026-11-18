/**
 * server 启动期类型化配置快照（P1-6 配置集中化基础）。
 *
 * 背景：审计指出 server.ts 有 40+ 处 process.env 散读，部分直读 `process.env.X ??
 * DEFAULTS.X` 后 `Number(...)` —— env 写错（如 MAX_BODY_BYTES="abc"）会静默变 NaN
 * 绕过 cfgNum 的有限数守卫，导致请求体上限失效等隐蔽 misconfig。本模块把启动段
 * 常量集中为**一次性构建的类型化冻结快照**：
 *   - 数值键经 cfgNum（有限数守卫，非法回落 DEFAULTS）；
 *   - 布尔键经 cfgBool；
 *   - 字符串键经 cfgStr；
 *   - 派生量（requireAuth）在快照内计算，消费方零重复逻辑。
 *
 * 边界：仅覆盖 server.ts 启动段实际消费的键（约 15 个）。core 内与 server 业务
 * 模块内的 ad-hoc 读取（HARNESS_API_KEY / REDIS_URL / AGENT_STORE 等）暂不纳入——
 * 它们多在装配期按需读取、且无 DEFAULTS 落点，强行集中反而割裂语义。后续可按
 * 同款模式逐步收口。
 */
import { cfgStr, cfgNum, cfgBool, DEFAULTS } from './config-defaults.js';
import { getSecret } from './env-guard.js';

export interface ServerConfig {
  /** HTTP 监听端口（PORT > UI_PORT > DEFAULTS.PORT）。 */
  port: number;
  /** 监听地址（UI_HOST > DEFAULTS.UI_HOST）。 */
  host: string;
  /** 请求体上限（字节，防大报文 DoS）。 */
  maxBodyBytes: number;
  /** 单会话历史镜像序列化上限（字节）。 */
  historyMaxBytes: number;
  /** 单 IP 限流阈值（窗口内请求数，<=0 关闭）。 */
  rateLimit: number;
  /** 限流窗口（ms）。 */
  rateLimitWindowMs: number;
  /** 单已登录用户限流阈值（<=0 关闭）。 */
  userRateLimit: number;
  /** 跨域来源白名单（已 split + trim + 去空）。 */
  uiCorsOrigin: string[];
  /** 身份源（token / oidc / proxy / account）。 */
  authProvider: string;
  /** 账户密码身份源是否启用。 */
  accountAuth: boolean;
  /** 是否强制鉴权（非 token 模式 / 账户密码 / UI_TOKENS 任一即真）。 */
  requireAuth: boolean;
  /** A2A 出网私网放行逃生舱（默认 false，防 SSRF）。 */
  a2aAllowPrivateNetwork: boolean;
  /** 每窗口最大成本（美元，0=不限）。 */
  maxCostPerWindow: number;
}

function parseCorsList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 构建配置快照。导出函数形式便于测试注入伪 env 后重建；生产经 `serverConfig`
 * 单例消费（模块加载期一次性构建，与 server.ts 启动段常量同生命周期）。
 */
/**
 * 读取数值 env，带有限数守卫。与 cfgNum 的差异：不回落 DEFAULTS[key]，仅用传入
 * fallback——用于 PORT > UI_PORT > DEFAULTS 这种「env 链式优先」场景（cfgNum 会因
 * DEFAULTS['PORT'] 存在而短路掉 UI_PORT 分支）。
 */
function numEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function loadServerConfig(): ServerConfig {
  const authProvider = cfgStr(
    'AUTH_PROVIDER',
    DEFAULTS.AUTH_PROVIDER as string
  ).toLowerCase();
  // 账户密码身份源开关（默认开）：'off' 以外的值均视为启用。
  const accountAuthRaw = cfgStr('ACCOUNT_AUTH', DEFAULTS.ACCOUNT_AUTH as string);
  const accountAuth = accountAuthRaw.toLowerCase() !== 'off';
  // 需要鉴权：非 token 模式、或启用账户密码鉴权、或配置了静态令牌（UI_TOKENS）。
  // UI_TOKENS 经 env-guard getSecret 读取（与其他敏感键同口径）。
  const requireAuth =
    authProvider !== 'token' || accountAuth || !!getSecret('UI_TOKENS');

  return Object.freeze({
    // PORT 链式优先：PORT > UI_PORT > DEFAULTS.PORT（经 numEnv 守有限数）。
    port: numEnv('PORT', numEnv('UI_PORT', DEFAULTS.PORT as number)),
    host: cfgStr('UI_HOST', DEFAULTS.UI_HOST as string),
    maxBodyBytes: cfgNum('MAX_BODY_BYTES', DEFAULTS.MAX_BODY_BYTES as number),
    historyMaxBytes: cfgNum(
      'HISTORY_MAX_BYTES',
      DEFAULTS.HISTORY_MAX_BYTES as number
    ),
    rateLimit: cfgNum('RATE_LIMIT', DEFAULTS.RATE_LIMIT as number),
    rateLimitWindowMs: cfgNum(
      'RATE_LIMIT_WINDOW_MS',
      DEFAULTS.RATE_LIMIT_WINDOW_MS as number
    ),
    userRateLimit: cfgNum('USER_RATE_LIMIT', DEFAULTS.USER_RATE_LIMIT as number),
    uiCorsOrigin: parseCorsList(
      cfgStr('UI_CORS_ORIGIN', DEFAULTS.UI_CORS_ORIGIN as string)
    ),
    authProvider,
    accountAuth,
    requireAuth,
    a2aAllowPrivateNetwork: cfgBool('A2A_ALLOW_PRIVATE_NETWORK', false),
    maxCostPerWindow: cfgNum('MAX_COST_PER_WINDOW', DEFAULTS.MAX_COST_PER_WINDOW as number),
  }) as ServerConfig;
}

/** 进程级配置快照单例（模块加载期构建，冻结）。 */
export const serverConfig: ServerConfig = loadServerConfig();
