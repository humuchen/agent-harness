/**
 * chat.ts 渲染簇抽离（Phase 1）。
 *
 * 这些渲染函数强耦合组件交互态（editingMsgId / streaming / traceDrawerMsg /
 * planExec / deepThink 等）与若干回调（copyMsgText / startEdit / toggleThink /
 * confirmPlan / openPreview …）。采用「数据 + 回调」opts 模式：调用方（AhChat）
 * 通过 `renderCtx()` 构造一个 `ChatRenderCtx`（快照当前交互态 + 绑定到类方法的
 * 回调闭包）并传入，函数内部零 `this.*` 依赖。行为与抽离前完全一致，且模块不依赖
 * AhChat 内部可见性，便于单独审阅与测试。
 */
import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderAttachments } from './chat-render-utils';
import { parseDeepThinking } from './utils/chat-utils';
import { toRichHtml, escapeHtml } from './utils/markdown';
import {
  countTraceNodes,
  renderTraceNode,
  buildInsights,
  renderInsights,
  renderConfidence
} from './chat-trace';
import type { ChatMsg, PlanExecState } from './chat-types';
import type { UploadedFile } from './agent-context';

/** 渲染函数所需的交互态快照 + 回调闭包。由 AhChat.renderCtx() 构造。 */
export interface ChatRenderCtx {
  activeId: string;
  messages: ChatMsg[];
  streaming: Record<string, boolean>;
  streamIdx: Record<string, number>;
  editingMsgId: number;
  editingDraft: string;
  hoverUserMsgId: number;
  copiedMsgId: number;
  deepThink: boolean;
  thinkCollapsed: Record<string, boolean>;
  traceDrawerMsg: ChatMsg | null;
  traceDrawerSection: 'trace' | 'insights' | 'confidence';
  connState: Record<string, 'connected' | 'reconnecting' | 'lost'>;
  jobBy: Record<string, string>;
  planExec: Record<number, PlanExecState>;
  // —— 回调（绑定到 AhChat 对应方法）——
  onEditingInput: (value: string) => void;
  sendEdit: (id: number) => void;
  cancelEdit: () => void;
  copyMsgText: (id: number, content: string) => void;
  startEdit: (id: number, content: string) => void;
  toggleThink: (id: number) => void;
  openPreview: (f: UploadedFile) => void;
  resumeLost: (id: string) => void;
  confirmPlan: (m: ChatMsg) => void;
  cancelPlan: (msgId: number) => void;
  setTraceDrawer: (m: ChatMsg | null, section: 'trace' | 'insights' | 'confidence') => void;
  requestUpdate: () => void;
  onComposerPointerDown: (e: PointerEvent) => void;
  onComposerPointerMove: (e: PointerEvent) => void;
  onComposerPointerUp: () => void;
  onContextMenu: (e: Event) => void;
}

/** 连接状态横幅（顶部）：connected 不显示；reconnecting 提示自动恢复；lost 提供「重新连接」。 */
export function renderConnBanner(
  ctx: ChatRenderCtx
): TemplateResult | typeof nothing {
  const st = ctx.connState[ctx.activeId];
  if (!st || st === 'connected') return nothing;
  if (st === 'reconnecting') {
    return html`<div class="conn-banner warn">
      ⚠️ 连接中断，正在自动恢复会话…
    </div>`;
  }
  return html`<div class="conn-banner lost">
    <span
      >⚠️
      与服务器的连接已断开${ctx.jobBy[ctx.activeId]
        ? ''
        : '，本次运行已丢失'}</span
    >
    ${ctx.jobBy[ctx.activeId]
      ? html`<button
          class="conn-retry"
          @click=${() => ctx.resumeLost(ctx.activeId)}
        >
          重新连接
        </button>`
      : nothing}
  </div>`;
}

/** 单条消息渲染：用户气泡（含编辑态/附件/复制/编辑）+ 助手合并视图（思考/回答/计划/调用链）。 */
export function renderMessage(ctx: ChatRenderCtx, m: ChatMsg): TemplateResult {
  // 用户消息：渲染气泡文本 + 附件预览。
  if (m.role === 'user') {
    const hasAttachments = m.attachments && m.attachments.length > 0;
    // 编辑态：气泡原位替换为编辑框（草稿 + 取消/发送），不再展示原文。
    if (ctx.editingMsgId === m.id) {
      return html`
        <div class="msg user">
          <div class="avatar">你</div>
          <div class="bubble editing">
            <textarea
              class="edit-input"
              .value=${ctx.editingDraft}
              @input=${(e: Event) =>
                ctx.onEditingInput(
                  (e.target as HTMLTextAreaElement).value
                )}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ctx.sendEdit(m.id);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  ctx.cancelEdit();
                }
              }}
              @pointerdown=${ctx.onComposerPointerDown}
              @pointermove=${ctx.onComposerPointerMove}
              @pointerup=${ctx.onComposerPointerUp}
              @contextmenu=${ctx.onContextMenu}
            ></textarea>
            <div class="edit-actions">
              <button
                type="button"
                class="edit-btn"
                title="取消编辑 (Esc)"
                @click=${() => ctx.cancelEdit()}
              >
                取消
              </button>
              <button
                type="button"
                class="edit-btn primary"
                title="发送 (Enter)"
                ?disabled=${!ctx.editingDraft.trim() ||
                ctx.streaming[ctx.activeId] === true}
                @click=${() => ctx.sendEdit(m.id)}
              >
                发送 ↑
              </button>
            </div>
          </div>
        </div>
      `;
    }
    return html`
      <div class="msg user">
        <div class="avatar">你</div>
        <div class="user-col">
          <div class="bubble">
            ${hasAttachments
              ? renderAttachments({
                  files: m.attachments!,
                  onPreview: (f: UploadedFile) => ctx.openPreview(f)
                })
              : nothing}
            <div class="msg-text">${unsafeHTML(toRichHtml(m.content))}</div>
          </div>
          ${m.content?.trim()
            ? html`<div
                class="msg-actions ${ctx.hoverUserMsgId === m.id
                  ? 'show'
                  : ''}"
              >
                <button
                  type="button"
                  class="msg-action"
                  title=${ctx.copiedMsgId === m.id ? '已复制' : '复制'}
                  @click=${() => ctx.copyMsgText(m.id, m.content)}
                >
                  ${ctx.copiedMsgId === m.id
                    ? html`<svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>`
                    : html`<svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                        <path
                          d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
                        />
                      </svg>`}
                </button>
                <button
                  type="button"
                  class="msg-action"
                  title="编辑"
                  ?disabled=${ctx.streaming[ctx.activeId] === true}
                  @click=${() => ctx.startEdit(m.id, m.content)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </button>
              </div>`
            : nothing}
        </div>
      </div>
    `;
  }

  // 助手消息：合并视图 —— 深度思考（实时流式）在上，最终回答（分隔后）在下；
  // 模型仍在处理时于对应区域显示「思考中 / 模型正在回复…」文字动效。
  // 流式判定基于「当前显示会话是否正在流式、且本消息即其流式消息」。
  const sIdx = ctx.streamIdx[ctx.activeId] ?? -1;
  const isStreamingAssistant =
    ctx.streaming[ctx.activeId] === true &&
    sIdx >= 0 &&
    ctx.messages[sIdx]?.id === m.id &&
    m.role === 'assistant';
  // 是否展示思考区：仅当模型确实返回了推理内容（流式首 token 到达即出现）。
  const showThinking = !!m.reasoning;
  const isThinking = isStreamingAssistant && !m.content;
  const isAnswering = isStreamingAssistant && !!m.content;
  // 复制按钮：仅在回答已产出内容且非流式进行中时显示。
  const showCopy = !!m.content?.trim() && !isStreamingAssistant;

  return html`
    <div class="msg assistant ${m.error ? 'error' : ''}">
      <div class="avatar">A</div>
      ${showCopy
        ? html`<button
            type="button"
            class="assistant-copy ${ctx.copiedMsgId === m.id ? 'done' : ''}"
            title=${ctx.copiedMsgId === m.id ? '已复制' : '复制'}
            @click=${() => ctx.copyMsgText(m.id, m.content)}
          >
            ${ctx.copiedMsgId === m.id
              ? html`<svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>`
              : html`<svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path
                    d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
                  />
                </svg>`}
          </button>`
        : nothing}
      <div class="bubble">
        ${showThinking && ctx.deepThink
          ? renderThinking(ctx, m, isThinking)
          : nothing}
        ${showThinking &&
        ctx.deepThink &&
        (m.content || isStreamingAssistant)
          ? html`<div class="sep"><span>回答</span></div>`
          : nothing}
        ${renderAnswer(m, isAnswering, isStreamingAssistant)}
        ${m.plan ? renderPlanCard(ctx, m) : nothing}
        ${renderExtras(ctx, m, isStreamingAssistant)}
      </div>
    </div>
  `;
}

/**
 * 渲染「深度思考」区（合并视图·顶部）：
 * 展示模型实际返回的推理内容（m.reasoning），随 llm:reasoning 增量经打字机逐字显现。
 * 流式推理进行中时，标题显示「思考中…」动效、正文末尾显示闪烁光标。
 */
export function renderThinking(
  ctx: ChatRenderCtx,
  m: ChatMsg,
  isThinking: boolean
): TemplateResult {
  const parsed =
    m.reasoning && m.reasoning.trim() ? parseDeepThinking(m.reasoning) : null;
  const collapsed = !!ctx.thinkCollapsed[String(m.id)];
  return html`
    <div
      class="think ${isThinking ? 'live' : ''} ${collapsed ? 'collapsed' : ''}"
    >
      <div
        class="think-head"
        @click=${() => ctx.toggleThink(m.id)}
        title="点击折叠 / 展开"
      >
        <svg
          class="think-ico"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 18h6M10 21h4" />
          <path
            d="M12 3a6 6 0 0 0-3.8 10.7c.6.5.8 1.2.8 2.3h6c0-1.1.2-1.8.8-2.3A6 6 0 0 0 12 3z"
          />
        </svg>
        <span class="think-title">深度思考</span>
        ${isThinking
          ? html`<span class="think-status"
              >思考中<span class="dots"><i></i><i></i><i></i></span
            ></span>`
          : nothing}
        ${collapsed && m.reasoning
          ? html`<span class="think-count">${m.reasoning.length} 字</span>`
          : nothing}
        <svg
          class="think-chev"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      <div class="think-body">
        ${parsed
          ? html` ${parsed.vars.length
                ? html`<div class="dvars">
                    <div class="dvars-title">关键变量</div>
                    <div class="dvars-grid">
                      ${parsed.vars.map(
                        ([k, v]) => html`<div class="dvar">
                          <span class="dvar-k">${escapeHtml(k)}</span>
                          <span class="dvar-v">${escapeHtml(v)}</span>
                        </div>`
                      )}
                    </div>
                  </div>`
                : nothing}
              <div class="think-text">
                ${parsed.text
                  ? unsafeHTML(toRichHtml(parsed.text))
                  : html`<span class="muted">（暂无推理内容）</span>`}
              </div>`
          : html`<div class="think-text muted">
              ${isThinking ? '模型正在思考…' : '（模型未返回推理内容）'}
            </div>`}
        ${isThinking ? html`<span class="caret"></span>` : nothing}
      </div>
    </div>
  `;
}

/** 渲染最终回答区（合并视图·底部）：随 llm:token 增量逐字显现；流式进行中显示「模型正在回复…」动效。 */
export function renderAnswer(
  m: ChatMsg,
  isAnswering: boolean,
  isStreaming: boolean
): TemplateResult {
  return html`
    <div class="answer">
      ${m.content && m.content.trim()
        ? html`<div class="msg-text">
            ${unsafeHTML(toRichHtml(m.content))}
          </div>`
        : nothing}
      ${isAnswering ? html`<span class="caret"></span>` : nothing}
      ${isStreaming
        ? html`<div class="replying">
            模型正在回复<span class="dots"><i></i><i></i><i></i></span>
          </div>`
        : nothing}
      ${!m.content && !isStreaming
        ? html`<div class="msg-text placeholder">等待响应…</div>`
        : nothing}
    </div>
  `;
}

/**
 * 渲染 Agent 回复下方的「调用链路 / 关键信息」入口按钮。
 * 点按钮 → <ah-drawer> 侧滑抽屉展示（不占用主阅读流、移动端更友好）。
 * 两个分区各一个按钮；点击分别打开抽屉并定位到对应分区。流式进行中给调用链路按钮加动效点。
 */
export function renderExtras(
  ctx: ChatRenderCtx,
  m: ChatMsg,
  isStreaming: boolean
): TemplateResult {
  const hasTrace = !!(m.trace && m.trace.length > 0);
  const insights = hasTrace ? buildInsights(m.trace!) : null;
  // 链路信心：仅当存在真实工具/检索执行（否则信心恒为满分的空值，无意义）。
  const hasConfidence = !!(insights && insights.toolCount > 0);
  if (!hasTrace && !insights) return html``;
  const traceIcon = html`<svg
    class="ticon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="6" r="2.4" />
    <circle cx="12" cy="18" r="2.4" />
    <path d="M7.6 7.6 11 16M16.4 7.6 13 16M8 6h8" />
  </svg>`;
  return html`
    <div class="extras">
      ${hasTrace
        ? html`<button
            type="button"
            class="extra-btn ${ctx.traceDrawerMsg === m &&
            ctx.traceDrawerSection === 'trace'
              ? 'active'
              : ''}"
            @click=${() => ctx.setTraceDrawer(m, 'trace')}
          >
            ${traceIcon}<span>调用链路</span
            ><span class="tcount">${countTraceNodes(m.trace!)} 节点</span>
            ${isStreaming
              ? html`<span class="dots"><i></i><i></i><i></i></span>`
              : nothing}
          </button>`
        : nothing}
      ${insights
        ? html`<button
            type="button"
            class="extra-btn alt ${ctx.traceDrawerMsg === m &&
            ctx.traceDrawerSection === 'insights'
              ? 'active'
              : ''}"
            @click=${() => ctx.setTraceDrawer(m, 'insights')}
          >
            <span>关键信息</span>
          </button>`
        : nothing}
      ${hasConfidence
        ? html`<button
            type="button"
            class="extra-btn alt ${ctx.traceDrawerMsg === m &&
            ctx.traceDrawerSection === 'confidence'
              ? 'active'
              : ''}"
            @click=${() => ctx.setTraceDrawer(m, 'confidence')}
          >
            <span>链路信心</span>
          </button>`
        : nothing}
    </div>
  `;
}

/** 调用链路 / 关键信息 抽屉：展示当前选中消息的追踪树与洞察摘要。
 *  始终渲染 <ah-drawer>（open 绑定到是否有选中消息），关闭时由组件自放离场动画，
 *  父级仅在 close 事件后才清空 traceDrawerMsg，保证滑出动画完整可见。 */
export function renderTraceDrawer(ctx: ChatRenderCtx): TemplateResult {
  const m = ctx.traceDrawerMsg;
  const title =
    ctx.traceDrawerSection === 'trace'
      ? '调用链路'
      : ctx.traceDrawerSection === 'confidence'
        ? '链路信心'
        : '关键信息';
  return html`
    <ah-drawer
      ?open=${m !== null}
      placement="right"
      title=${title}
      size="500px"
      @close=${() => ctx.setTraceDrawer(null, ctx.traceDrawerSection)}
    >
      ${m && m.trace && m.trace.length > 0
        ? html`<div class="trace-drawer">
            ${ctx.traceDrawerSection === 'trace'
              ? html`<div class="trace-body">
                  ${m.trace.map((n) =>
                    renderTraceNode(n, undefined, () => ctx.requestUpdate())
                  )}
                </div>`
              : ctx.traceDrawerSection === 'confidence'
                ? html`<div class="confidence-wrap">
                    ${renderConfidence(m.trace)}
                  </div>`
                : html`<div class="insights">
                    ${renderInsights(buildInsights(m.trace))}
                  </div>`}
          </div>`
        : nothing}
    </ah-drawer>
  `;
}

/**
 * 渲染计划卡片（P0 计划模式）：任务拆解 / 步骤 / 依赖 / 预期产出 + 状态标记。
 * pending 态显示「确认执行 / 取消」；running 显示当前任务；done/cancelled 只读。
 */
export function renderPlanCard(ctx: ChatRenderCtx, m: ChatMsg): TemplateResult {
  const plan = m.plan;
  if (!plan) return html``;
  const st: PlanExecState =
    ctx.planExec[m.id] ?? { status: 'pending' as const, done: {} };
  const statusLabel =
    st.status === 'pending'
      ? '待确认'
      : st.status === 'running'
      ? `执行中 · ${st.currentTaskId ?? ''}`
      : st.status === 'done'
      ? '已完成'
      : st.status === 'failed'
      ? `执行失败 · ${st.failedTaskId ?? ''}`
      : '已取消';
  return html`<div class="plan-card">
    <div class="plan-head">
      <span class="plan-title">📋 执行计划</span>
      <span class="plan-goal">${escapeHtml(plan.goal)}</span>
    </div>
    <ol class="plan-tasks">
      ${plan.tasks.map((t, i) => {
        const done = !!st.done[t.id];
        const active = st.status === 'running' && st.currentTaskId === t.id;
        const failed = st.status === 'failed' && st.failedTaskId === t.id;
        return html`<li
          class="plan-task ${done ? 'done' : ''} ${active ? 'active' : ''} ${
          failed ? 'failed' : ''
        }"
        >
          <div class="pt-head">
            <span class="pt-mark"
              >${done ? '✓' : active ? '⏳' : failed ? '✗' : i + 1}</span
            >
            <b>${escapeHtml(t.title)}</b>
          </div>
          ${t.steps.length
            ? html`<ol class="pt-steps">
                ${t.steps.map((s) => html`<li>${escapeHtml(s)}</li>`)}
              </ol>`
            : nothing}
          <div class="pt-meta">
            依赖：${t.dependsOn.length ? t.dependsOn.join('、') : '无'} ·
            预期产出：${escapeHtml(t.expectedOutput || '—')}
          </div>
        </li>`;
      })}
    </ol>
    ${
      /* 状态 + 操作：置于卡片右下角一行，状态在操作按钮之前。 */
      html`<div class="plan-actions">
        <span class="pill ${st.status}">${statusLabel}</span>
        <div class="plan-action-btns">
          ${st.status === 'pending'
            ? html`<button class="plan-btn" @click=${() => ctx.confirmPlan(m)}>
                  确认执行
                </button>
                <button
                  class="plan-btn ghost"
                  @click=${() => ctx.cancelPlan(m.id)}
                >
                  取消
                </button>`
            : nothing}
          ${st.status === 'failed'
            ? html`<button class="plan-btn" @click=${() => ctx.confirmPlan(m)}>
                从失败任务继续
              </button>`
            : nothing}
        </div>
      </div>`
    }
  </div>`;
}
