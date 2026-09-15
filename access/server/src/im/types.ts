/**
 * IM 桥接契约（纯业务层，core 零感知）。
 *
 * 目标：把企业 IM（飞书 / 钉钉 / 企业微信）作为「用户层入口」，让员工在
 * 日常 IM 里直接给 agent 派任务、拿结果——与参考架构图用户层
 * 「企业微信 / 钉钉 / 飞书」入口对齐。
 *
 * 分层约束（与本仓库既有范式一致）：
 * - 本模块只存在于 `access/server` 业务层，**不修改 core**；agent 执行统一经
 *   现有 `assembleAgent()` + `runQueue` 链路，复用既有护栏 / 记忆 / 审计 / 配额。
 * - 每个 IM 平台差异（签名算法、消息体形状、主动发消息 API）收敛进一个
 *   `ImAdapter` 实现；桥接主体（bridge.ts）只依赖本文件的接口，新增平台
 *   只需再写一个 adapter 并登记进 registry，**主体零改动**。
 */

/** 支持的 IM 平台标识。 */
export type ImProvider = 'feishu' | 'dingtalk' | 'wecom';

/** 一条标准化后的入站 IM 消息（各平台解析差异已在 adapter 内消化）。 */
export interface ImInboundMessage {
  provider: ImProvider;
  /** 平台侧消息唯一 id（用于去重；缺失时由 bridge 用「用户+时间戳+文本」兜底合成）。 */
  messageId: string;
  /** 发送者平台内唯一 id（open_id / staffId / userid）。 */
  senderId: string;
  /** 发送者展示名（可选，仅用于审计与日志）。 */
  senderName?: string;
  /** 会话/群 id（单聊为 senderId；群聊为 chat_id/chatId）。 */
  chatId: string;
  /** 是否为群聊（决定回复是「单聊直发」还是「群内 @」）。 */
  isGroup: boolean;
  /** 群聊中是否 @ 了机器人（用于 IM_GROUP_REQUIRE_MENTION 门禁；单聊恒为 true）。 */
  mentionedBot: boolean;
  /** 纯文本内容（已剥离 @机器人 等噪声；非文本消息返回空串，桥接按不支持处理）。 */
  text: string;
  /** 原始事件体（审计留痕用，已在落库前做脱敏）。 */
  raw?: unknown;
}

/**
 * URL 验证握手结果。
 * 各平台在配置回调地址时会先发一次校验请求（飞书 challenge / 企微 echostr），
 * 需原样回显特定字段才认为地址有效。
 */
export interface ImChallengeResult {
  /** 命中了握手请求（bridge 应直接回该 body 并结束，不进入 agent 流程）。 */
  handled: boolean;
  /** 应原样返回给平台的响应体（JSON 对象或纯文本串）。 */
  body?: unknown;
  /** 响应 content-type（默认 application/json）。 */
  contentType?: string;
}

/** 一个 IM 平台的完整适配契约。 */
export interface ImAdapter {
  readonly provider: ImProvider;
  /** 该平台是否已配置齐全（缺关键凭据时桥接启动期跳过并告警）。 */
  isConfigured(): boolean;
  /** 缺失的配置项说明（供启动期告警，便于运维定位）。 */
  missingConfig(): string[];
  /**
   * 校验入站请求的合法性（签名 / 令牌）。返回 false 时 bridge 直接 401，
   * 绝不进入 agent 流程——这是 IM 入口唯一的安全闸门（webhook 无用户登录态）。
   */
  verifyInbound(req: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url: URL;
  }): boolean;
  /** 处理 URL 验证握手；非握手请求返回 { handled: false }。 */
  handleChallenge(req: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url: URL;
  }): ImChallengeResult;
  /** 把平台原始事件体解析为标准化消息；非「可处理消息」返回 null（如心跳、已读回执）。 */
  parseInbound(rawBody: string): ImInboundMessage | null;
  /** 主动向目标会话发送文本（各平台各自的发消息 API，零依赖 fetch 实现）。 */
  sendText(target: ImInboundMessage, text: string): Promise<void>;
}

/** IM 桥接运行配置（由 registry 从环境变量装配）。 */
export interface ImBridgeConfig {
  /** 启用的平台清单（已剔除未配置项）。 */
  adapters: ImAdapter[];
  /** 默认运行模式（mock / real / real-mcp）；未配置时按 IM_DEFAULT_MODE，缺省 real。 */
  defaultMode: 'mock' | 'real' | 'real-mcp';
  /** 单次 IM 任务的循环步数上限。 */
  maxSteps: number;
  /** 单次 IM 任务的整体超时（ms）。 */
  timeoutMs: number;
  /** 回复前缀（可选，如 "[AI] "），便于在 IM 里区分机器人消息。 */
  replyPrefix: string;
  /** 群聊中是否需要 @机器人 才触发（默认 true，避免刷屏）。 */
  groupRequireMention: boolean;
}
