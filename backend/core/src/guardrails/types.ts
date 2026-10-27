// 内容安全护栏 —— 类型契约（P1#21 拆分：自 guardrails.ts 分出，纯类型零运行时逻辑）。
import type { IsolationLevel } from '../sandbox/types';

export interface GuardrailResult {
  ok: boolean;
  reason?: string;
  /**
   * 合规安全回复（可选）：拦截规则命中时可附带一段「合规、有事实依据」的兜底话术，
   * 调用方（harness）优先采用它作为最终回复，而非暴露 [guardrail] blocked 内部文本。
   * 例：知识库查空时，直接返回工具的标准「建议预约面诊」话术。
   */
  safeReply?: string;
}

export interface PiiRedactor {
  label: string;
  re: RegExp;
  mask: (m: string) => string;
}

export type InjectionSensitivity = 'low' | 'medium' | 'high';

/** 出网管控策略（P0.3）：约束 web_fetch 可访问的域名范围。 */
export interface NetworkPolicy {
  /**
   * open：允许所有域名（默认，向后兼容）；
   * allowlist：仅允许 listed 域名（含子域）出网；
   * denylist：禁止 listed 域名（含子域），其余放行。
   */
  mode: 'open' | 'allowlist' | 'denylist';
  /** allowlist 模式下仅允许这些域名（含子域，支持 `*.example.com` 通配子域）。 */
  allowedDomains?: string[];
  /** denylist 模式下禁止这些域名（含子域，支持 `*.example.com` 通配子域）。 */
  deniedDomains?: string[];
  /**
   * 是否豁免本地/私有网络地址（127.x / 10.x / 192.168.x / 172.16-31.x / localhost）。
   * 缺省 true（存量零回归：内网服务访问不受管控影响）；设为 false 时私有地址同样
   * 纳入出网管控，防止 allowlist 域名 DNS rebinding / 直连内网服务的 SSRF 面。
   */
  allowPrivateNetwork?: boolean;
}

export interface GuardrailPolicy {
  /** 输入最大字符数，超过即拦截（防超大输入 / 资源耗尽）。 */
  maxInputLength: number;
  /** 是否扫描密钥类敏感串。 */
  enableSecretScan: boolean;
  /** 是否做提示词注入检测。 */
  enableInjectionScan: boolean;
  /** 注入检测敏感度（影响短语集大小）。 */
  injectionSensitivity: InjectionSensitivity;
  /** 是否在输出侧做 PII 脱敏。 */
  enablePiiRedaction: boolean;
  /** 允许列表：命中这些关键词的输入/输出不会被注入检测拦截（如产品名恰好含 "system prompt"）。 */
  allowlist: string[];
  /**
   * 业务护栏作用域（P0.x，治本）：声明本次运行「启用」哪些业务护栏 scope。
   * 配合 registerInputRule/registerOutputRule 的 scope 参数实现「按 agent 绑定业务护栏」，
   * 而非进程级全局生效——
   *   - 未设置（undefined，旧路径/测试）→ 不收窄，所有自定义规则照常生效（向后兼容）；
   *   - 设为数组 → 未打 scope 的规则始终生效（全局安全底线，如业务方希望某规则全局适用），
   *     打了 scope 的规则仅当 scope ∈ 本数组时才评估。
   * 例：默认/generic agent 传 scopes:[] 即排除 medical-ad 等业务护栏；医美 agent 传
   * scopes:['medical-ad'] 才启用医疗广告法护栏。
   */
  scopes?: string[];
  /** 出网管控（P0.3）：约束 web_fetch 可访问域名；缺省 open（全部放行）。 */
  network?: NetworkPolicy;
  /**
   * web_fetch 工具参数 secret 扫描范围。
   * - 'headers-only'（默认）：仅扫描 headers 对象，URL 只做协议/egress 检查；
   *   避免把网页 URL 中常见的 token/api_key 查询参数误判为泄露 secret。
   * - 'full'：对 url + headers 全部扫描（旧行为）。
   * - 'off'：关闭 web_fetch 的 secret 扫描。
   */
  webFetchSecretScan?: 'headers-only' | 'full' | 'off';
  /**
   * 合规画像元数据（P2.c）：标注该策略所属合规框架 / 数据驻留要求 / 是否强制审计留痕。
   * 仅用于治理展示与 P2.d 隔离决策，不影响护栏判定逻辑；全字段可选。
   */
  compliance?: ComplianceProfile;
  /**
   * 最低执行隔离级别（P2.d）：要求承载该策略的 agent 至少以何种隔离后端执行。
   * 缺省 undefined 表示不强制（沿用 SANDBOX_BACKEND / AgentCard.isolation 决定）。
   * 'none' 仅用于完全可信的内部 agent；不可信 / 跨行业 agent 应设为 'os' 或 'container'。
   */
  isolation?: IsolationLevel;
}

/** 合规画像元数据（P2.c）。 */
export interface ComplianceProfile {
  /** 适用合规框架标签，如 "等保三级"、"个人信息保护法"、"金融行业数据安全"。 */
  framework?: string;
  /**
   * 数据驻留要求：'domestic' 表示数据不得出境（金融/医疗常用），'any' 无限制。
   * 与 network 策略联动（domestic 通常配合 denylist: ['*'] 默认禁出网）。
   */
  dataResidency?: 'domestic' | 'any';
  /** 是否强制审计留痕（关键动作须调用 audit()）。 */
  auditRequired?: boolean;
  /** PII 留存天数上限（治理展示用，实际留存由记忆后端配置）。 */
  piiRetentionDays?: number;
}

/** 护栏命中审计条目（长期：命中留痕 → 人审闭环的基础设施）。 */
export interface GuardrailRuleHit {
  side: 'input' | 'output';
  /** 命中规则的 scope 标签（如 'medical-ad'；未声明 scope 的全局规则省略）。 */
  scope?: string;
  /** 命中片段（截断 200 字符，防审计表膨胀）。 */
  matched: string;
  /** 规则原因（领域库维护的人工可读合规依据）。 */
  reason: string;
  hitAt: number;
}

export type GuardrailAuditSink = (hit: GuardrailRuleHit) => void;

/** 输出侧校验可携带的上下文（由 harness 在调用 checkOutput 时注入，core 不假定任何业务语义）。 */
export interface GuardrailOutputContext {
  /** 最近一次执行的工具调用（name 含 server 前缀，result 为工具返回文本）。 */
  recentTool?: { name: string; result: string } | null;
}

/** 上下文感知输出规则：接收输出文本与上下文，返回拦截结果。 */
export type ContextualOutputRule = (text: string, ctx: GuardrailOutputContext) => GuardrailResult;

/**
 * 外部语义级注入打分器（可接分类模型 / 第三方服务），得分 > 0.5 视为注入。
 * 支持同步 (text)=>number 或异步 (text)=>Promise<number>；同步路径（checkInput 等）
 * 仅消费数值结果（异步打分器在同步路径下被忽略，由 async 变体 await）。
 */
export type InjectionScorer = (text: string) => number | Promise<number>;
