import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { ref, createRef } from 'lit/directives/ref.js';
import { client } from './api';
import { sharedStyles } from './styles';
import { toRichHtml, escapeHtml } from './markdown';
import type { ChatSession, RunMode, StreamEvent } from '@agent-harness/client';

/* ------------------------------ 类型 ------------------------------ */

interface ToolView {
  name: string;
  args: string;
  result?: string;
  errored?: boolean;
}

interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** 推理过程（思考折叠块），仅推理模型有。 */
  reasoning?: string;
  /** 工具调用卡片列表。 */
  tools?: ToolView[];
  /** 错误态：以警示样式渲染。 */
  error?: boolean;
}

interface SessionView {
  id: string;
  title: string;
  updatedAt: number;
}

/* ------------------------------ Chat ------------------------------ */

@customElement('ah-chat')
export class AhChat extends LitElement {
  static styles = [
    sharedStyles,
    // 聊天专属样式：三栏式（侧栏 + 对话 + 输入），严格使用语义令牌，随主题切换。
    // 注意：sharedStyles 已设 :host{display:block;height:100vh;overflow:hidden}，这里覆盖为 flex 行布局。
    css`
      :host {
        display: flex;
        flex-direction: row;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        background: var(--ah-canvas);
      }
      .sidebar {
        width: 264px;
        flex: 0 0 264px;
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--ah-border);
        background: var(--ah-surface-1);
        min-height: 0;
      }
      .side-head {
        padding: 14px 14px 10px;
      }
      .new-btn {
        width: 100%;
        justify-content: center;
        gap: 8px;
      }
      .session-list {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 6px 8px 14px;
        min-height: 0;
      }
      .session {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 10px;
        border-radius: 10px;
        cursor: pointer;
        color: var(--ah-text);
        margin-bottom: 10px;
        background: var(--ah-surface-3, var(--ah-surface-2));
        transition: background 0.15s ease;
        &::last-child {
          margin-bottom: 0;
        }
      }
      .session:hover {
        background: var(--ah-surface-2);
      }
      .session.active {
        background: var(--ah-surface-3, var(--ah-surface-2));
        outline: 1px solid var(--ah-accent, #2997ff);
      }
      .session .title {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }
      .session .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ah-text-muted);
        flex: 0 0 auto;
      }
      .session .acts {
        display: none;
        gap: 4px;
      }
      .session:hover .acts {
        display: flex;
      }
      .icon-btn {
        border: none;
        background: transparent;
        color: var(--ah-text-muted);
        cursor: pointer;
        font-size: 12px;
        padding: 2px 5px;
        border-radius: 6px;
      }
      .icon-btn:hover {
        background: var(--ah-border);
        color: var(--ah-text);
      }
      .main {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
      }
      .chat-head {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 18px;
        border-bottom: 1px solid var(--ah-border);
        background: var(--ah-surface-1);
      }
      .chat-head .title {
        font-weight: 600;
        font-size: 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chat-head .spacer {
        flex: 1 1 auto;
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        color: var(--ah-text-muted);
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid var(--ah-border);
        background: var(--ah-surface-2);
        cursor: pointer;
        user-select: none;
        transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease,
          box-shadow 0.15s ease;
      }
      .toggle:hover {
        border-color: var(--ah-accent, #2997ff);
        color: var(--ah-text);
      }
      .toggle svg {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
      }
      .toggle.on {
        color: var(--ah-accent, #2997ff);
        border-color: var(--ah-accent, #2997ff);
        background: color-mix(in srgb, var(--ah-accent, #2997ff) 12%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--ah-accent, #2997ff) 28%, transparent);
      }
      .model-input {
        width: 180px;
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        border-radius: 8px;
        color: var(--ah-text);
        padding: 5px 9px;
        font-size: 12px;
      }
      .scroll {
        flex: 1 1 auto;
        overflow-y: auto;
        min-height: 0;
        padding: 18px 0;
      }
      .empty {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 18px;
        text-align: center;
        padding: 0 20px;
      }
      .empty h1 {
        font-size: 26px;
        font-weight: 600;
        margin: 0;
      }
      .empty p {
        color: var(--ah-text-muted);
        margin: 0;
        font-size: 14px;
      }
      .thread {
        max-width: 820px;
        margin: 0 auto;
        padding: 0 18px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .msg {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .msg.user {
        flex-direction: row-reverse;
      }
      .avatar {
        flex: 0 0 30px;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 600;
        background: var(--ah-surface-3, var(--ah-surface-2));
        color: var(--ah-text-muted);
      }
      .bubble {
        padding: 12px 14px;
        border-radius: 14px;
        line-height: 1.65;
        font-size: 14px;
        overflow-wrap: anywhere;
      }
      .msg.assistant .bubble {
        /* 固定宽度：撑满可用空间并封顶，避免流式打字时气泡宽度随内容从窄到宽跳变。 */
        flex: 1 1 auto;
        width: 100%;
        background: var(--ah-surface-1);
        border: 1px solid var(--ah-border);
        border-top-left-radius: 4px;
        max-width: 760px;
      }
      .msg.user .bubble {
        background: color-mix(in srgb, var(--ah-accent, #2997ff) 14%, var(--ah-surface-2));
        border-top-right-radius: 4px;
      }
      .msg.assistant.error .bubble {
        border-color: var(--ah-danger, #e24b4a);
      }
      .msg-text {
        font-size: 14px;
        line-height: 1.65;
      }
      .msg-text.placeholder {
        color: var(--ah-text-muted);
        font-style: italic;
      }
      .reasoning {
        margin-bottom: 10px;
        border: 1px solid var(--ah-border);
        border-left: 3px solid var(--ah-accent, #2997ff);
        border-radius: 10px;
        background: color-mix(in srgb, var(--ah-accent, #2997ff) 7%, var(--ah-surface-2));
        overflow: hidden;
      }
      .reasoning summary {
        cursor: pointer;
        padding: 9px 12px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--ah-accent, #2997ff);
        list-style: none;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .reasoning summary::-webkit-details-marker {
        display: none;
      }
      .reasoning .ricon {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        opacity: 0.95;
      }
      .reasoning .body {
        padding: 2px 12px 10px 34px;
        color: var(--ah-text-muted);
        font-size: 13px;
        line-height: 1.7;
        max-height: 150px;
        overflow-y: auto;
        overflow-x: hidden;
        position: relative;
        scrollbar-width: thin;
        scrollbar-color: var(--ah-border) transparent;
      }
      .reasoning .body::-webkit-scrollbar {
        width: 4px;
      }
      .reasoning .body::-webkit-scrollbar-thumb {
        background: var(--ah-border);
        border-radius: 2px;
      }
      /* 底部渐变遮罩：提示内容被截断 */
      .reasoning .body::after {
        content: '';
        position: sticky;
        bottom: 0;
        left: 0;
        right: 0;
        height: 32px;
        background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--ah-surface-2) 80%, transparent));
        pointer-events: none;
      }
      /* 工具摘要区：在深度思考框内统一展示所有工具调用 */
      .tool-summary {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px dashed var(--ah-border);
      }
      .tool-summary-title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        color: var(--ah-text);
        padding: 2px 0 6px;
      }
      .tool-summary-title svg {
        flex-shrink: 0;
        color: var(--ah-accent, #2997ff);
        opacity: 0.8;
      }
      /* 内嵌工具卡（在 reasoning body 内） */
      .inner-tool {
        margin-top: 4px;
        border: 1px solid var(--ah-border);
        border-radius: 7px;
        background: var(--ah-canvas);
        overflow: hidden;
      }
      .inner-tool summary {
        cursor: pointer;
        padding: 6px 10px;
        font-size: 11.5px;
        list-style: none;
        display: flex;
        gap: 6px;
        align-items: center;
        user-select: none;
      }
      .inner-tool summary::-webkit-details-marker {
        display: none;
      }
      .inner-tool .itag {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        flex-shrink: 0;
        background: color-mix(in srgb, var(--ah-accent, #2997ff) 12%, transparent);
        color: var(--ah-accent, #2997ff);
      }
      .inner-tool.errored .itag {
        background: color-mix(in srgb, var(--ah-danger, #e24b4a) 12%, transparent);
        color: var(--ah-danger, #e24b4a);
      }
      .inner-tool .iname {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--ah-text-muted);
        font-family: 'SF Mono', Menlo, Consolas, monospace;
        font-size: 11.5px;
      }
      .inner-tool .ichev {
        width: 9px;
        height: 9px;
        flex-shrink: 0;
        color: var(--ah-text-muted, #999);
        transition: transform 0.15s ease;
      }
      .inner-tool[open] .ichev {
        transform: rotate(180deg);
      }
      .reasoning .thinking {
        display: inline-flex;
        gap: 3px;
        margin-left: 2px;
        vertical-align: middle;
      }
      .reasoning .thinking i {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--ah-accent, #2997ff);
        animation: blinkdot 1.2s infinite ease-in-out;
      }
      .reasoning .thinking i:nth-child(2) {
        animation-delay: 0.2s;
      }
      .reasoning .thinking i:nth-child(3) {
        animation-delay: 0.4s;
      }
      @keyframes blinkdot {
        0%, 80%, 100% {
          opacity: 0.25;
          transform: translateY(0);
        }
        40% {
          opacity: 1;
          transform: translateY(-2px);
        }
      }
      .tool {
        margin: 8px 10px 10px;
        border: 1px solid var(--ah-border);
        border-radius: 10px;
        background: var(--ah-surface-2);
        overflow: hidden;
      }
      .tool summary {
        cursor: pointer;
        padding: 8px 12px;
        font-size: 12px;
        list-style: none;
        display: flex;
        gap: 7px;
        align-items: center;
        background: var(--ah-surface-3, var(--ah-surface-2));
        border-bottom: 1px solid var(--ah-border);
        user-select: none;
      }
      .tool summary::-webkit-details-marker {
        display: none;
      }
      .tool .tag {
        color: var(--ah-accent, #2997ff);
        font-weight: 500;
        flex-shrink: 0;
      }
      .tool .tname {
        color: var(--ah-text);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tool .chev {
        width: 10px;
        height: 10px;
        flex-shrink: 0;
        color: var(--ah-text-muted);
        transition: transform 0.15s ease;
      }
      .tool[open] .chev {
        transform: rotate(180deg);
      }
      .tool-pre {
        margin: 0;
        padding: 10px 12px;
        font-size: 11.5px;
        line-height: 1.55;
        overflow: auto;
        max-height: 200px;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--ah-text-muted);
        font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
        background: var(--ah-canvas);
      }
      .tool-result {
        padding: 8px 12px 10px;
        font-size: 11.5px;
        line-height: 1.55;
        color: var(--ah-text-muted);
        white-space: pre-wrap;
        word-break: break-word;
        border-top: 1px dashed var(--ah-border);
      }
      .tool.errored .tag {
        color: var(--ah-danger, #e24b4a);
      }
      .composer-wrap {
        border-top: 1px solid var(--ah-border);
        background: var(--ah-surface-1);
        padding: 12px 18px 16px;
      }
      .composer {
        max-width: 820px;
        margin: 0 auto;
        display: flex;
        align-items: flex-end;
        gap: 10px;
        border: 1px solid var(--ah-border);
        border-radius: 16px;
        background: var(--ah-surface-2);
        padding: 8px 8px 8px 14px;
      }
      .composer textarea {
        flex: 1 1 auto;
        resize: none;
        border: none;
        outline: none;
        background: transparent;
        color: var(--ah-text);
        font: inherit;
        font-size: 14px;
        line-height: 1.6;
        max-height: 180px;
        min-height: 24px;
      }
      .send {
        flex: 0 0 auto;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
      }
      .hint {
        max-width: 820px;
        margin: 8px auto 0;
        text-align: center;
        color: var(--ah-text-muted);
        font-size: 11px;
      }
      .caret {
        display: inline-block;
        width: 8px;
        height: 14px;
        margin-left: 2px;
        vertical-align: text-bottom;
        background: var(--ah-text);
        animation: blink 1s steps(2, start) infinite;
      }
      @keyframes blink {
        to {
          visibility: hidden;
        }
      }
      button {
        font-family: inherit;
      }
      button.primary {
        background: var(--ah-accent, #2997ff);
        color: #fff;
        border: none;
        border-radius: 9px;
        padding: 8px 14px;
        font-size: 13px;
        cursor: pointer;
      }
      button.ghost {
        background: transparent;
        border: 1px solid var(--ah-border);
        color: var(--ah-text);
        border-radius: 9px;
        padding: 8px 14px;
        font-size: 13px;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  @state() sessions: SessionView[] = [];
  @state() activeId = '';
  @state() messages: ChatMsg[] = [];
  @state() input = '';
  @state() model = '';
  @state() running = false;
  @state() mode: RunMode = 'mock';
  @state() deepThink = false;
  @state() web = false;
  @state() error: string | null = null;

  private nextId = 1;
  private abort?: AbortController;
  private activeIdx = -1;
  private jobId: string | null = null;
  private scrollRef = createRef<HTMLElement>();
  /** 标记本轮是否已收到 llm:token 增量，用于防止 llm:response 整段覆盖打字机效果 */
  private receivedTokens = false;
  /**
   * 打字机缓冲：真实模型 / 代理（如 agnes apihub）常把整段回复塞进单个 llm:token，
   * 若直接 patch 进 content 会「一帧跳到全文」，看不到逐字揭示。改为先进缓冲，
   * 由定时器按稳定节奏逐字揭示，使无论后端逐字小 delta 还是一次性大块都呈现打字机效果。
   */
  private pendingContent = '';
  private pendingReasoning = '';
  private typedTimer: ReturnType<typeof setInterval> | null = null;
  /** run:end 携带的权威全文（仅在打字机未产生任何可见文本时作兜底）。 */
  private finalContent = '';

  async connectedCallback() {
    super.connectedCallback();
    try {
      const [list, state] = await Promise.all([client.listChatSessions(), client.getState()]);
      this.sessions = list.map((s: ChatSession) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      }));
      this.mode = (state as any)?.openrouter ? 'real' : 'mock';
    } catch {
      /* 离线/未启动：仍可进入空状态，发送时按 mock 兜底 */
    }
  }

  protected updated() {
    this.scrollToBottom();
  }

  private scrollToBottom() {
    const el = this.scrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /* ----------------------- 会话管理 ----------------------- */

  private async newChat() {
    this.abort?.abort();
    this.activeId = '';
    this.messages = [];
    this.input = '';
    this.error = null;
    this.stopTypewriter();
    this.pendingContent = '';
    this.pendingReasoning = '';
  }

  private async selectSession(id: string) {
    if (id === this.activeId) return;
    this.abort?.abort();
    this.activeId = id;
    this.error = null;
    this.input = '';
    // 切换会话时停掉打字机并清空缓冲，避免上一个会话的残留文本泄漏到新会话。
    this.stopTypewriter();
    this.pendingContent = '';
    this.pendingReasoning = '';
    // 优先用本地内存中的消息；否则向服务端拉取历史。
    try {
      const s = await client.getChatSession(id);
      this.messages = s.messages.map((m) => ({
        id: this.nextId++,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        // 还原落盘时一并写入的推理与工具调用，避免切换会话后再切回丢失深度思考/工具卡片。
        reasoning: m.reasoning,
        tools: m.tools
          ? m.tools.map((t) => ({ name: t.name, args: t.args ?? '', result: t.result, errored: t.errored }))
          : undefined,
      }));
    } catch {
      this.messages = [];
    }
  }

  private async renameSession(id: string) {
    const cur = this.sessions.find((s) => s.id === id);
    const title = window.prompt('重命名会话', cur?.title ?? '');
    if (!title || !title.trim()) return;
    try {
      await client.renameChatSession(id, title.trim());
      this.sessions = this.sessions.map((s) => (s.id === id ? { ...s, title: title.trim() } : s));
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  private async deleteSession(id: string) {
    if (!window.confirm('删除该会话及其消息？')) return;
    try {
      await client.deleteChatSession(id);
      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.activeId === id) this.newChat();
    } catch (e: any) {
      this.error = String(e?.message ?? e);
    }
  }

  /* ----------------------- 发送 / 流式 ----------------------- */

  private async ensureSession(): Promise<string> {
    if (this.activeId) return this.activeId;
    const s = await client.createChatSession('新对话');
    this.activeId = s.id;
    this.sessions = [
      { id: s.id, title: s.title, updatedAt: s.updatedAt },
      ...this.sessions,
    ];
    return s.id;
  }

  private async send() {
    const prompt = this.input.trim();
    if (!prompt || this.running) return;
    this.error = null;

    const sessionId = await this.ensureSession();

    this.messages = [
      ...this.messages,
      { id: this.nextId++, role: 'user', content: prompt },
      { id: this.nextId++, role: 'assistant', content: '' },
    ];
    this.activeIdx = this.messages.length - 1;
    this.input = '';
    // 重置打字机状态（防御上轮残留的缓冲 / 定时器泄漏到本轮）。
    this.receivedTokens = false;
    this.pendingContent = '';
    this.pendingReasoning = '';
    this.finalContent = '';
    this.stopTypewriter();
    this.running = true;

    const ac = new AbortController();
    this.abort = ac;
    try {
      for await (const ev of client.streamRun(
        {
          mode: this.mode,
          prompt,
          model: this.model || undefined,
          sessionId,
          chatSessionId: sessionId,
        },
        { signal: ac.signal }
      )) {
        this.ingest(ev as StreamEvent);
      }
    } catch (e: any) {
      this.messages = this.messages.map((m, i) =>
        i === this.activeIdx ? { ...m, error: true, content: m.content || `⚠️ ${e?.message ?? e}` } : m
      );
    } finally {
      // 停掉 interval 定时器，改由 drainTypewriter 接管，按打字节奏把剩余缓冲揭示完，
      // 避免 run:end 的 final 文本一次性覆盖掉打字机效果。
      this.stopTypewriter();
      if (ac.signal.aborted) {
        // 被中止：立即落盘剩余文本（不追求打字质感）。
        this.flushTypewriter();
      } else {
        await this.drainTypewriter();
        // 兜底：若打字机全程未产生可见文本（如收到空 delta 但 run:end 带 final），用 final 补上。
        const c = this.activeIdx >= 0 ? this.messages[this.activeIdx] : null;
        if (c && !c.content && this.finalContent) {
          this.patchActive({ content: this.finalContent });
        }
      }
      this.running = false;
      this.activeIdx = -1;
      this.jobId = null;
    }
  }

  private stop() {
    this.abort?.abort();
  }

  private ingest(ev: StreamEvent) {
    // 每次都从最新 this.messages 读取当前消息：patch 会整体替换数组与对象，
    // 早期捕获的引用是「旧快照」，直接用它做增量拼接会丢内容 / 看不到已落下的工具卡。
    const cur = (): ChatMsg | null =>
      this.activeIdx >= 0 ? this.messages[this.activeIdx] ?? null : null;
    const patch = (p: Partial<ChatMsg>) => {
      if (this.activeIdx < 0) return;
      this.messages = this.messages.map((x, i) => (i === this.activeIdx ? { ...x, ...p } : x));
    };
    switch (ev.type) {
      case 'job:accepted':
        this.jobId = (ev as any).jobId ?? this.jobId;
        break;
      case 'llm:token': {
        const c = cur();
        if (c) {
          this.receivedTokens = true;
          // 不再直接 patch 到 content：整段塞进单 delta 时会「一帧跳全文」。
          // 改为进 pending 缓冲，由打字机定时器按节奏逐字揭示。
          this.pendingContent += String((ev as any).delta ?? '');
          this.ensureTypewriter();
        }
        break;
      }
      case 'llm:reasoning': {
        const c = cur();
        if (c) {
          this.pendingReasoning += String((ev as any).delta ?? '');
          this.ensureTypewriter();
        }
        break;
      }
      case 'llm:response': {
        // 关键修复：如果已经通过 llm:token 增量构建了内容，不再用 llm:response 覆盖
        // （harness 在 token 流结束后总会发一次 llm:response 携带整段 content，
        //   多轮工具调用时中间轮的 content='' 会把已累积文本清空）。
        // 仅在未收到任何 token 时（非流式回退路径）才用 response content 赋值。
        const c = cur();
        if (c && !this.receivedTokens) {
          const respContent = String((ev as any).content ?? '');
          if (respContent) patch({ content: respContent });
        }
        break;
      }
      case 'tool:start': {
        const c = cur();
        if (!c) break;
        const tools = [...(c.tools ?? [])];
        tools.push({
          name: (ev as any).call?.name ?? 'unknown',
          args: safeJson((ev as any).call?.arguments),
        });
        patch({ tools });
        break;
      }
      case 'tool:result': {
        const c = cur();
        if (!c) break;
        const tools = [...(c.tools ?? [])];
        const evName = (ev as any).call?.name;
        // 回填最近一条同名且尚未有结果的工具卡。
        // 注意：必须要求 evName 存在（否则 undefined===undefined 会误匹配到任意空卡），
        // 且用 result === undefined 区分「未回填」与「已回填空串」，避免重复覆盖。
        if (evName !== undefined) {
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i].name === evName && tools[i].result === undefined) {
              tools[i] = {
                ...tools[i],
                result: String((ev as any).result ?? ''),
                errored: Boolean((ev as any).errored),
              };
              break;
            }
          }
        }
        patch({ tools });
        break;
      }
      case 'guardrail:blocked': {
        const c = cur();
        if (c)
          patch({
            content:
              c.content +
              `\n\n> ⚠️ 护栏拦截（${escapeHtml(String((ev as any).phase ?? ''))}）：${escapeHtml(
                String((ev as any).reason ?? '')
              )}`,
          });
        break;
      }
      case 'run:end': {
        const finalStr = String((ev as any).final ?? '');
        this.finalContent = finalStr;
        // 若已通过 llm:token 走打字机揭示：不在这里用 final 覆盖 content（否则整段秒显，打字机失效）。
        // 让打字机按节奏自然揭示到 final 文本；仅在完全没有 token 增量时（非流式回退）才直接赋值。
        if (!this.receivedTokens && finalStr) {
          const c = cur();
          if (c) patch({ content: finalStr });
        }
        break;
      }
      case 'error': {
        const c = cur();
        if (c) patch({ error: true, content: c.content || `⚠️ ${escapeHtml(String((ev as any).message ?? ev))}` });
        break;
      }
      default:
        break;
    }
  }

  /* ----------------------- 打字机缓冲 ----------------------- */

  /** 更新当前正在流式输出的 assistant 消息字段（activeIdx 指向的那条）。 */
  private patchActive(p: Partial<ChatMsg>) {
    if (this.activeIdx < 0) return;
    this.messages = this.messages.map((x, i) => (i === this.activeIdx ? { ...x, ...p } : x));
  }

  /**
   * 计算本 tick 应揭示的字符数：自适应速度。
   * 缓冲越大揭示越快（保证长文在 ~1.5s 内揭示完），但最小 2 字/tick 保留打字质感，
   * 最大 28 字/tick 防止对超长文本揭示过慢。真流式（小 delta 频繁到达）时缓冲始终很小，
   * 故以最小速度揭示，呈现自然打字节奏。
   */
  private typeStep(n: number): number {
    if (n <= 0) return 0;
    return Math.min(28, Math.max(2, Math.ceil(n / 70)));
  }

  /** 启动打字机定时器（已运行则跳过）。 */
  private ensureTypewriter() {
    if (this.typedTimer) return;
    this.typedTimer = setInterval(() => this.tickTypewriter(), 24);
  }

  /** 停止打字机定时器并清空缓冲状态。 */
  private stopTypewriter() {
    if (this.typedTimer) {
      clearInterval(this.typedTimer);
      this.typedTimer = null;
    }
  }

  /** 把缓冲中的待揭示文本一次性落到 content / reasoning（运行结束或切换会话时调用，避免文本滞留）。 */
  private flushTypewriter() {
    if (this.activeIdx >= 0) {
      const c = this.messages[this.activeIdx];
      if (c) {
        if (this.pendingContent) {
          this.patchActive({ content: c.content + this.pendingContent });
          this.pendingContent = '';
        }
        if (this.pendingReasoning) {
          this.patchActive({ reasoning: (c.reasoning ?? '') + this.pendingReasoning });
          this.pendingReasoning = '';
        }
      }
    }
    this.pendingContent = '';
    this.pendingReasoning = '';
    this.stopTypewriter();
  }

  /**
   * 运行结束后，接替 interval 把剩余缓冲按打字节奏（与 tick 一致的步长/间隔）逐步揭示，
   * 直到缓冲清空再 resolve。这样即使后端在一瞬间把整段塞进单个 token，用户也能看到逐字打字效果，
   * 而不是 run:end 的 final 文本一次性覆盖。
   */
  private drainTypewriter(): Promise<void> {
    return new Promise((resolve) => {
      const step = () => {
        if (!this.pendingContent.length && !this.pendingReasoning.length) {
          this.stopTypewriter();
          resolve();
          return;
        }
        this.tickTypewriter();
        setTimeout(step, 24);
      };
      step();
    });
  }

  /** 每个 tick 从缓冲中揭示一段字符到可见文本。 */
  private tickTypewriter() {
    if (this.activeIdx < 0) {
      this.stopTypewriter();
      return;
    }
    const c = this.messages[this.activeIdx];
    if (!c) {
      this.stopTypewriter();
      return;
    }
    if (this.pendingContent.length) {
      const step = this.typeStep(this.pendingContent.length);
      const move = this.pendingContent.slice(0, step);
      this.pendingContent = this.pendingContent.slice(step);
      this.patchActive({ content: c.content + move });
    }
    if (this.pendingReasoning.length) {
      const step = this.typeStep(this.pendingReasoning.length);
      const move = this.pendingReasoning.slice(0, step);
      this.pendingReasoning = this.pendingReasoning.slice(step);
      this.patchActive({ reasoning: (c.reasoning ?? '') + move });
    }
    // 缓冲清空且运行已结束 → 停止定时器（避免空转占资源）。
    if (!this.pendingContent.length && !this.pendingReasoning.length && !this.running) {
      this.stopTypewriter();
    }
  }

  /* ----------------------- 渲染辅助 ----------------------- */

  private onInput(e: Event) {
    this.input = (e.target as HTMLTextAreaElement).value;
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  }

  private renderMessage(m: ChatMsg) {
    const isUser = m.role === 'user';
    // 深度思考：有推理内容或有工具调用时都展示（工具调用是模型"思考过程"的一部分）
    const hasReasoning = !!m.reasoning;
    const hasTools = !!(m.tools && m.tools.length > 0);
    const showThinking = hasReasoning || hasTools;
    // 展开状态：有内容时跟随开关，流式输出中强制展开
    const thinkingOpen = this.deepThink || (
      this.running && this.activeIdx >= 0 && this.messages[this.activeIdx]?.id === m.id
    );
    const isStreamingReasoning = this.running && this.activeIdx >= 0
      && this.messages[this.activeIdx]?.id === m.id && showThinking && !m.content;
    // 是否当前正在流式输出的 assistant 消息
    const isStreamingAssistant = this.running && this.activeIdx >= 0
      && this.messages[this.activeIdx]?.id === m.id && m.role === 'assistant';

    // 工具摘要：合并同名工具显示次数
    const toolSummary = hasTools ? this.summarizeTools(m.tools!) : '';

    return html`
      <div class="msg ${m.role} ${m.error ? 'error' : ''}">
        <div class="avatar">${isUser ? '你' : 'A'}</div>
        <div class="bubble">
          ${showThinking
            ? html`<details class="reasoning" ?open=${thinkingOpen}>
                <summary>
                  <svg class="ricon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 18h6M10 21h4" />
                    <path d="M12 3a6 6 0 0 0-3.8 10.7c.6.5.8 1.2.8 2.3h6c0-1.1.2-1.8.8-2.3A6 6 0 0 0 12 3z" />
                  </svg>
                  <span>深度思考</span>
                  ${isStreamingReasoning
                    ? html`<span class="thinking"><i></i><i></i><i></i></span>`
                    : nothing}
                </summary>
                <div class="body">
                  ${hasReasoning ? unsafeHTML(toRichHtml(m.reasoning??'')) : nothing}
                  ${hasTools
                    ? html`
                        <div class="tool-summary">
                          <div class="tool-summary-title">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                            已调用 ${m.tools!.length} 个工具${toolSummary}
                          </div>
                          ${m.tools!.map(
                            (t) => html`
                              <details class="inner-tool ${t.errored ? 'errored' : ''}">
                                <summary>
                                  <span class="itag">${t.errored ? '✕' : '✓'}</span>
                                  <span class="iname">${escapeHtml(t.name)}</span>
                                  <svg class="ichev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                                </summary>
                                ${t.args ? html`<pre class="tool-pre">${formatToolJson(t.args)}</pre>` : nothing}
                                ${t.result !== undefined
                                  ? html`<div class="tool-result">结果：${formatToolJson(t.result)}</div>`
                                  : nothing}
                              </details>
                            `
                          )}
                        </div>
                      `
                    : nothing}
                </div>
              </details>`
            : nothing}
          ${m.content
            ? html`<div class="msg-text">${unsafeHTML(toRichHtml(m.content))}</div>`
            : nothing}
          ${isStreamingAssistant
            ? html`<span class="caret"></span>`
            : nothing}
          ${!m.content && !isStreamingAssistant && !showThinking
            ? html`<div class="msg-text placeholder">等待响应...</div>`
            : nothing}
        </div>
      </div>
    `;
  }

  /** 合并同名工具为 "×N" 摘要 */
  private summarizeTools(tools: ToolView[]): string {
    const counts = new Map<string, number>();
    for (const t of tools) {
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [name, count] of counts) {
      parts.push(count > 1 ? `${escapeHtml(name)}×${count}` : escapeHtml(name));
    }
    return parts.length > 0 ? `（${parts.join('、')}）` : '';
  }

  render() {
    const active = this.sessions.find((s) => s.id === this.activeId);
    return html`
      <div class="sidebar">
        <div class="side-head">
          <button class="primary new-btn" @click=${() => this.newChat()}>＋ 新对话</button>
        </div>
        <div class="session-list">
          ${this.sessions.length === 0
            ? html`<p class="muted" style="padding:8px 10px">暂无会话，发送消息即自动创建。</p>`
            : this.sessions.map(
                (s) => html`
                  <div
                    class="session ${s.id === this.activeId ? 'active' : ''}"
                    @click=${() => this.selectSession(s.id)}
                  >
                    <span class="dot"></span>
                    <span class="title">${escapeHtml(s.title)}</span>
                    <span class="acts">
                      <button class="icon-btn" title="重命名" @click=${(e: Event) => { e.stopPropagation(); this.renameSession(s.id); }}>✎</button>
                      <button class="icon-btn" title="删除" @click=${(e: Event) => { e.stopPropagation(); this.deleteSession(s.id); }}>🗑</button>
                    </span>
                  </div>
                `
              )}
        </div>
      </div>

      <div class="main">
        <div class="chat-head">
          <span class="title">${active ? escapeHtml(active.title) : '新对话'}</span>
          <span class="spacer"></span>
          <input
            class="model-input"
            placeholder="模型（留空用服务端默认）"
            .value=${this.model}
            @input=${(e: Event) => (this.model = (e.target as HTMLInputElement).value)}
          />
          <span
            class="toggle ${this.deepThink ? 'on' : ''}"
            title="UI 占位：暂未接入后端推理开关"
            @click=${() => (this.deepThink = !this.deepThink)}
            ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.8 10.7c.6.5.8 1.2.8 2.3h6c0-1.1.2-1.8.8-2.3A6 6 0 0 0 12 3z" /></svg>深度思考</span
          >
          <span
            class="toggle ${this.web ? 'on' : ''}"
            title="UI 占位：暂未接入后端联网开关"
            @click=${() => (this.web = !this.web)}
            ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18" /></svg>联网搜索</span
          >
        </div>

        <div class="scroll" ${ref(this.scrollRef)}>
          ${this.messages.length === 0
            ? html`
                <div class="empty">
                  <h1>有什么可以帮你的？</h1>
                  <p>基于 agent-harness 的多会话对话。下方输入即可开始，右侧可新建 / 切换会话。</p>
                </div>
              `
            : html`<div class="thread">${this.messages.map((m) => this.renderMessage(m))}</div>`}
        </div>

        <div class="composer-wrap">
          <div class="composer">
            <textarea
              rows="1"
              placeholder="给 Agent 发送消息…（Enter 发送，Shift+Enter 换行）"
              .value=${this.input}
              ?disabled=${this.running}
              @input=${this.onInput}
              @keydown=${this.onKey}
            ></textarea>
            ${this.running
              ? html`<button class="send" title="停止" @click=${() => this.stop()}>■</button>`
              : html`<button class="send" title="发送" ?disabled=${!this.input.trim()} @click=${() => this.send()}>↑</button>`}
          </div>
          <div class="hint">
            模式：${this.mode} ·
            token 级流式已开启（打字机效果）· 深度思考/联网为 UI 占位
          </div>
        </div>
      </div>
    `;
  }
}

/** 把任意值安全转成单行/多行 JSON 预览，失败则原样字符串化。 */
function safeJson(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.length > 800 ? v.slice(0, 800) + '…' : v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 800 ? s.slice(0, 800) + '…' : s;
  } catch {
    return String(v);
  }
}

/**
 * 格式化工具卡入参/结果供 <pre> 展示。
 * 只转义 < > & 三种 HTML 危险字符，保留引号和换行不被转义，
 * 避免 JSON 中的 " 被 escapeHtml 转成 &quot; 导致渲染异常。
 */
function formatToolJson(raw: string): string {
  if (!raw) return '';
  // 先尝试解码已有的 HTML 实体（防御服务端已转义的情况），全部 5 种与 escapeHtml 对称。
  let decoded = raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  // 尝试美化 JSON（解析成功则缩进；否则原样展示）
  try {
    const parsed = JSON.parse(decoded);
    decoded = JSON.stringify(parsed, null, 2);
  } catch {
    /* 不是合法 JSON，原样展示 */
  }
  // 统一转义全部 5 种 HTML 危险字符，与 escapeHtml 保持一致，杜绝引号漏转义的 XSS 缝隙。
  return decoded
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
