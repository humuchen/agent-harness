/**
 * IM 桥接主体：入站事件 → 去重 → 会话映射 → 执行 agent → 回发结果。
 *
 * 关键设计（webhook 语义约束）：
 * - **立即 ack**：IM 平台要求 webhook 在数秒内返回 2xx，否则会重推。因此本模块
 *   校验/解析/去重后**立刻返回 200**，真正的 agent 执行与回复在后台异步进行
 *   （`void this.process(...)`），绝不阻塞 HTTP 响应。
 * - **执行解耦**：agent 如何跑由注入的 `ImExecutor` 决定——server 侧接现有
 *   `assembleAgent` + harness 链路，本模块不直接依赖 runner，便于单测注入桩。
 * - **安全闸门**：唯一入口是 `adapter.verifyInbound()`；未通过一律 401，不进 agent。
 * - **复用治理**：owner / session 映射后复用既有 chat-sessions（IM 对话在 Web 工作台可见）、
 *   审计、配额、护栏——无需为本模块新增任何治理代码。
 */

import { structLog } from '@agent-harness/core';
import type { ImAdapter, ImBridgeConfig, ImInboundMessage, ImProvider } from './types';
import { MemoryDedupStore, type DedupStore } from './dedup';

/** 入站处理的 HTTP 结果（由 server 路由直接写出）。 */
export interface ImInboundResult {
  status: number;
  body: unknown;
  contentType?: string;
}

/** 入站请求的最小形态（与 node:http 解耦，便于单测）。 */
export interface ImInboundRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: URL;
}

/**
 * agent 执行器（由 server 注入）。
 * 返回最终答案文本；抛错则由桥接回「处理失败」提示。
 */
export type ImExecutor = (
  msg: ImInboundMessage,
  prompt: string,
  cfg: ImBridgeConfig
) => Promise<string>;

/** 可观测回调（可选，默认空实现）。 */
export interface ImBridgeHooks {
  /** 审计一条 IM 动作（脱敏后）。 */
  onAudit?: (event: {
    action: string;
    provider: ImProvider;
    senderId: string;
    chatId: string;
    outcome: 'success' | 'failure' | 'denied';
    detail?: Record<string, unknown>;
  }) => void;
}

export class ImBridge {
  private readonly cfg: ImBridgeConfig;
  private readonly executor: ImExecutor;
  private readonly hooks: ImBridgeHooks;
  private readonly deduper: DedupStore;
  private readonly byProvider = new Map<ImProvider, ImAdapter>();
  /** 在飞任务数（可观测）。 */
  private inflight = 0;
  /** 累计处理计数（可观测）。 */
  private counters = { received: 0, deduped: 0, rejected: 0, completed: 0, failed: 0 };

  constructor(
    cfg: ImBridgeConfig,
    executor: ImExecutor,
    hooks: ImBridgeHooks = {},
    /** 去重后端：默认内存 LRU；多副本部署由调用方注入 Redis 实现（见 createDedupStore）。 */
    dedupStore: DedupStore = new MemoryDedupStore()
  ) {
    this.cfg = cfg;
    this.executor = executor;
    this.hooks = hooks;
    this.deduper = dedupStore;
    for (const a of cfg.adapters) this.byProvider.set(a.provider, a);
  }

  /** 已启用的平台清单。 */
  enabledProviders(): ImProvider[] {
    return [...this.byProvider.keys()];
  }

  /** 运行态快照（供 /api/im/status）。 */
  snapshot(): Record<string, unknown> {
    return {
      enabled: this.enabledProviders(),
      defaultMode: this.cfg.defaultMode,
      groupRequireMention: this.cfg.groupRequireMention,
      inflight: this.inflight,
      deduper: this.deduper.kind,
      deduperSize: this.deduper.size(),
      counters: { ...this.counters }
    };
  }

  /**
   * 处理一次入站 webhook 请求。
   * 返回的 HTTP 结果由调用方写出；命中合法消息时会**先返回 200**，再后台跑 agent。
   */
  async handleInbound(
    provider: ImProvider,
    req: ImInboundRequest
  ): Promise<ImInboundResult> {
    const adapter = this.byProvider.get(provider);
    if (!adapter) {
      return { status: 404, body: { error: `im provider not enabled: ${provider}` } };
    }
    // 1) URL 验证握手（飞书 challenge / 企微 echostr）：原样回显，不进 agent。
    const challenge = adapter.handleChallenge(req);
    if (challenge.handled) {
      return {
        status: 200,
        body: challenge.body ?? '',
        contentType: challenge.contentType
      };
    }
    // 2) 签名校验（唯一安全闸门）。
    if (!adapter.verifyInbound(req)) {
      this.counters.rejected++;
      this.hooks.onAudit?.({
        action: 'im.inbound',
        provider,
        senderId: '',
        chatId: '',
        outcome: 'denied',
        detail: { reason: 'signature verification failed' }
      });
      structLog('warn', 'im.inbound.rejected', { provider, reason: 'signature' });
      return { status: 401, body: { error: 'invalid signature' } };
    }
    // 3) 解析消息；非可处理事件（心跳 / 非文本 / 机器人自身消息）静默 200。
    let msg: ImInboundMessage | null;
    try {
      msg = adapter.parseInbound(req.rawBody);
    } catch (e: any) {
      structLog('warn', 'im.inbound.parse_failed', { provider, error: e?.message ?? String(e) });
      return { status: 200, body: { ok: true } };
    }
    if (!msg) return { status: 200, body: { ok: true } };

    this.counters.received++;
    // 4) 群聊 @ 门禁：未 @ 机器人则忽略（避免群里刷屏）。
    if (msg.isGroup && this.cfg.groupRequireMention && !msg.mentionedBot) {
      return { status: 200, body: { ok: true } };
    }
    // 5) 去重（平台重推 / 跨实例重复投递）：命中即静默丢弃。
    // 注意：Redis 后端下 check 是异步网络调用（SET NX），故必须 await —— 不可省略，
    // 否则所有消息都会被判定为「首次」而失去去重效果。
    const dedupKey = msg.messageId || `${msg.provider}:${msg.senderId}:${msg.chatId}:${msg.text}`;
    if (!(await this.deduper.check(dedupKey))) {
      this.counters.deduped++;
      structLog('debug', 'im.inbound.deduped', { provider, messageId: msg.messageId });
      return { status: 200, body: { ok: true } };
    }
    // 6) 空文本 / 不支持的消息类型：直接提示，不进 agent。
    if (!msg.text) {
      void this.reply(adapter, msg, '暂不支持该消息类型，请发送文字指令。');
      return { status: 200, body: { ok: true } };
    }

    // 7) 立即 ack，后台执行（不阻塞 webhook）。
    void this.process(adapter, msg);
    return { status: 200, body: { ok: true } };
  }

  /** 后台执行：跑 agent 并把结果回发 IM。 */
  private async process(adapter: ImAdapter, msg: ImInboundMessage): Promise<void> {
    this.inflight++;
    const started = Date.now();
    try {
      const final = await this.executor(msg, msg.text, this.cfg);
      const text = final?.trim() || '（模型未返回内容）';
      await this.reply(adapter, msg, text);
      this.counters.completed++;
      this.hooks.onAudit?.({
        action: 'im.task',
        provider: msg.provider,
        senderId: msg.senderId,
        chatId: msg.chatId,
        outcome: 'success',
        detail: { elapsedMs: Date.now() - started, replyChars: text.length }
      });
    } catch (e: any) {
      this.counters.failed++;
      const reason = e?.message ?? String(e);
      structLog('error', 'im.task.failed', { provider: msg.provider, error: reason });
      this.hooks.onAudit?.({
        action: 'im.task',
        provider: msg.provider,
        senderId: msg.senderId,
        chatId: msg.chatId,
        outcome: 'failure',
        detail: { elapsedMs: Date.now() - started, error: reason }
      });
      // 失败也尽量给用户一个明确反馈（回复失败不影响主流程）。
      await this.reply(adapter, msg, '抱歉，处理你的请求时出错了，请稍后重试。');
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
    }
  }

  /** 回发消息（统一加前缀 + 异常吞掉，回复失败不抛出）。 */
  private async reply(
    adapter: ImAdapter,
    msg: ImInboundMessage,
    text: string
  ): Promise<void> {
    try {
      await adapter.sendText(msg, `${this.cfg.replyPrefix}${text}`);
    } catch (e: any) {
      structLog('warn', 'im.reply.failed', {
        provider: msg.provider,
        error: e?.message ?? String(e)
      });
    }
  }
}

/**
 * 由 IM 会话派生稳定的 owner / session 标识。
 * - owner：`im:<provider>:<senderId>` —— 与登录用户体系隔离，但同样受记忆/会话按 owner 分区保护。
 * - sessionId：`im-<provider>-<sha256(chatId) 前 16 位>` —— 同一 IM 会话稳定映射到同一 chat session，
 *   IM 对话因此可在 Web 工作台「历史会话」中查看（复用 chat-sessions 落库）。
 */
export function deriveImIdentity(msg: ImInboundMessage): { owner: string; sessionId: string } {
  const owner = `im:${msg.provider}:${msg.senderId}`;
  const hash = sha256Hex(`${msg.provider}:${msg.chatId}`).slice(0, 16);
  return { owner, sessionId: `im-${msg.provider}-${hash}` };
}

function sha256Hex(s: string): string {
  // 延迟引入，避免在纯类型文件中引入 crypto（本文件已用于运行期）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
