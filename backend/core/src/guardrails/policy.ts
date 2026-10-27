// 护栏策略：默认表 + 环境变量解析 + 模块级策略状态原语（P1#21 拆分）。
// 注意：模块级 `policy` 是全局默认引擎的真相源；configureGuardrails（engine.ts）是
// 唯一写入口（同时同步 defaultGuardrailsEngine），本文件只暴露 get/set 原语。
import type { GuardrailPolicy, InjectionSensitivity, NetworkPolicy } from './types';

export const DEFAULT_POLICY: GuardrailPolicy = {
  maxInputLength: 20000,
  enableSecretScan: true,
  enableInjectionScan: true,
  injectionSensitivity: 'medium',
  enablePiiRedaction: true,
  allowlist: [],
  // 默认 agent（无租户/无画像路径）不限制出网；需要收紧时用 GUARDRAIL_NETWORK_MODE 显式配置，
  // 或对高合规租户走行业画像（policy/engine.ts 里 medical/healthcare/finance 仍默认 deny-all）。
  network: { mode: 'open' },
};

/**
 * 计划任务输入长度上限（**仅由环境变量驱动，不设置代码默认值**）。
 * 通过 GUARDRAIL_PLAN_MAX_INPUT 配置，例如 60000（约 3 万字）。
 * 未设置（或取值非法）时返回 null —— 表示不针对计划类输入做任何额外放宽，
 * 计划任务沿用通用 maxInputLength 长度闸（默认 20000）。
 * 注意：若希望计划输入放宽到 60000，部署时必须显式设置 GUARDRAIL_PLAN_MAX_INPUT=60000，
 * 否则 plan 长输入仍会被通用长度闸拦下（input too long）。
 */
function resolvePlanMaxInput(): number | null {
  const raw = process.env.GUARDRAIL_PLAN_MAX_INPUT;
  if (raw === undefined || raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}
export const PLAN_MAX_INPUT_LENGTH: number | null = resolvePlanMaxInput();

/** 允许通过环境变量调整护栏默认策略（无需改代码即可按部署收紧 / 放松）。 */
export function resolveDefaultPolicy(): GuardrailPolicy {
  const sens = (process.env.GUARDRAIL_SENSITIVITY || '').toLowerCase();
  const sensitivity: InjectionSensitivity = sens === 'low' || sens === 'high' ? sens : 'medium';
  const maxInput = Number(process.env.GUARDRAIL_MAX_INPUT ?? '');
  const webFetchScan = (process.env.GUARDRAIL_WEB_FETCH_SECRET_SCAN || '').toLowerCase();
  // 网络出口管控：GUARDRAIL_NETWORK_MODE 支持 open/allowlist/denylist（默认 open，2026-09-24 起）。
  // - 默认 agent（无租户/无行业画像）不限制出网；需要收紧的部署显式设置 env：
  // - denylist + GUARDRAIL_DENIED_DOMAINS：显式禁止的域名列表；
  // - allowlist + GUARDRAIL_ALLOWED_DOMAINS：白名单模式，仅允许指定域名出网；
  // - open：放行所有（默认）。高合规租户不受此默认影响（行业画像自带 deny-all 基线）。
  const netMode = (process.env.GUARDRAIL_NETWORK_MODE || 'open').toLowerCase();
  const deniedRaw = process.env.GUARDRAIL_DENIED_DOMAINS;
  const allowedRaw = process.env.GUARDRAIL_ALLOWED_DOMAINS;
  // 私网豁免部署开关（GUARDRAIL_ALLOW_PRIVATE_NETWORK，缺省 false 收紧——secure by default）：
  // 私网地址默认纳入出网管控，封死 allowlist 域名下直连内网服务 / DNS rebinding 的 SSRF 面
  // （代价是 web_fetch 校验多一次 DNS 展开）。需要访问内网/本机服务的部署显式设为 true 放行。
  const privRaw = (process.env.GUARDRAIL_ALLOW_PRIVATE_NETWORK ?? '').trim().toLowerCase();
  const allowPrivateNetwork = privRaw === '' ? false : !(privRaw === 'false' || privRaw === '0' || privRaw === 'off');
  let network: NetworkPolicy | undefined;
  if (netMode === 'open') {
    network = { mode: 'open', allowPrivateNetwork };
  } else if (netMode === 'allowlist') {
    network = {
      mode: 'allowlist',
      allowedDomains: allowedRaw ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
      allowPrivateNetwork,
    };
  } else {
    // denylist（显式启用）：解析禁止域名，未配 GUARDRAIL_DENIED_DOMAINS 时按 ['*'] 禁所有
    // （部署既然显式选了 denylist，按最严解释；只想禁部分域名就配上具体列表）。
    const denied = deniedRaw
      ? deniedRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : ['*'];
    network = { mode: 'denylist', deniedDomains: denied, allowPrivateNetwork };
  }
  return {
    maxInputLength:
      Number.isFinite(maxInput) && maxInput > 0 ? maxInput : DEFAULT_POLICY.maxInputLength,
    enableSecretScan: process.env.GUARDRAIL_SECRET_SCAN !== 'false',
    enableInjectionScan: process.env.GUARDRAIL_INJECTION_SCAN !== 'false',
    injectionSensitivity: sensitivity,
    enablePiiRedaction: process.env.GUARDRAIL_PII !== 'false',
    allowlist: (process.env.GUARDRAIL_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webFetchSecretScan: webFetchScan === 'full' || webFetchScan === 'off' ? webFetchScan : 'headers-only',
    network,
  };
}

// 模块级策略状态（全局默认引擎的真相源；写入口只有 engine.ts 的 configureGuardrails）。
let policy: GuardrailPolicy = resolveDefaultPolicy();

/** 读取模块级策略（checks/pii 的 `pol ?? policy` 兜底用）。 */
export function getModulePolicy(): GuardrailPolicy {
  return policy;
}

/** 覆写模块级策略（仅 engine.ts 的 configureGuardrails 调用）。 */
export function setModulePolicy(p: GuardrailPolicy): void {
  policy = p;
}
