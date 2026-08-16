import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { ref, createRef } from 'lit/directives/ref.js';
import { client } from './api';
import { sharedStyles } from './styles';
import { toRichHtml, escapeHtml } from './markdown';
import type { ChatSession, RunMode, StreamEvent, TraceNode, TraceKind } from '@agent-harness/client';

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
  /** 调用链路追踪树：把本回合的 LLM↔工具↔检索 调用过程结构化记录，供深度思考界面可视化。 */
  trace?: TraceNode[];
  /** 错误态：以警示样式渲染。 */
  error?: boolean;
}

/** 检索/搜索类工具名特征：命中则归类为 retrieval 节点，结果以「检索内容」突出展示。 */
const RETRIEVAL_RE = /retriev|search|fetch|query|lookup|wiki|web|rag|google|bing|knowledge|document|semantic/i;
function isRetrievalTool(name: string): boolean {
  return RETRIEVAL_RE.test(name);
}

/** 从调用链路提炼出的「关键信息」结构化摘要，用于深度思考区的复盘视图。 */
interface Insights {
  model?: string;
  agent?: string;
  mode?: string;
  steps: number;
  toolCount: number;
  costTokens?: string;
  costValue?: string;
  retrievals: Array<{ label: string; result: string }>;
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
      /* ----------------------- 调用链路 (trace) ----------------------- */
      .trace {
        margin-bottom: 10px;
        border: 1px solid var(--ah-border);
        border-left: 3px solid var(--ah-accent, #2997ff);
        border-radius: 10px;
        background: color-mix(in srgb, var(--ah-accent, #2997ff) 5%, var(--ah-surface-2));
        overflow: hidden;
      }
      .trace > summary {
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
      .trace > summary::-webkit-details-marker {
        display: none;
      }
      .trace .ticon {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        opacity: 0.95;
      }
      .trace .tcount {
        font-weight: 400;
        font-size: 11px;
        color: var(--ah-text-muted);
        background: var(--ah-surface-3, var(--ah-surface-2));
        border-radius: 999px;
        padding: 1px 8px;
      }
      .trace-body {
        padding: 2px 12px 10px 14px;
      }
      /* 树状节点：左侧连接线 + 圆点 */
      .tnode {
        border-left: 1px dashed var(--ah-border);
        margin-left: 6px;
        padding-left: 12px;
      }
      .tnode:last-child {
        border-left-color: transparent;
      }
      .tnode > summary.tnode-head {
        cursor: pointer;
        list-style: none;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 5px 0;
        font-size: 12px;
      }
      .tnode > summary.tnode-head::-webkit-details-marker {
        display: none;
      }
      .tdot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: 0 0 auto;
        background: var(--ah-text-muted);
      }
      .tlabel {
        color: var(--ah-text);
        font-weight: 500;
      }
      .tbadge {
        font-size: 10px;
        padding: 0 6px;
        border-radius: 999px;
        line-height: 16px;
        flex: 0 0 auto;
      }
      .tbadge.err {
        background: color-mix(in srgb, var(--ah-danger, #e24b4a) 16%, transparent);
        color: var(--ah-danger, #e24b4a);
      }
      .tbadge.pend {
        background: color-mix(in srgb, var(--ah-accent, #2997ff) 16%, transparent);
        color: var(--ah-accent, #2997ff);
      }
      .tchips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-left: 2px;
      }
      .tchip {
        font-size: 10px;
        color: var(--ah-text-muted);
        background: var(--ah-surface-3, var(--ah-surface-2));
        border: 1px solid var(--ah-border);
        border-radius: 6px;
        padding: 0 6px;
        line-height: 16px;
        white-space: nowrap;
      }
      .tchip b {
        color: var(--ah-text);
        font-weight: 600;
        margin-right: 3px;
      }
      .tdetail {
        margin: 2px 0 4px 15px;
        padding: 8px 10px;
        font-size: 11px;
        line-height: 1.5;
        overflow: auto;
        max-height: 180px;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--ah-text-muted);
        font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
        background: var(--ah-canvas);
        border: 1px solid var(--ah-border);
        border-radius: 7px;
      }
      .tresult {
        margin: 2px 0 6px 15px;
        padding: 8px 10px;
        font-size: 11.5px;
        line-height: 1.55;
        color: var(--ah-text);
        white-space: pre-wrap;
        word-break: break-word;
        background: var(--ah-surface-3, var(--ah-surface-2));
        border: 1px solid var(--ah-border);
        border-radius: 7px;
      }
      .tresult.retrieval {
        border-left: 3px solid var(--ah-success, #34c759);
        background: color-mix(in srgb, var(--ah-success, #34c759) 8%, var(--ah-surface-2));
      }
      .tres-title {
        font-size: 10.5px;
        font-weight: 600;
        color: var(--ah-success, #34c759);
        margin-bottom: 4px;
        letter-spacing: 0.03em;
      }
      .tchildren {
        margin-top: 2px;
      }
      /* 节点类型着色（圆点 + 标签前缀色） */
      .tnode.kind-step > summary .tdot { background: var(--ah-accent, #2997ff); }
      .tnode.kind-llm > summary .tdot { background: #9b6dff; }
      .tnode.kind-tool > summary .tdot { background: var(--ah-text-muted); }
      .tnode.kind-retrieval > summary .tdot { background: var(--ah-success, #34c759); }
      .tnode.kind-cost > summary .tdot { background: #f0a020; }
      .tnode.kind-verify > summary .tdot { background: var(--ah-success, #34c759); }
      .tnode.kind-guardrail > summary .tdot,
      .tnode.kind-budget > summary .tdot,
      .tnode.kind-error > summary .tdot { background: var(--ah-danger, #e24b4a); }
      .tnode.status-error > summary .tlabel { color: var(--ah-danger, #e24b4a); }

      /* ----------------------- 关键信息 (insights) ----------------------- */
      .insights {
        margin-bottom: 10px;
        border: 1px solid var(--ah-border);
        border-radius: 10px;
        background: var(--ah-surface-2);
        padding: 10px 12px 12px;
      }
      .insights-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--ah-text);
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .insights-title::before {
        content: '';
        width: 3px;
        height: 12px;
        border-radius: 2px;
        background: var(--ah-accent, #2997ff);
      }
      .ins-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
        gap: 8px;
      }
      .ins-item {
        background: var(--ah-surface-3, var(--ah-surface-1));
        border: 1px solid var(--ah-border);
        border-radius: 8px;
        padding: 6px 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .ins-k {
        font-size: 10px;
        color: var(--ah-text-muted);
      }
      .ins-v {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--ah-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ins-retrieval {
        margin-top: 10px;
        border-top: 1px dashed var(--ah-border);
        padding-top: 10px;
      }
      .ins-ret-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--ah-success, #34c759);
        margin-bottom: 6px;
      }
      .ins-ret-card {
        border: 1px solid var(--ah-border);
        border-left: 3px solid var(--ah-success, #34c759);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ah-success, #34c759) 6%, var(--ah-surface-1));
        padding: 8px 10px;
        margin-bottom: 8px;
      }
      .ins-ret-name {
        font-size: 11px;
        font-weight: 600;
        color: var(--ah-text);
        margin-bottom: 4px;
      }
      .ins-ret-body {
        margin: 0;
        font-size: 11px;
        line-height: 1.5;
        max-height: 160px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--ah-text-muted);
        font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      }
      /* ----------------------- 合并视图：深度思考 + 最终回答 ----------------------- */
      /* 思考区：合并视图顶部，实时流式呈现模型推理（随 token 增量逐字揭示）。 */
      .think {
        margin-bottom: 10px;
        border: 1px solid var(--ah-border);
        border-left: 3px solid var(--ah-accent, #2997ff);
        border-radius: 10px;
        background: color-mix(in srgb, var(--ah-accent, #2997ff) 5%, var(--ah-surface-2));
        overflow: hidden;
        animation: think-in 0.28s ease;
      }
      @keyframes think-in {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: none; }
      }
      .think-head {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 7px 10px 7px 12px;
        font-size: 12px;
        font-weight: 600;
        color: var(--ah-accent, #2997ff);
        cursor: pointer;
        user-select: none;
      }
      .think-ico {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        opacity: 0.95;
      }
      .think-title {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .think-status {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-weight: 500;
        font-style: normal;
        color: var(--ah-accent, #2997ff);
        flex: 0 0 auto;
      }
      .think-count {
        font-size: 11px;
        font-weight: 500;
        color: var(--ah-text-muted);
        flex: 0 0 auto;
      }
      .think-chev {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        color: var(--ah-text-muted);
        transition: transform 0.18s ease;
      }
      .think.collapsed .think-chev {
        transform: rotate(-90deg);
      }
      /* 高度封顶 + 内部滚动：超长推理不再撑高整条消息，降低视觉占用。 */
      .think-body {
        padding: 2px 12px 8px 34px;
        color: var(--ah-text-muted);
        font-size: 12.5px;
        line-height: 1.65;
        max-height: 180px;
        overflow-y: auto;
        overflow-x: hidden;
        overflow-wrap: anywhere;
        position: relative;
        scrollbar-width: thin;
        scrollbar-color: var(--ah-border) transparent;
      }
      .think.collapsed .think-body {
        display: none;
      }
      .think-body::-webkit-scrollbar {
        width: 4px;
      }
      .think-body::-webkit-scrollbar-thumb {
        background: var(--ah-border);
        border-radius: 2px;
      }
      .think-text {
        white-space: normal;
      }
      .think-text.muted {
        opacity: 0.85;
      }
      /* 关键变量卡（深度思考内高亮） */
      .dvars {
        margin-bottom: 10px;
        border: 1px dashed var(--ah-border);
        border-radius: 8px;
        padding: 8px 10px;
        background: var(--ah-canvas);
      }
      .dvars-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--ah-success, #34c759);
        margin-bottom: 6px;
      }
      .dvars-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 6px;
      }
      .dvar {
        background: var(--ah-surface-3, var(--ah-surface-1));
        border: 1px solid var(--ah-border);
        border-radius: 7px;
        padding: 5px 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .dvar-k {
        font-size: 10px;
        color: var(--ah-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dvar-v {
        font-size: 12px;
        font-weight: 600;
        color: var(--ah-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* 思考区与回答区之间的清晰分隔 */
      .sep {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 4px 0 10px;
        color: var(--ah-text-muted);
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.04em;
      }
      .sep::before,
      .sep::after {
        content: '';
        flex: 1 1 auto;
        height: 1px;
        background: var(--ah-border);
      }
      /* 回答区：合并视图底部，承载最终回答（流式逐字）。 */
      .answer {
        font-size: 14px;
        line-height: 1.65;
      }
      /* “模型正在回复…” 文字动效：循环脉冲 + 跳动圆点，提示模型仍在处理。 */
      .replying {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        font-size: 12.5px;
        font-style: italic;
        color: var(--ah-text-muted);
        animation: replying-pulse 1.5s ease-in-out infinite;
      }
      @keyframes replying-pulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
      /* 通用跳动圆点（思考中 / 模型正在回复 共用 blinkdot 动效） */
      .dots {
        display: inline-flex;
        gap: 3px;
        vertical-align: middle;
      }
      .dots i {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
        animation: blinkdot 1.2s infinite ease-in-out;
      }
      .dots i:nth-child(2) {
        animation-delay: 0.2s;
      }
      .dots i:nth-child(3) {
        animation-delay: 0.4s;
      }
      /* 折叠式附加信息（调用链路 / 关键信息）：默认收起，不干扰主阅读流。 */
      .extras {
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .extra {
        border: 1px solid var(--ah-border);
        border-radius: 10px;
        background: var(--ah-surface-2);
        overflow: hidden;
      }
      .extra > summary {
        cursor: pointer;
        list-style: none;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 600;
        color: var(--ah-text);
        display: flex;
        align-items: center;
        gap: 8px;
        user-select: none;
      }
      .extra > summary::-webkit-details-marker {
        display: none;
      }
      .extra[open] > summary {
        border-bottom: 1px solid var(--ah-border);
      }
      .extra .ticon {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        opacity: 0.95;
      }
      .extra .tcount {
        font-weight: 400;
        font-size: 11px;
        color: var(--ah-text-muted);
        background: var(--ah-surface-3, var(--ah-surface-2));
        border-radius: 999px;
        padding: 1px 8px;
      }
      .extra .trace-body {
        padding: 10px 12px;
      }
      .extra .insights {
        border: none;
        border-radius: 0;
        background: transparent;
        margin: 0;
        padding: 10px 12px 12px;
      }

      /* 移动端汉堡按钮与抽屉遮罩（默认隐藏，窄屏媒体查询启用）。 */
      .menu-btn {
        display: none;
        flex: 0 0 auto;
        width: 34px;
        height: 34px;
        align-items: center;
        justify-content: center;
        font-size: 17px;
        line-height: 1;
        border-radius: 9px;
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        color: var(--ah-text);
        cursor: pointer;
        padding: 0;
      }
      .menu-btn:hover {
        border-color: var(--ah-accent, #2997ff);
      }
      .scrim {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 40;
        opacity: 0;
        transition: opacity 200ms ease;
      }
      .scrim.show {
        opacity: 1;
        display: block;
      }

      /* ===================== 响应式适配 ===================== */
      /* 平板 / 手机（≤900px）：侧栏离屏为抽屉，汉堡按钮唤出，主区占满。 */
      @media (max-width: 900px) {
        :host {
          height: 100dvh;
          overflow: hidden;
        }
        .sidebar {
          position: fixed;
          top: 0;
          left: 0;
          height: 100%;
          width: 264px;
          max-width: 84vw;
          transform: translateX(-100%);
          transition: transform 220ms ease;
          z-index: 50;
          box-shadow: 2px 0 18px rgba(0, 0, 0, 0.45);
        }
        .sidebar.open {
          transform: none;
        }
        .menu-btn {
          display: inline-flex;
        }
        .scrim.show {
          display: block;
        }
        .chat-head {
          padding: 10px 12px;
          gap: 8px;
        }
        .model-input {
          width: 120px;
        }
        .thread {
          max-width: 100%;
        }
        .composer,
        .hint {
          max-width: 100%;
        }
      }
      /* 手机（≤600px）：进一步收紧内边距 / 字号，确保完整显示与流畅操作。 */
      @media (max-width: 600px) {
        .scroll {
          padding: 12px 0;
        }
        .thread {
          padding: 0 12px;
          gap: 14px;
        }
        .bubble {
          padding: 10px 12px;
        }
        .avatar {
          flex: 0 0 26px;
          width: 26px;
          height: 26px;
          font-size: 12px;
        }
        .msg {
          gap: 9px;
        }
        .chat-head {
          padding: 8px 10px;
          gap: 6px;
        }
        .title {
          font-size: 13px;
        }
        .model-input {
          width: 88px;
          font-size: 11px;
          padding: 4px 8px;
        }
        .toggle {
          padding: 5px 9px;
          font-size: 11.5px;
          gap: 5px;
        }
        .toggle svg {
          width: 12px;
          height: 12px;
        }
        /* 联网搜索为 UI 占位，窄屏隐藏以节省头部空间 */
        .toggle.web {
          display: none;
        }
        .composer-wrap {
          padding: 10px 10px calc(12px + env(safe-area-inset-bottom));
        }
        .composer {
          padding: 6px 6px 6px 12px;
          gap: 8px;
          border-radius: 14px;
        }
        .composer textarea {
          font-size: 14px;
        }
        .send {
          width: 34px;
          height: 34px;
          font-size: 15px;
        }
        .hint {
          font-size: 10.5px;
          margin-top: 6px;
        }
        .empty h1 {
          font-size: 22px;
        }
        .empty p {
          font-size: 13px;
        }
        .think-body {
          font-size: 12px;
          line-height: 1.55;
        }
        .sep {
          font-size: 11px;
          margin: 4px 0 8px;
        }
      }
      /* 中屏（901–1100px）：侧栏收窄但常驻，兼顾 iPad 横屏与窄笔记本。 */
      @media (min-width: 901px) and (max-width: 1100px) {
        .sidebar {
          width: 220px;
          flex-basis: 220px;
        }
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
  @state() deepThink = true;
  @state() web = false;
  /** 每条助手消息的深度思考折叠态（key 为 message id），用于手动收起思考区。 */
  @state() thinkCollapsed: Record<string, boolean> = {};
  /** 移动端侧栏抽屉开合态（≤900px 生效）。 */
  @state() sidebarOpen = false;
  @state() error: string | null = null;
  private nextId = 1;
  private abort?: AbortController;
  private activeIdx = -1;
  private jobId: string | null = null;
  private scrollRef = createRef<HTMLElement>();

  /** 重置调用链路追踪的瞬态构建状态（防御上轮残留泄漏到本轮）。 */
  private resetTrace() {
    this.traceRoot = null;
    this.traceParent = null;
    this.traceLlm = null;
    this.traceLastTool = null;
    this.traceSeq = 0;
  }
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
  /** 调用链路追踪树的瞬态构建状态（每轮 run 重置；构建结果写入当前 assistant 消息的 trace 字段）。 */
  private traceRoot: TraceNode | null = null;
  private traceParent: TraceNode | null = null;
  private traceLlm: TraceNode | null = null;
  private traceLastTool: TraceNode | null = null;
  private traceSeq = 0;

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
    this.resetTrace();
  }

  private async selectSession(id: string) {
    if (id === this.activeId) return;
    this.abort?.abort();
    this.activeId = id;
    this.sidebarOpen = false;
    this.error = null;
    this.input = '';
    // 切换会话时停掉打字机并清空缓冲，避免上一个会话的残留文本泄漏到新会话。
    this.stopTypewriter();
    this.pendingContent = '';
    this.pendingReasoning = '';
    this.resetTrace();
    // 优先用本地内存中的消息；否则向服务端拉取历史。
    try {
      const s = await client.getChatSession(id);
      this.messages = s.messages.map((m) => ({
        id: this.nextId++,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        // 还原落盘时一并写入的推理、工具调用与调用链路追踪，避免切换会话后再切回丢失深度思考/复盘数据。
        reasoning: m.reasoning,
        tools: m.tools
          ? m.tools.map((t) => ({ name: t.name, args: t.args ?? '', result: t.result, errored: t.errored }))
          : undefined,
        trace: m.trace ? m.trace : undefined,
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
    this.resetTrace();
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
    // 把事件汇入调用链路追踪树（独立于内容/工具卡，结构化记录 LLM↔工具↔检索 过程）。
    this.traceHandle(ev);
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

  /* ----------------------- 调用链路追踪构建 ----------------------- */

  /** 确保追踪树根节点（run）存在并返回。 */
  private ensureTraceRoot(): TraceNode {
    if (!this.traceRoot) {
      this.traceRoot = { id: 't0', kind: 'run', label: '运行', status: 'ok', children: [] };
      this.traceParent = this.traceRoot;
    }
    return this.traceRoot;
  }

  /**
   * 把一条流式事件汇入调用链路追踪树（瞬态构建，结果写入当前 assistant 消息的 trace 字段）。
   * 树形：run → step → llm → tool/retrieval/cost，外加 root 级的 verify/guardrail/budget/error。
   * 外部调用（工具/检索）因此被整合进对话上下文，可结构化复盘。
   */
  private traceHandle(ev: any) {
    const mk = (
      parent: TraceNode,
      kind: TraceKind,
      label: string,
      status: TraceNode['status'] = 'ok',
      extra: Partial<TraceNode> = {}
    ): TraceNode => {
      const n: TraceNode = { id: `t${++this.traceSeq}`, kind, label, status, children: [], ...extra };
      parent.children.push(n);
      return n;
    };
    switch (ev?.type) {
      case 'run:meta': {
        const r = this.ensureTraceRoot();
        r.meta = {
          ...(r.meta ?? {}),
          ...(ev.model ? { model: String(ev.model) } : {}),
          ...(ev.agentId ? { agent: String(ev.agentId) } : {}),
          ...(ev.mode ? { mode: String(ev.mode) } : {}),
        };
        r.label = ev.model ? `运行 · ${ev.model}` : '运行';
        break;
      }
      case 'step:start': {
        const r = this.ensureTraceRoot();
        this.traceParent = r;
        const step = mk(r, 'step', `第 ${ev.step} 步`, 'ok', {
          meta: { step: `第 ${ev.step} 步 / 共 ${ev.maxSteps ?? '?'} 步` },
        });
        this.traceParent = step;
        this.traceLlm = null;
        this.traceLastTool = null;
        break;
      }
      case 'llm:call': {
        this.ensureTraceRoot();
        const parent = this.traceParent ?? this.traceRoot!;
        this.traceLlm = mk(parent, 'llm', 'LLM 调用', 'ok', {
          meta: {
            messages: `消息 ${ev.messageCount ?? '?'}`,
            tools: `工具 ${ev.toolCount ?? '?'}`,
          },
        });
        this.traceLastTool = null;
        break;
      }
      case 'llm:reasoning': {
        if (this.traceLlm && typeof ev.delta === 'string') {
          const n = (this.traceLlm.meta?.reasoningChars ? Number(this.traceLlm.meta.reasoningChars) : 0) + ev.delta.length;
          this.traceLlm.meta = { ...(this.traceLlm.meta ?? {}), reasoningChars: String(n) };
        }
        break;
      }
      case 'llm:token': {
        if (this.traceLlm && typeof ev.delta === 'string') {
          const n = (this.traceLlm.meta?.tokenChars ? Number(this.traceLlm.meta.tokenChars) : 0) + ev.delta.length;
          this.traceLlm.meta = { ...(this.traceLlm.meta ?? {}), tokenChars: String(n) };
        }
        break;
      }
      case 'tool:start': {
        if (!this.traceLlm || !ev.call) break;
        const name = String(ev.call.name ?? 'tool');
        const retrieval = isRetrievalTool(name);
        this.traceLastTool = mk(this.traceLlm, retrieval ? 'retrieval' : 'tool', retrieval ? `检索 · ${name}` : name, 'pending', {
          detail: typeof ev.call.arguments === 'string' ? ev.call.arguments : JSON.stringify(ev.call.arguments ?? {}),
        });
        break;
      }
      case 'tool:result': {
        if (this.traceLastTool) {
          this.traceLastTool.result = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? {});
          this.traceLastTool.status = ev.errored ? 'error' : 'ok';
          this.traceLastTool.meta = { ...(this.traceLastTool.meta ?? {}), status: ev.errored ? '失败' : '成功' };
        }
        break;
      }
      case 'run:cost': {
        this.ensureTraceRoot();
        const parent = this.traceParent ?? this.traceRoot!;
        mk(parent, 'cost', '成本 / 用量', 'ok', {
          meta: {
            tokens: String(ev.cumulativeTokens ?? ev.usage?.total_tokens ?? '?'),
            cost: ev.cumulativeCost != null ? `$${Number(ev.cumulativeCost).toFixed(4)}` : '?',
            ...(ev.model ? { model: String(ev.model) } : {}),
          },
        });
        break;
      }
      case 'verify:result': {
        this.ensureTraceRoot();
        mk(this.traceRoot!, 'verify', '自检', ev.passed ? 'ok' : 'error', {
          meta: { score: String(ev.score ?? '?'), passed: ev.passed ? '通过' : '未通过' },
          result: (ev.reasons ?? []).join('\n'),
        });
        break;
      }
      case 'guardrail:blocked': {
        this.ensureTraceRoot();
        mk(this.traceRoot!, 'guardrail', `护栏拦截 · ${ev.phase ?? ''}`, 'error', { detail: String(ev.reason ?? '') });
        break;
      }
      case 'budget:exceeded': {
        this.ensureTraceRoot();
        mk(this.traceRoot!, 'budget', `预算超限 · ${ev.kind ?? ''}`, 'error', {
          meta: { used: String(ev.used ?? '?'), limit: String(ev.limit ?? '?') },
        });
        break;
      }
      case 'error': {
        this.ensureTraceRoot();
        mk(this.traceRoot!, 'error', '运行错误', 'error', { detail: String(ev.message ?? '') });
        break;
      }
      default:
        break;
    }
    // 结构型事件才回写消息（token/reasoning 高频且仅更新 meta，避免无谓重渲染）。
    if (
      this.traceRoot &&
      this.activeIdx >= 0 &&
      ev.type !== 'llm:token' &&
      ev.type !== 'llm:reasoning'
    ) {
      this.patchActive({ trace: [this.traceRoot] });
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

  /** 折叠 / 展开某条消息的深度思考区（思考中不可折叠，保证实时推理可见）。 */
  private toggleThink(id: number) {
    const k = String(id);
    const c = this.messages.find((m) => m.id === id);
    const isThinking =
      this.running && this.activeIdx >= 0 && this.messages[this.activeIdx]?.id === id && !c?.content;
    if (isThinking) return;
    this.thinkCollapsed = { ...this.thinkCollapsed, [k]: !this.thinkCollapsed[k] };
  }

  /** 切换移动端侧栏抽屉（≤900px 生效）。 */
  private toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
  }

  private renderMessage(m: ChatMsg) {
    // 用户消息：仅渲染气泡文本。
    if (m.role === 'user') {
      return html`
        <div class="msg user">
          <div class="avatar">你</div>
          <div class="bubble">
            <div class="msg-text">${unsafeHTML(toRichHtml(m.content))}</div>
          </div>
        </div>
      `;
    }

    // 助手消息：合并视图 —— 深度思考（实时流式）在上，最终回答（分隔后）在下；
    // 模型仍在处理时于对应区域显示「思考中 / 模型正在回复…」文字动效。
    const isStreamingAssistant =
      this.running &&
      this.activeIdx >= 0 &&
      this.messages[this.activeIdx]?.id === m.id &&
      m.role === 'assistant';
    // 是否展示思考区：仅当模型确实返回了推理内容（流式首 token 到达即出现）。
    const showThinking = !!m.reasoning;
    // 阶段判定：尚未开始生成回答 → 处于「思考中」；否则「回答中」。
    const isThinking = isStreamingAssistant && !m.content;
    const isAnswering = isStreamingAssistant && !!m.content;

    return html`
      <div class="msg assistant ${m.error ? 'error' : ''}">
        <div class="avatar">A</div>
        <div class="bubble">
          ${showThinking && this.deepThink ? this.renderThinking(m, isThinking) : nothing}
          ${showThinking && this.deepThink && (m.content || isStreamingAssistant)
            ? html`<div class="sep"><span>回答</span></div>`
            : nothing}
          ${this.renderAnswer(m, isAnswering, isStreamingAssistant)}
          ${this.renderExtras(m, isStreamingAssistant)}
        </div>
      </div>
    `;
  }

  /**
   * 渲染「深度思考」区（合并视图·顶部）：
   * 展示模型实际返回的推理内容（m.reasoning），随 llm:reasoning 增量经打字机逐字显现。
   * 流式推理进行中时，标题显示「思考中…」动效、正文末尾显示闪烁光标。
   */
  private renderThinking(m: ChatMsg, isThinking: boolean): TemplateResult {
    const parsed = m.reasoning && m.reasoning.trim() ? parseDeepThinking(m.reasoning) : null;
    const collapsed = !!this.thinkCollapsed[String(m.id)];
    return html`
      <div class="think ${isThinking ? 'live' : ''} ${collapsed ? 'collapsed' : ''}">
        <div class="think-head" @click=${() => this.toggleThink(m.id)} title="点击折叠 / 展开">
          <svg class="think-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18h6M10 21h4" />
            <path d="M12 3a6 6 0 0 0-3.8 10.7c.6.5.8 1.2.8 2.3h6c0-1.1.2-1.8.8-2.3A6 6 0 0 0 12 3z" />
          </svg>
          <span class="think-title">深度思考</span>
          ${isThinking
            ? html`<span class="think-status">思考中<span class="dots"><i></i><i></i><i></i></span></span>`
            : nothing}
          ${collapsed && m.reasoning
            ? html`<span class="think-count">${m.reasoning.length} 字</span>`
            : nothing}
          <svg class="think-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </div>
        <div class="think-body">
          ${
            parsed
              ? html`
                ${parsed.vars.length
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
              : html`<div class="think-text muted">${isThinking ? '模型正在思考…' : '（模型未返回推理内容）'}</div>`
          }
          ${isThinking ? html`<span class="caret"></span>` : nothing}
        </div>
      </div>
    `;
  }

  /** 渲染最终回答区（合并视图·底部）：随 llm:token 增量逐字显现；流式进行中显示「模型正在回复…」动效。 */
  private renderAnswer(m: ChatMsg, isAnswering: boolean, isStreaming: boolean): TemplateResult {
    return html`
      <div class="answer">
        ${m.content
          ? html`<div class="msg-text">${unsafeHTML(toRichHtml(m.content))}</div>`
          : nothing}
        ${isAnswering ? html`<span class="caret"></span>` : nothing}
        ${isStreaming
          ? html`<div class="replying">模型正在回复<span class="dots"><i></i><i></i><i></i></span></div>`
          : nothing}
        ${!m.content && !isStreaming
          ? html`<div class="msg-text placeholder">等待响应…</div>`
          : nothing}
      </div>
    `;
  }

  /** 渲染折叠式附加信息（调用链路 / 关键信息），默认收起，不干扰主阅读流。 */
  private renderExtras(m: ChatMsg, isStreaming: boolean): TemplateResult {
    const hasTrace = !!(m.trace && m.trace.length > 0);
    const insights = hasTrace ? this.buildInsights(m.trace!) : null;
    if (!hasTrace && !insights) return html``;
    return html`
      <div class="extras">
        ${hasTrace
          ? html`<details class="extra">
              <summary>
                <svg class="ticon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" />
                  <path d="M7.6 7.6 11 16M16.4 7.6 13 16M8 6h8" />
                </svg>
                <span>调用链路</span>
                <span class="tcount">${this.countTraceNodes(m.trace!)} 节点</span>
                ${isStreaming ? html`<span class="dots"><i></i><i></i><i></i></span>` : nothing}
              </summary>
              <div class="trace-body">${m.trace!.map((n) => this.renderTraceNode(n))}</div>
            </details>`
          : nothing}
        ${insights
          ? html`<details class="extra">
              <summary><span>关键信息</span></summary>
              <div class="insights">${this.renderInsights(insights)}</div>
            </details>`
          : nothing}
      </div>
    `;
  }

  /** 统计追踪树节点总数（用于「调用链路」标题计数）。 */
  private countTraceNodes(trace: TraceNode[]): number {
    let n = 0;
    const walk = (ns: TraceNode[]) => ns.forEach((x) => {
      n++;
      walk(x.children);
    });
    walk(trace);
    return n;
  }

  /** 递归渲染单个追踪节点（details 天然形成树状层级，可逐层展开）。 */
  private renderTraceNode(n: TraceNode): TemplateResult {
    const hasDetail = !!n.detail && n.detail.trim().length > 0;
    const hasResult = n.result != null && n.result.trim().length > 0;
    const isRetrieval = n.kind === 'retrieval';
    // run/step/llm 默认展开，叶子节点（工具/检索/成本）默认收起。
    const defaultOpen = n.kind === 'run' || n.kind === 'step' || n.kind === 'llm';
    return html`
      <details class="tnode kind-${n.kind} status-${n.status}" ?open=${defaultOpen}>
        <summary class="tnode-head">
          <span class="tdot"></span>
          <span class="tlabel">${escapeHtml(n.label)}</span>
          ${n.status === 'error' ? html`<span class="tbadge err">失败</span>` : nothing}
          ${n.status === 'pending' ? html`<span class="tbadge pend">进行中</span>` : nothing}
          ${n.meta
            ? html`<span class="tchips">${Object.entries(n.meta).map(
                ([k, v]) => html`<span class="tchip"><b>${escapeHtml(k)}</b> ${escapeHtml(v)}</span>`
              )}</span>`
            : nothing}
        </summary>
        ${hasDetail ? html`<pre class="tdetail">${formatToolJson(n.detail!)}</pre>` : nothing}
        ${hasResult
          ? html`<div class="tresult ${isRetrieval ? 'retrieval' : ''}">
              ${isRetrieval ? html`<div class="tres-title">检索内容</div>` : nothing}${formatToolJson(n.result!)}
            </div>`
          : nothing}
        ${n.children.length
          ? html`<div class="tchildren">${n.children.map((c) => this.renderTraceNode(c))}</div>`
          : nothing}
      </details>
    `;
  }

  /** 遍历追踪树，提炼「关键信息」结构化摘要。 */
  private buildInsights(trace: TraceNode[]): Insights {
    const root = trace[0];
    const flat: TraceNode[] = [];
    const walk = (ns: TraceNode[]): void => {
      ns.forEach((x) => {
        flat.push(x);
        walk(x.children);
      });
    };
    walk(root.children);
    const steps = flat.filter((n) => n.kind === 'step').length;
    const tools = flat.filter((n) => n.kind === 'tool');
    const retrievals = flat.filter((n) => n.kind === 'retrieval');
    const cost = flat.find((n) => n.kind === 'cost');
    const meta = root.meta ?? {};
    return {
      model: meta.model,
      agent: meta.agent,
      mode: meta.mode,
      steps,
      toolCount: tools.length + retrievals.length,
      costTokens: cost?.meta?.tokens,
      costValue: cost?.meta?.cost,
      retrievals: retrievals.map((n) => ({ label: n.label, result: n.result ?? '' })),
    };
  }

  /** 渲染「关键信息」结构化洞察区（模型/步骤/工具/用量/检索内容）。 */
  private renderInsights(ins: Insights) {
    const stats: Array<[string, string]> = [];
    const push = (k: string, v: string | undefined) => {
      if (v != null) stats.push([k, v]);
    };
    push('模型', ins.model);
    push('Agent', ins.agent);
    push('模式', ins.mode);
    push('步骤', ins.steps ? String(ins.steps) : undefined);
    push('工具调用', ins.toolCount ? String(ins.toolCount) : undefined);
    push('Token', ins.costTokens);
    push('成本', ins.costValue);
    return html`
      <div class="insights-title">关键信息</div>
      <div class="ins-grid">
        ${stats.map(
          ([k, v]) => html`<div class="ins-item">
            <span class="ins-k">${escapeHtml(k)}</span><span class="ins-v">${escapeHtml(v)}</span>
          </div>`
        )}
      </div>
      ${ins.retrievals.length
        ? html`<div class="ins-retrieval">
            <div class="ins-ret-title">检索内容</div>
            ${ins.retrievals.map(
              (r) => html`<div class="ins-ret-card">
                <div class="ins-ret-name">${escapeHtml(r.label)}</div>
                <pre class="ins-ret-body">${formatToolJson(r.result)}</pre>
              </div>`
            )}
          </div>`
        : nothing}
    `;
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
          <button class="menu-btn" @click=${() => this.toggleSidebar()} title="菜单 / 会话列表">☰</button>
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
            title="显示 / 隐藏深度思考区"
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
          <!-- <div class="hint">
            模式：${this.mode} ·
            token 级流式已开启（打字机效果）· 深度思考/联网为 UI 占位
          </div> -->
        </div>
      </div>

      <div class="scrim ${this.sidebarOpen ? 'show' : ''}" @click=${() => (this.sidebarOpen = false)}></div>
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
/**
 * 深度思考解析：从模型实际返回的推理文本中提取「有价值内容」并解析为结构化呈现。
 * - 按行切分，剔除空行噪声；
 * - 识别「关键变量」（`key: value` / `key=value`，且非编号步骤），单独抽取供高亮；
 * - 其余推理文本保留原结构（编号 / 项目符号 / 段落），以 Markdown 输出，最终由打字机读逐字揭示。
 */
function parseDeepThinking(raw: string): { text: string; vars: Array<[string, string]> } {
  if (!raw || !raw.trim()) return { text: '', vars: [] };
  const lines = raw.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const vars: Array<[string, string]> = [];
  const out: string[] = [];
  const varRe = /^(.{1,40})[:：=]\s*(.+)$/;
  const stepRe = /^\d+[\.、\)]/;
  for (const line of lines) {
    if (!line) continue;
    const vm = line.match(varRe);
    // 仅当不是「编号步骤」且形如 key-value 时，才判定为关键变量，避免误吞步骤描述。
    if (vm && !stepRe.test(line)) {
      vars.push([vm[1].trim(), vm[2].trim()]);
      continue;
    }
    out.push(line);
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, vars };
}

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
