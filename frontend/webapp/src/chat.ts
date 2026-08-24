import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { ref, createRef } from 'lit/directives/ref.js';
import { client, setToken } from './api';
import { sharedStyles } from './styles';
import { toRichHtml, escapeHtml } from './markdown';
import type {
  ChatSession,
  RunMode,
  StreamEvent,
  TraceNode,
  TraceKind
} from '@agent-harness/client';
import {
  agentContext,
  useAgentContext,
  type UploadedFile
} from './agent-context';
import './file-upload';

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
  /** 本次消息携带的附件（图片/文件预览）。 */
  attachments?: UploadedFile[];
}

/** 检索/搜索类工具名特征：命中则归类为 retrieval 节点，结果以「检索内容」突出展示。 */
const RETRIEVAL_RE =
  /retriev|search|fetch|query|lookup|wiki|web|rag|google|bing|knowledge|document|semantic/i;
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
  /** 'true'=命中定价表（cost 为 0 表示模型免费），'false'=未命中（按默认价 0 估算）。 */
  costPriced?: string;
  cacheHitRate?: string;
  cacheHits?: string;
  /** Token 拆解（系统 / 工具 / 历史 / 输出）占比，用于「关键信息」区可视化固定开销来源。 */
  costBreakdown?: Array<{ label: string; tokens: number; pct: number }>;
  retrievals: Array<{ label: string; result: string }>;
}

interface SessionView {
  id: string;
  title: string;
  updatedAt: number;
}

/** 调用链路追踪树的瞬态构建上下文（每会话独立，支持多个会话并发流式互不干扰）。 */
interface TraceCtx {
  root: TraceNode | null;
  parent: TraceNode | null;
  llm: TraceNode | null;
  lastTool: TraceNode | null;
  seq: number;
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
      // .side-head {
      //   padding: 14px 14px 10px;
      // }
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
      }
      .session:last-child {
        margin-bottom: 0;
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
      .session.active .dot {
        background: var(--ah-success);
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
        position: relative;
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
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 50%;
        border: 1px solid var(--ah-border);
        background: var(--ah-surface-2);
        color: var(--ah-text-muted);
        cursor: pointer;
        user-select: none;
        transition: color 0.15s ease, border-color 0.15s ease,
          background 0.15s ease, box-shadow 0.15s ease;
      }
      .toggle:hover {
        border-color: var(--ah-accent, #2997ff);
        color: var(--ah-text);
        background: var(--ah-surface-3);
      }
      .toggle svg {
        width: 15px;
        height: 15px;
        flex: 0 0 auto;
      }
      .toggle.on {
        color: var(--ah-accent, #2997ff);
        border-color: var(--ah-accent, #2997ff);
        background: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 12%,
          transparent
        );
        box-shadow: 0 0 0 1px
          color-mix(in srgb, var(--ah-accent, #2997ff) 28%, transparent);
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
      /* 滚动区外壳：相对定位，作为「回到底部」浮动按钮的定位上下文；
         按钮 absolute 钉在其底部中央，不进入文档流、不挤压/遮挡内容与输入框。 */
      .scroll-region {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .scroll {
        flex: 1 1 auto;
        overflow-y: auto;
        min-height: 0;
        padding: 18px 0;
      }
      /* 回到底部悬浮按钮：默认隐藏（由 showScrollDown 控制挂载），
         仅在用户向上滚动离开底部时出现；点击平滑滚回底部后由滚动事件自动消失。 */
      .scroll-down {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: 16px;
        z-index: 6;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        border: 1px solid var(--ah-border);
        background: var(--ah-surface-2);
        color: var(--ah-text-muted);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
        transition: color 0.15s ease, background 0.15s ease,
          border-color 0.15s ease, transform 0.18s ease, opacity 0.18s ease;
        animation: sdown-in 0.18s ease;
      }
      .scroll-down:hover {
        color: var(--ah-text);
        background: var(--ah-surface-3, var(--ah-surface-2));
        border-color: var(--ah-accent, #2997ff);
        transform: translateX(-50%) translateY(-1px);
      }
      .scroll-down svg {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
      }
      @keyframes sdown-in {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(6px);
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }
      /* 上下文用量指示器：头部按钮 + 弹层（分类占比，参考宿主「上下文用量」浮层）。 */
      .ctx-usage {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 32px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid var(--ah-border);
        background: var(--ah-surface-2);
        color: var(--ah-text-muted);
        cursor: pointer;
        font-size: 12px;
        flex: 0 0 auto;
      }
      .ctx-usage:hover {
        color: var(--ah-text);
        border-color: var(--ah-accent, #2997ff);
      }
      .ctx-pct {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        color: var(--ah-text);
      }
      .ctx-bar {
        width: 54px;
        height: 6px;
        border-radius: 3px;
        background: var(--ah-surface-3, rgba(255, 255, 255, 0.12));
        overflow: hidden;
      }
      .ctx-fill {
        display: block;
        height: 100%;
        border-radius: 3px;
        background: linear-gradient(90deg, #2997ff, #34c759);
        transition: width 0.2s ease;
      }
      .ctx-pop {
        position: absolute;
        top: calc(100% + 6px);
        right: 12px;
        z-index: 20;
        width: 280px;
        max-width: calc(100vw - 24px);
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--ah-border);
        background: var(--ah-surface-1);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        animation: ctx-in 0.16s ease;
      }
      @keyframes ctx-in {
        from {
          opacity: 0;
          transform: translateY(-6px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .ctx-pop-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .ctx-pop-head > span:first-child {
        font-weight: 600;
        font-size: 13px;
        color: var(--ah-text);
      }
      .ctx-pop-total {
        font-size: 11px;
        color: var(--ah-text-muted);
        font-variant-numeric: tabular-nums;
      }
      .ctx-seg {
        display: flex;
        height: 8px;
        border-radius: 4px;
        overflow: hidden;
        gap: 2px;
        margin-bottom: 10px;
        background: var(--ah-surface-3, rgba(255, 255, 255, 0.08));
      }
      .ctx-seg-i {
        height: 100%;
      }
      .ctx-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ctx-list li {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
      .ctx-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: 0 0 auto;
      }
      .ctx-label {
        flex: 1 1 auto;
        color: var(--ah-text-muted);
      }
      .ctx-val {
        font-variant-numeric: tabular-nums;
        color: var(--ah-text);
        font-weight: 600;
      }
      .c-sys {
        background: #ff9f0a;
      }
      .c-tools {
        background: #5ac8fa;
      }
      .c-msg {
        background: #2997ff;
      }
      .c-mcp {
        background: #34c759;
      }
      .c-skill {
        background: #bf5af2;
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
        background: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 14%,
          var(--ah-surface-2)
        );
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
        background: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 7%,
          var(--ah-surface-2)
        );
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
        background: linear-gradient(
          to bottom,
          transparent,
          color-mix(in srgb, var(--ah-surface-2) 80%, transparent)
        );
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
        background: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 12%,
          transparent
        );
        color: var(--ah-accent, #2997ff);
      }
      .inner-tool.errored .itag {
        background: color-mix(
          in srgb,
          var(--ah-danger, #e24b4a) 12%,
          transparent
        );
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
        0%,
        80%,
        100% {
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
        background: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 5%,
          var(--ah-surface-2)
        );
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
        background: color-mix(
          in srgb,
          var(--ah-danger, #e24b4a) 16%,
          transparent
        );
        color: var(--ah-danger, #e24b4a);
      }
      .tbadge.pend {
        background: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 16%,
          transparent
        );
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
        background: color-mix(
          in srgb,
          var(--ah-success, #34c759) 8%,
          var(--ah-surface-2)
        );
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
      .tnode.kind-step > summary .tdot {
        background: var(--ah-accent, #2997ff);
      }
      .tnode.kind-llm > summary .tdot {
        background: #9b6dff;
      }
      .tnode.kind-tool > summary .tdot {
        background: var(--ah-text-muted);
      }
      .tnode.kind-retrieval > summary .tdot {
        background: var(--ah-success, #34c759);
      }
      .tnode.kind-cost > summary .tdot {
        background: #f0a020;
      }
      .tnode.kind-tokencache > summary .tdot {
        background: #2dd4bf;
      }
      .tnode.kind-verify > summary .tdot {
        background: var(--ah-success, #34c759);
      }
      .tnode.kind-guardrail > summary .tdot,
      .tnode.kind-budget > summary .tdot,
      .tnode.kind-error > summary .tdot {
        background: var(--ah-danger, #e24b4a);
      }
      .tnode.status-error > summary .tlabel {
        color: var(--ah-danger, #e24b4a);
      }

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
      .ins-breakdown {
        margin-top: 10px;
        border-top: 1px dashed var(--ah-border);
        padding-top: 10px;
      }
      .ins-bd-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--ah-accent, #2997ff);
        margin-bottom: 8px;
      }
      .ins-bd-row {
        margin-bottom: 7px;
      }
      .ins-bd-head {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        margin-bottom: 3px;
      }
      .ins-bd-name {
        color: var(--ah-text-muted);
      }
      .ins-bd-val {
        color: var(--ah-text);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ins-bd-track {
        height: 6px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--ah-border) 60%, transparent);
        overflow: hidden;
      }
      .ins-bd-fill {
        height: 100%;
        border-radius: 4px;
        background: linear-gradient(
          90deg,
          var(--ah-accent, #2997ff),
          color-mix(in srgb, var(--ah-accent, #2997ff) 55%, #34c759)
        );
        transition: width 0.35s ease;
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
        background: color-mix(
          in srgb,
          var(--ah-success, #34c759) 6%,
          var(--ah-surface-1)
        );
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
        background: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 5%,
          var(--ah-surface-2)
        );
        overflow: hidden;
        animation: think-in 0.28s ease;
      }
      @keyframes think-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: none;
        }
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
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 1;
        }
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
          /* 移动端：ah-chat 嵌在 ah-app 的 .content 中，对话 Tab 时外壳已被
             .shell.chat-mode 锁定为整屏（fixed + inset:0）。这里让 ah-chat 填满
             .content（height:100%），输入框自然钉在视口底部，无需滚动外层页面。
             min-height:0 必须显式中和 sharedStyles ≤760px 设的 min-height:100dvh，
             否则它把组件顶高、仍需滚动。 */
          height: 100%;
          min-height: 0;
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
          width: 28px;
          height: 28px;
        }
        .toggle svg {
          width: 14px;
          height: 14px;
        }
        .composer-wrap {
          padding: 10px 10px calc(12px + env(safe-area-inset-bottom));
        }
        .composer {
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
        .composer .composer-footer {
          padding: 4px 6px 8px 8px;
        }
        .attach-btn {
          width: 32px;
          height: 32px;
          font-size: 20px;
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
        /* 悬浮输入：去除底部背景块与顶部分隔线，让输入框像卡片一样浮在对话区之上。 */
        border-top: none;
        background: transparent;
        padding: 10px 18px 16px;
      }
      .composer {
        max-width: 820px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 0;
        border: 1px solid var(--ah-border);
        border-radius: 18px;
        background: var(--ah-surface-2);
        /* 悬浮阴影 + 聚焦抬升 */
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22),
          0 4px 12px rgba(0, 0, 0, 0.12);
        transition: box-shadow 0.2s ease, border-color 0.2s ease,
          transform 0.2s ease;
        min-height: 56px;
      }
      .composer:focus-within {
        border-color: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 45%,
          var(--ah-border)
        );
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.2),
          0 0 0 3px
            color-mix(in srgb, var(--ah-accent, #2997ff) 14%, transparent);
        transform: translateY(-1px);
      }
      /* 附件预览条：顶部，横向滚动 */
      .composer .attachments-preview {
        flex-shrink: 0;
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        padding: 8px 12px;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: thin;
        scrollbar-color: color-mix(
            in srgb,
            var(--ah-text-muted) 28%,
            transparent
          )
          transparent;
        border-bottom: 1px solid var(--ah-border);
      }
      /* 主体区：textarea 填满剩余高度 */
      .composer .composer-body {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        align-items: stretch;
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
        max-height: 140px;
        min-height: 52px;
        padding: 10px 12px;
        width: 100%;
        box-sizing: border-box;
      }
      /* 底部按钮行：固定高度，左 attach / 右 send */
      .composer .composer-footer {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px 8px 12px;
        gap: 8px;
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
      /* 附件上传区域样式 */
      .attachments-preview {
        /* 行内横向滚动，不占用固定高度 */
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        padding: 2px 12px;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: thin;
        scrollbar-color: color-mix(
            in srgb,
            var(--ah-text-muted) 28%,
            transparent
          )
          transparent;
      }
      .attach-preview-item {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 4px 30px 4px 6px;
        background: var(--ah-surface-3);
        border: 1px solid var(--ah-border);
        border-radius: 12px;
        font-size: 12px;
        max-width: 170px;
        min-width: 110px;
        cursor: default;
        transition: background 0.18s ease, border-color 0.18s ease,
          box-shadow 0.18s ease, transform 0.18s ease;
        position: relative;
        flex-shrink: 0;
      }
      /* 图片附件：可点击预览 */
      .attach-preview-item.is-image {
        cursor: zoom-in;
      }
      .attach-preview-item.is-image:hover {
        border-color: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 50%,
          var(--ah-border)
        );
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28),
          0 1px 3px rgba(0, 0, 0, 0.18);
        transform: translateY(-2px);
      }
      /* 上传失败：去掉单独徽标，整框上红色边框 + 底色提示 */
      .attach-preview-item.error {
        border-color: var(--ah-danger, #e24b4a);
        background: color-mix(
          in srgb,
          var(--ah-danger, #e24b4a) 14%,
          var(--ah-surface-3)
        );
      }
      .attach-err {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--ah-danger, #e24b4a);
        white-space: nowrap;
      }
      .attach-preview-item:hover {
        background: var(--ah-surface-2);
        border-color: color-mix(
          in srgb,
          var(--ah-accent, #2997ff) 35%,
          var(--ah-border)
        );
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28),
          0 1px 3px rgba(0, 0, 0, 0.18);
        transform: translateY(-2px);
      }
      .attach-thumb {
        width: 18px;
        height: 18px;
        object-fit: cover;
        border-radius: 50%;
        flex-shrink: 0;
        /* transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1),
          box-shadow 0.22s cubic-bezier(0.4, 0, 0.2, 1); */
        display: block;
      }
      .attach-preview-item:hover .attach-thumb {
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
        z-index: 2;
        position: relative;
      }
      .attach-icon {
        font-size: 22px;
        flex-shrink: 0;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        border-radius: 8px;
        transition: background 0.18s ease, transform 0.18s ease;
      }
      .attach-preview-item:hover .attach-icon {
        background: var(--ah-surface-1);
        transform: scale(1.1);
      }
      .attach-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--ah-text);
        font-size: 12px;
      }
      .attach-rm {
        position: absolute;
        right: 0;
        top: 0;
        transform: translate(6px, -10px);
        border: none;
        background: transparent;
        color: var(--ah-text-muted);
        width: 20px;
        height: 20px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        opacity: 0;
        transition: opacity 0.18s ease, background 0.15s ease, color 0.15s ease;
      }
      .attach-preview-item:hover .attach-rm {
        opacity: 1;
      }
      .attach-rm:hover {
        background: color-mix(
          in srgb,
          var(--ah-danger, #e24b4a) 18%,
          transparent
        );
        color: var(--ah-danger, #e24b4a);
        /* transform: scale(1.15); */
      }
      .attach-status {
        flex-shrink: 0;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: #fff;
      }
      .attach-status.uploading {
        background: var(--ah-accent);
        animation: ah-spin 1s linear infinite;
      }
      .attach-status.done {
        background: var(--ah-success);
      }
      /* 消息气泡中的附件 */
      .attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 8px;
      }
      .attachments.has-images {
        flex-direction: row;
      }
      .attach-img.is-previewable {
        cursor: zoom-in;
      }
      .attach-img img {
        max-width: 200px;
        max-height: 200px;
        border-radius: var(--ah-radius-sm);
        object-fit: cover;
        transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1),
          box-shadow 0.22s cubic-bezier(0.4, 0, 0.2, 1);
        cursor: inherit;
        display: block;
      }
      .attach-img:hover img {
        transform: scale(1.06);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2);
      }
      .attach-file {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: var(--ah-surface-3);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-sm);
        font-size: 12px;
        color: var(--ah-text);
      }
      .attach-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        cursor: pointer;
        color: var(--ah-text-muted);
        transition: color 0.15s, background 0.15s;
        flex-shrink: 0;
        font-size: 22px;
        line-height: 1;
      }
      .attach-btn:hover {
        color: var(--ah-accent);
        background: var(--ah-surface-3);
      }
      /* 移动端适配 */
      @media (max-width: 640px) {
        .attach-preview-item {
          max-width: 140px;
          min-width: 90px;
          height: 28px;
          padding: 3px 26px 3px 5px;
        }
        .attach-thumb {
          width: 24px;
          height: 24px;
        }
        .attach-icon {
          font-size: 18px;
          width: 24px;
          height: 24px;
        }
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

      /* 图片预览 Lightbox */
      .lightbox {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        padding: 40px;
        cursor: zoom-out;
        animation: ah-fadeIn 0.18s ease;
      }
      @keyframes ah-fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      .lightbox img {
        max-width: 90vw;
        max-height: 88vh;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
        object-fit: contain;
        animation: ah-zoomIn 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      @keyframes ah-zoomIn {
        from {
          transform: scale(0.85);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }
      .lightbox-close {
        position: absolute;
        top: 16px;
        right: 20px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        font-size: 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease;
      }
      .lightbox-close:hover {
        background: rgba(255, 255, 255, 0.28);
      }
      .lightbox-info {
        position: absolute;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.6);
        color: #fff;
        padding: 6px 14px;
        border-radius: 20px;
        font-size: 12px;
        white-space: nowrap;
        pointer-events: none;
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
    `
  ];

  @state() sessions: SessionView[] = [];
  @state() activeId = '';
  @state() messages: ChatMsg[] = [];
  @state() input = '';
  @state() model = '';
  @state() mode: RunMode = 'mock';
  @state() deepThink = true;
  @state() web = false;
  /** 每条助手消息的深度思考折叠态（key 为 message id），用于手动收起思考区。 */
  @state() thinkCollapsed: Record<string, boolean> = {};
  /** 移动端侧栏抽屉开合态（≤900px 生效）。 */
  @state() sidebarOpen = false;
  @state() error: string | null = null;
  /** 可选的定向业务 agent：为空则走默认通用 Agent。Web 端用它把对话路由到具体插件 agent（如医美客资）。 */
  @state() agents: { id: string; name: string }[] = [];
  @state() agentId = '';
  /** 待发送附件（本地预览用，不在 server 上传时以 DataURL 嵌入消息）。 */
  @state() attachments: UploadedFile[] = [];
  /** 当前全屏预览的附件；null 表示未打开预览。 */
  @state() private previewFile: UploadedFile | null = null;
  /** 上传中的文件追踪（key 为文件名+时间戳） */
  private uploadingFiles: Map<
    string,
    { status: 'uploading' | 'done' | 'error'; error?: string }
  > = new Map();

  private nextId = 1;
  private scrollRef = createRef<HTMLElement>();
  /** 是否「钉」在底部：用户向上滚动看历史时为 false，新消息不再自动跟随其滚动。 */
  @state() private stickToBottom = true;
  /** 是否显示「回到底部」悬浮按钮（仅当用户离开底部时显示）。 */
  @state() private showScrollDown = false;
  /** 是否展开「上下文用量」弹层。 */
  @state() private showCtxUsage = false;
  /** 后端经 SSE `llm:usage` 下发的精确上下文用量（provider usage 为权威总量）。
   *  为 null 时「上下文用量」浮层回退到前端基于消息缓冲的粗估。 */
  @state() private backendUsage: {
    window: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    breakdown: { system: number; tools: number; messages: number; mcp: number; skills: number; completion: number };
  } | null = null;

  /**
   * 每个会话独立的流式缓冲。切换会话时，进行中的 run 仍向所属会话的缓冲写入，
   * 切回时实时恢复 —— 这是「切换会话不中断对话」的核心：
   * 显示用的 this.messages 指向当前会话的缓冲，后台 run 写的是自己的会话缓冲，二者解耦。
   */
  private threads: Record<string, ChatMsg[]> = {};
  /** 每个会话当前正在流式的 assistant 消息下标（send 时写入，run 结束后保留，供切回识别）。 */
  private streamIdx: Record<string, number> = {};
  /** 每个会话是否正在流式（支持多个会话并发进行）。
   *  MUST 为 @state 并以不可变重赋值（this.streaming = {...this.streaming, [sid]: x}）更新：
   *  直接 this.streaming[sid] = x 是对象内属性赋值，Lit 不观测，重渲染不会触发，
   *  会导致 run 结束后 UI 仍停在 streaming===true 的那一帧（一直显示「模型正在回复…」、输入框禁用）。 */
  @state() private streaming: Record<string, boolean> = {};

  /** 不可变更新某会话的流式状态，确保 Lit 触发重渲染（见 streaming 字段注释）。 */
  private setStreaming(sid: string, val: boolean) {
    this.streaming = { ...this.streaming, [sid]: val };
  }
  /** 每会话的打字机缓冲（content / reasoning 分开）。 */
  private pending: Record<string, { content: string; reasoning: string }> = {};
  /** 每会话是否已收到 llm:token 增量（防止 llm:response 整段覆盖打字机效果）。 */
  private received: Record<string, boolean> = {};
  /** run:end 携带的权威全文（仅在打字机未产生任何可见文本时作兜底）。 */
  private finalBy: Record<string, string> = {};
  /** 每会话的调用链路追踪构建上下文。 */
  private traces: Record<string, TraceCtx> = {};
  /** 每会话的中止控制器（仅停止对应会话的 run）。 */
  private abortBy: Record<string, AbortController> = {};
  private typedTimer: ReturnType<typeof setInterval> | null = null;

  /** 当前是否仍有任何会话在流式（用于打字机定时器的停启判定）。 */
  private get anyStreaming(): boolean {
    for (const k in this.streaming) if (this.streaming[k]) return true;
    return false;
  }

  /** 取（或惰性创建）某会话的消息缓冲。 */
  private threadFor(sid: string): ChatMsg[] {
    return this.threads[sid] ?? (this.threads[sid] = []);
  }

  /** 取某会话当前流式消息。 */
  private curSession(sid: string): ChatMsg | null {
    const idx = this.streamIdx[sid];
    const t = this.threads[sid];
    return idx >= 0 && t && t[idx] ? t[idx] : null;
  }

  /** 写入某会话的流式消息（streamIdx 指向的那条），并在该会话为当前显示会话时同步 this.messages 触发重渲染。 */
  private patchSession(sid: string, p: Partial<ChatMsg>) {
    const idx = this.streamIdx[sid];
    if (idx == null || idx < 0) return;
    const t = this.threads[sid];
    if (!t || !t[idx]) return;
    const nt = t.slice();
    nt[idx] = { ...nt[idx], ...p };
    this.threads[sid] = nt;
    if (sid === this.activeId) this.messages = nt;
  }

  /** 重置某会话的调用链路追踪瞬态状态（防御上轮残留泄漏到本轮）。 */
  private resetTrace(sid: string) {
    this.traces[sid] = {
      root: null,
      parent: null,
      llm: null,
      lastTool: null,
      seq: 0
    };
  }
  private traceCtx(sid: string): TraceCtx {
    return (
      this.traces[sid] ??
      (this.traces[sid] = {
        root: null,
        parent: null,
        llm: null,
        lastTool: null,
        seq: 0
      })
    );
  }

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onPreviewKeydown);
    try {
      const [list, state] = await Promise.all([
        client.listChatSessions(),
        client.getState()
      ]);
      this.sessions = list.map((s: ChatSession) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt
      }));
      this.mode = (state as any)?.openrouter ? 'real' : 'mock';
    } catch {
      /* 离线/未启动：仍可进入空状态，发送时按 mock 兜底 */
    }
    // 拉取 agent 列表（失败不影响聊天，selector 退化为仅「默认 Agent」）
    try {
      const res = await client.listAgents();
      this.agents = ((res?.agents as any[]) ?? []).map((a) => ({
        id: String(a.id),
        name: String(a.name ?? a.id)
      }));
    } catch {
      /* ignore */
    }
    // 自动认证：服务端降级模式下会把统一凭证注入 <meta name="ah-api-key">，
    // 此处读取并写入 client（持久化到 localStorage），使 SPA 在需鉴权时自动带 token。
    try {
      const metaKey = document
        .querySelector('meta[name="ah-api-key"]')
        ?.getAttribute('content');
      if (metaKey) setToken(metaKey);
    } catch {
      /* ignore */
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onPreviewKeydown);
  }

  protected updated() {
    this.scrollToBottom();
    this.scrollThinkToBottom();
  }

  private scrollToBottom() {
    // 仅当用户处于「钉底」状态时才自动跟随到底部；
    // 用户若向上滚动看历史（stickToBottom=false），则保持当前位置不抢滚。
    const el = this.scrollRef.value;
    if (el && this.stickToBottom) el.scrollTop = el.scrollHeight;
  }

  /**
   * 监听消息区滚动：计算距底部距离，决定是否「钉底」跟随，并驱动浮动按钮显隐。
   * 阈值 24px：容忍亚像素/轻微回弹，认为已到底部则隐藏按钮、恢复跟随。
   */
  private onScroll() {
    const el = this.scrollRef.value;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= 24;
    this.stickToBottom = atBottom;
    this.showScrollDown = !atBottom;
  }

  /** 点击浮动按钮：平滑滚动回到底部，并重新开启「钉底」跟随（到底后按钮会被滚动事件自动隐藏）。 */
  private scrollToBottomSmooth() {
    const el = this.scrollRef.value;
    if (!el) return;
    this.stickToBottom = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  /**
   * 估算当前线程占用模型上下文窗口的比例，按维度拆分（参考宿主「上下文用量」浮层）。
   * 数据来自当前消息缓冲（对话内容 / 推理 / 工具调用 / 附件），系统提示词与 MCP / 技能为基线粗估。
   * 注意：这是前端基于字符数的粗估（≈ 字符/3），仅用于趋势提示，并非后端精确 token 计数。
   */
  private contextUsage(): {
    totalPct: number;
    totalTokens: number;
    window: number;
    items: { key: string; label: string; tokens: number; pct: number; cls: string }[];
  } {
    const WINDOW = 128000; // 上下文窗口基线（token）
    const SYS_BASE = 1400; // 系统提示词 + Agent 卡片基线
    const MCP_BASE = 60; // 连接器及 MCP 注册信息基线
    const SKILL_BASE = 80; // 技能基线
    const tok = (s?: string) => (s ? Math.ceil([...s].length / 3) : 0);
    let msgTokens = 0;
    let toolTokens = 0;
    for (const m of this.messages) {
      msgTokens += tok(m.content) + tok(m.reasoning);
      for (const a of m.attachments ?? []) msgTokens += 1200; // 每图约 1.2K token
      for (const t of m.tools ?? []) toolTokens += tok(t.args) + tok(t.result);
    }
    const items = [
      { key: 'sys', label: '系统提示词', tokens: SYS_BASE, cls: 'c-sys', pct: 0 },
      { key: 'tools', label: '工具及子智能体', tokens: toolTokens, cls: 'c-tools', pct: 0 },
      { key: 'msg', label: '对话消息', tokens: msgTokens, cls: 'c-msg', pct: 0 },
      { key: 'mcp', label: '连接器及 MCP', tokens: MCP_BASE, cls: 'c-mcp', pct: 0 },
      { key: 'skill', label: '技能', tokens: SKILL_BASE, cls: 'c-skill', pct: 0 }
    ];
    const totalTokens = items.reduce((s, it) => s + it.tokens, 0);
    const totalPct = Math.min(100, (totalTokens / WINDOW) * 100);
    for (const it of items) it.pct = (it.tokens / WINDOW) * 100;
    return { totalPct, totalTokens, window: WINDOW, items };
  }

  /**
   * 返回「上下文用量」浮层当前应展示的数据：优先用后端精确计数（llm:usage），
   * 未拿到后端数据（如 mock 模式、首屏）时回退到前端基于消息缓冲的粗估（contextUsage()）。
   * 两种来源统一成相同结构，渲染层无需关心数据出处。
   */
  private displayContextUsage(): {
    totalPct: number;
    totalTokens: number;
    window: number;
    items: { key: string; label: string; tokens: number; pct: number; cls: string }[];
  } {
    const u = this.backendUsage;
    if (u) {
      const items = [
        { key: 'sys', label: '系统提示词', tokens: u.breakdown.system, cls: 'c-sys', pct: 0 },
        { key: 'tools', label: '工具及子智能体', tokens: u.breakdown.tools, cls: 'c-tools', pct: 0 },
        { key: 'msg', label: '对话消息', tokens: u.breakdown.messages, cls: 'c-msg', pct: 0 },
        { key: 'mcp', label: '连接器及 MCP', tokens: u.breakdown.mcp, cls: 'c-mcp', pct: 0 },
        { key: 'skill', label: '技能', tokens: u.breakdown.skills, cls: 'c-skill', pct: 0 }
      ];
      const totalTokens = u.totalTokens;
      const totalPct = Math.min(100, (totalTokens / u.window) * 100);
      for (const it of items) it.pct = (it.tokens / u.window) * 100;
      return { totalPct, totalTokens, window: u.window, items };
    }
    // 后端精确计数暂未到位（mock 模式 / 首屏尚未触发 LLM）时，
    // 回退到前端基于消息缓冲的粗估，避免递归调用自身导致栈溢出。
    return this.contextUsage();
  }

  /**
   * 深度思考区流式（打字机）输出时，若内容已撑满 180px 上限，
   * 始终将视口钉在底部，保证最新推理「从下往上」逐字可见。
   * 只在思考区处于 live（流式、未折叠）时生效，思考结束后不再抢滚动，
   * 方便用户自由回看上面的推理文本。
   */
  private scrollThinkToBottom() {
    const tb = this.renderRoot.querySelector(
      '.think.live .think-body'
    ) as HTMLElement | null;
    if (tb) tb.scrollTop = tb.scrollHeight;
  }

  /* ----------------------- 会话管理 ----------------------- */

  private async newChat() {
    // 不中止任何进行中的 run：后台 run 继续写入其所属会话缓冲，新建对话只是切换显示到空线程。
    this.activeId = '';
    this.messages = [];
    this.input = '';
    this.error = null;
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.backendUsage = null;
  }

  private async selectSession(id: string) {
    if (id === this.activeId) return;
    this.activeId = id;
    this.sidebarOpen = false;
    this.error = null;
    this.input = '';
    // 关键修复：切换会话【不再】中止进行中的 run，也不清空其打字机缓冲 / 追踪状态。
    // 进行中的 run 仍向所属会话缓冲写内容，切回时实时恢复（见 this.threads / this.pending / this.traces）。
    // 优先用本地内存中的会话缓冲；否则向服务端拉取历史（仅当该会话从未在本会话实例中打开过）。
    if (!this.threads[id]) {
      try {
        const s = await client.getChatSession(id);
        this.threads[id] = s.messages.map((m) => ({
          id: this.nextId++,
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
          // 还原落盘时一并写入的推理、工具调用与调用链路追踪，避免切换会话后再切回丢失深度思考/复盘数据。
          reasoning: m.reasoning,
          tools: m.tools
            ? m.tools.map((t) => ({
                name: t.name,
                args: t.args ?? '',
                result: t.result,
                errored: t.errored
              }))
            : undefined,
          trace: m.trace ? m.trace : undefined
        }));
      } catch {
        this.threads[id] = [];
      }
    }
    this.messages = this.threads[id];
    // 切换会话：回到该会话最新消息底部，并恢复「钉底」跟随。
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.backendUsage = null;
  }

  private async renameSession(id: string) {
    const cur = this.sessions.find((s) => s.id === id);
    const title = window.prompt('重命名会话', cur?.title ?? '');
    if (!title || !title.trim()) return;
    try {
      await client.renameChatSession(id, title.trim());
      this.sessions = this.sessions.map((s) =>
        s.id === id ? { ...s, title: title.trim() } : s
      );
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
      ...this.sessions
    ];
    return s.id;
  }

  private async send() {
    const prompt = this.input.trim();
    // 仅阻止「同一会话正在流式时重复发送」；其它会话（含后台进行中的 run）不受影响，可并发。
    if (!prompt && this.attachments.length === 0) return;
    this.error = null;

    const sessionId = await this.ensureSession();

    // 构造用户消息内容：只发送纯文本提示词给 LLM。
    // 图片附件通过 m.attachments 传给前端单独渲染，同时通过 attachments 字段传给服务端。
    const content = prompt;

    // 为每个图片构建结构化附件信息。
    // 关键修复：直接把本地 dataUrl（完整 data: URI）作为图片内容发给模型，
    // 而非依赖服务端返回的 serverUrl（相对路径 /api/uploads/*，模型提供方无法 fetch）。
    // 这样即使服务端上传失败、或部署在 localhost，模型也能直接解码看到图片。
    const imageAttachments = this.attachments
      .filter((f) => f.type.startsWith('image/'))
      .map((f) => ({
        url: f.dataUrl || f.serverUrl || '',
        name: f.name,
        type: f.type
      }))
      .filter((f) => f.url);

    // 当前会话消息缓冲：追加 user + assistant(空)，并记录流式下标。
    const t = this.threadFor(sessionId);
    t.push({
      id: this.nextId++,
      role: 'user',
      content,
      attachments: [...this.attachments]
    });
    t.push({ id: this.nextId++, role: 'assistant', content: '' });
    this.streamIdx[sessionId] = t.length - 1;
    this.threads[sessionId] = t;
    this.input = '';
    this.attachments = [];
    // 重置该会话的流式状态（防御上轮残留的缓冲 / 定时器泄漏到本轮）。
    this.received[sessionId] = false;
    this.pending[sessionId] = { content: '', reasoning: '' };
    this.finalBy[sessionId] = '';
    this.resetTrace(sessionId);
    this.stopTypewriter();
    this.setStreaming(sessionId, true);
    if (this.activeId === sessionId) this.messages = t;
    // 发送新消息：强制钉底并滚到最新内容（即便用户此前向上翻阅历史）。
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.showCtxUsage = false;
    this.backendUsage = null;

    const ac = new AbortController();
    this.abortBy[sessionId] = ac;
    try {
      for await (const ev of client.streamRun(
        {
          mode: this.mode,
          prompt,
          model: this.model || undefined,
          agentId: this.agentId || undefined,
          sessionId,
          chatSessionId: sessionId,
          attachments:
            imageAttachments.length > 0 ? imageAttachments : undefined,
          // 联网搜索开关（Request 4）：仅在用户显式开启 web 时透传 true，关闭时缺省不触发任何出网检索。
          web: this.web || undefined
        },
        { signal: ac.signal }
      )) {
        this.ingest(ev as StreamEvent, sessionId);
      }
    } catch (e: any) {
      this.patchSession(sessionId, {
        error: true,
        content:
          (this.curSession(sessionId)?.content ?? '') || `⚠️ ${e?.message ?? e}`
      });
    } finally {
      // 先停掉 interval 定时器，再按打字节奏把剩余缓冲揭示完（drain），
      // 避免 run:end 的 final 文本一次性覆盖掉打字机效果；被手动中止时则立即落盘。
      this.stopTypewriter();
      if (ac.signal.aborted) {
        this.flushTypewriter(sessionId);
      } else {
        await this.drainTypewriter(sessionId);
      }
      const c = this.curSession(sessionId);
      if (c && !c.content && this.finalBy[sessionId]) {
        this.patchSession(sessionId, { content: this.finalBy[sessionId] });
      }
      this.setStreaming(sessionId, false);
      this.abortBy[sessionId] = undefined as any;
      if (this.activeId === sessionId) this.messages = this.threads[sessionId];
    }
  }

  /** 手动停止当前显示会话的 run（仅中止该会话，不影响其它后台 run）。 */
  private stop() {
    const ac = this.abortBy[this.activeId];
    ac?.abort();
  }

  private ingest(ev: StreamEvent, sid: string) {
    // 每次都从最新 this.threads[sid] 读取当前消息：patch 会整体替换数组与对象，
    // 早期捕获的引用是「旧快照」，直接用它做增量拼接会丢内容 / 看不到已落下的工具卡。
    const cur = (): ChatMsg | null => this.curSession(sid);
    const patch = (p: Partial<ChatMsg>) => this.patchSession(sid, p);
    // 终结事件（最终答复已到达 / 流结束 / 运行出错）：立即解除该会话的「流式」状态。
    // 用不可变重赋值触发 Lit 重渲染，避免 run 结束后 UI 仍卡在「模型正在回复…」、输入框被禁用。
    // 即便 SSE 连接因故迟迟未关闭，UI 也会在最终答复到达时即时解锁；send() 的 finally 为二次兜底。
    const et = (ev as any).type;
    if (et === 'run:end' || et === '_done' || et === 'error') {
      this.setStreaming(sid, false);
    }
    // 把事件汇入调用链路追踪树（独立于内容/工具卡，结构化记录 LLM↔工具↔检索 过程）。
    this.traceHandle(ev, sid);
    switch (ev.type) {
      case 'job:accepted':
        // jobId 仅用于潜在调试，无需持久；忽略。
        break;
      case 'llm:token': {
        const c = cur();
        if (c) {
          this.received[sid] = true;
          // 不再直接 patch 到 content：整段塞进单 delta 时会「一帧跳全文」。
          // 改为进 pending 缓冲，由打字机定时器按节奏逐字揭示。
          this.pending[sid].content += String((ev as any).delta ?? '');
          this.ensureTypewriter();
        }
        break;
      }
      case 'llm:reasoning': {
        const c = cur();
        if (c) {
          this.pending[sid].reasoning += String((ev as any).delta ?? '');
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
        if (c && !this.received[sid]) {
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
          args: safeJson((ev as any).call?.arguments)
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
                errored: Boolean((ev as any).errored)
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
              `\n\n> ⚠️ 护栏拦截（${escapeHtml(
                String((ev as any).phase ?? '')
              )}）：${escapeHtml(String((ev as any).reason ?? ''))}`
          });
        break;
      }
      case 'llm:usage': {
        // 后端精确上下文用量：更新浮层数据源，并同步给 dashboard 汇总（跨页面共享）。
        const u = ev as any;
        if (u && u.breakdown) {
          this.backendUsage = {
            window: u.window,
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            totalTokens: u.totalTokens,
            breakdown: u.breakdown
          };
          const totalPct = Math.min(100, (Number(u.totalTokens) / Number(u.window)) * 100);
          agentContext.set('lastContextUsage', {
            totalPct,
            totalTokens: Number(u.totalTokens),
            window: Number(u.window),
            model: u.model,
            updatedAt: Date.now()
          });
        }
        break;
      }
      case 'run:end': {
        const finalStr = String((ev as any).final ?? '');
        this.finalBy[sid] = finalStr;
        // 若已通过 llm:token 走打字机揭示：不在这里用 final 覆盖 content（否则整段秒显，打字机失效）。
        // 让打字机按节奏自然揭示到 final 文本；仅在完全没有 token 增量时（非流式回退）才直接赋值。
        if (!this.received[sid] && finalStr) {
          const c = cur();
          if (c) patch({ content: finalStr });
        }
        break;
      }
      case 'error': {
        const c = cur();
        if (c)
          patch({
            error: true,
            content:
              c.content || `⚠️ ${escapeHtml(String((ev as any).message ?? ev))}`
          });
        break;
      }
      default:
        break;
    }
  }

  /* ----------------------- 调用链路追踪构建 ----------------------- */

  /** 确保追踪树根节点（run）存在并返回（按会话独立）。 */
  private ensureTraceRoot(sid: string): TraceNode {
    const tc = this.traceCtx(sid);
    if (!tc.root) {
      tc.root = {
        id: 't0',
        kind: 'run',
        label: '运行',
        status: 'ok',
        children: []
      };
      tc.parent = tc.root;
    }
    return tc.root;
  }

  /**
   * 把一条流式事件汇入调用链路追踪树（瞬态构建，结果写入当前会话 assistant 消息的 trace 字段）。
   * 树形：run → step → llm → tool/retrieval/cost，外加 root 级的 verify/guardrail/budget/error。
   * 外部调用（工具/检索）因此被整合进对话上下文，可结构化复盘。追踪按会话隔离，支持并发流式。
   */
  private traceHandle(ev: any, sid: string) {
    const tc = this.traceCtx(sid);
    const mk = (
      parent: TraceNode,
      kind: TraceKind,
      label: string,
      status: TraceNode['status'] = 'ok',
      extra: Partial<TraceNode> = {}
    ): TraceNode => {
      const n: TraceNode = {
        id: `t${++tc.seq}`,
        kind,
        label,
        status,
        children: [],
        ...extra
      };
      parent.children.push(n);
      return n;
    };
    switch (ev?.type) {
      case 'run:meta': {
        const r = this.ensureTraceRoot(sid);
        r.meta = {
          ...(r.meta ?? {}),
          ...(ev.model ? { model: String(ev.model) } : {}),
          ...(ev.agentId ? { agent: String(ev.agentId) } : {}),
          ...(ev.mode ? { mode: String(ev.mode) } : {})
        };
        r.label = ev.model ? `运行 · ${ev.model}` : '运行';
        break;
      }
      case 'step:start': {
        const r = this.ensureTraceRoot(sid);
        tc.parent = r;
        const step = mk(r, 'step', `第 ${ev.step} 步`, 'ok', {
          meta: { step: `第 ${ev.step} 步 / 共 ${ev.maxSteps ?? '?'} 步` }
        });
        tc.parent = step;
        tc.llm = null;
        tc.lastTool = null;
        break;
      }
      case 'llm:call': {
        this.ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        tc.llm = mk(parent, 'llm', 'LLM 调用', 'ok', {
          meta: {
            messages: `消息 ${ev.messageCount ?? '?'}`,
            tools: `工具 ${ev.toolCount ?? '?'}`
          }
        });
        tc.lastTool = null;
        break;
      }
      case 'llm:reasoning': {
        if (tc.llm && typeof ev.delta === 'string') {
          const n =
            (tc.llm.meta?.reasoningChars
              ? Number(tc.llm.meta.reasoningChars)
              : 0) + ev.delta.length;
          tc.llm.meta = { ...(tc.llm.meta ?? {}), reasoningChars: String(n) };
        }
        break;
      }
      case 'llm:token': {
        if (tc.llm && typeof ev.delta === 'string') {
          const n =
            (tc.llm.meta?.tokenChars ? Number(tc.llm.meta.tokenChars) : 0) +
            ev.delta.length;
          tc.llm.meta = { ...(tc.llm.meta ?? {}), tokenChars: String(n) };
        }
        break;
      }
      case 'tool:start': {
        if (!tc.llm || !ev.call) break;
        const name = String(ev.call.name ?? 'tool');
        const retrieval = isRetrievalTool(name);
        tc.lastTool = mk(
          tc.llm,
          retrieval ? 'retrieval' : 'tool',
          retrieval ? `检索 · ${name}` : name,
          'pending',
          {
            detail:
              typeof ev.call.arguments === 'string'
                ? ev.call.arguments
                : JSON.stringify(ev.call.arguments ?? {})
          }
        );
        break;
      }
      case 'tool:result': {
        if (tc.lastTool) {
          tc.lastTool.result =
            typeof ev.result === 'string'
              ? ev.result
              : JSON.stringify(ev.result ?? {});
          tc.lastTool.status = ev.errored ? 'error' : 'ok';
          tc.lastTool.meta = {
            ...(tc.lastTool.meta ?? {}),
            status: ev.errored ? '失败' : '成功'
          };
        }
        break;
      }
      case 'run:cost': {
        this.ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        mk(parent, 'cost', '成本 / 用量', 'ok', {
          meta: {
            tokens: String(
              ev.cumulativeTokens ?? ev.usage?.total_tokens ?? '?'
            ),
            cost:
              ev.cumulativeCost != null
                ? `$${Number(ev.cumulativeCost).toFixed(4)}`
                : '?',
            priced: ev.priced ? 'true' : 'false',
            ...(ev.model ? { model: String(ev.model) } : {})
          }
        });
        break;
      }
      case 'run:token-cache': {
        this.ensureTraceRoot(sid);
        const parent = tc.parent ?? tc.root!;
        const tcHitPct = (Number(ev.hitRate) * 100).toFixed(1);
        const tcByModel = Object.entries<{
          queries: number;
          hits: number;
          hitRate: number;
        }>(ev.byModel ?? {})
          .map(
            ([m, st]) =>
              `${m}: ${(Number(st.hitRate) * 100).toFixed(0)}% (${st.hits}/${
                st.queries
              })`
          )
          .join(' · ');
        mk(parent, 'tokencache', 'Token 缓存命中率', 'ok', {
          meta: {
            命中率: `${tcHitPct}%`,
            命中: `${ev.hits}/${ev.queries}`,
            接口: String(ev.interface ?? 'prompt-cache'),
            ...(ev.model ? { 模型: String(ev.model) } : {}),
            ...(tcByModel ? { 分模型: tcByModel } : {})
          },
          detail: `采集点：LLM 调用返回 usage.prompt_tokens_details.cached_tokens；计算逻辑：命中次数(${
            ev.hits
          }) ÷ 总查询次数(${ev.queries}) = ${tcHitPct}%。关联服务/接口：${
            ev.model ?? '?'
          } · ${ev.interface ?? 'prompt-cache'}。`
        });
        break;
      }
      case 'verify:result': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'verify', '自检', ev.passed ? 'ok' : 'error', {
          meta: {
            score: String(ev.score ?? '?'),
            passed: ev.passed ? '通过' : '未通过'
          },
          result: (ev.reasons ?? []).join('\n')
        });
        break;
      }
      case 'guardrail:blocked': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'guardrail', `护栏拦截 · ${ev.phase ?? ''}`, 'error', {
          detail: String(ev.reason ?? '')
        });
        break;
      }
      case 'budget:exceeded': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'budget', `预算超限 · ${ev.kind ?? ''}`, 'error', {
          meta: { used: String(ev.used ?? '?'), limit: String(ev.limit ?? '?') }
        });
        break;
      }
      case 'error': {
        this.ensureTraceRoot(sid);
        mk(tc.root!, 'error', '运行错误', 'error', {
          detail: String(ev.message ?? '')
        });
        break;
      }
      default:
        break;
    }
    // 结构型事件才回写消息（token/reasoning 高频且仅更新 meta，避免无谓重渲染）。
    if (
      tc.root &&
      this.streamIdx[sid] >= 0 &&
      ev.type !== 'llm:token' &&
      ev.type !== 'llm:reasoning'
    ) {
      this.patchSession(sid, { trace: [tc.root] });
    }
  }

  /* ----------------------- 打字机缓冲 ----------------------- */

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

  /** 把某会话缓冲中的待揭示文本一次性落到 content / reasoning（运行结束时调用，避免文本滞留）。 */
  private flushTypewriter(sid: string) {
    const buf = this.pending[sid];
    if (!buf) return;
    const c = this.curSession(sid);
    if (c) {
      if (buf.content)
        this.patchSession(sid, { content: c.content + buf.content });
      if (buf.reasoning)
        this.patchSession(sid, {
          reasoning: (c.reasoning ?? '') + buf.reasoning
        });
    }
    buf.content = '';
    buf.reasoning = '';
    if (!this.anyStreaming) this.stopTypewriter();
  }

  /**
   * 运行结束后，接替 interval 把剩余缓冲按打字节奏（与 tick 一致的步长/间隔）逐步揭示，
   * 直到缓冲清空再 resolve。这样即使后端把整段塞进单个 token，用户也能看到逐字打字效果，
   * 而不是 run:end 的 final 文本一次性覆盖。
   */
  private drainTypewriter(sid: string): Promise<void> {
    return new Promise((resolve) => {
      const step = () => {
        const buf = this.pending[sid];
        if (!buf || (!buf.content.length && !buf.reasoning.length)) {
          if (!this.anyStreaming) this.stopTypewriter();
          resolve();
          return;
        }
        this.tickSession(sid);
        setTimeout(step, 24);
      };
      step();
    });
  }

  /** 单个定时器 tick：遍历所有会话缓冲，逐步揭示；无缓冲且均无流式时停定时器。 */
  private tickTypewriter() {
    let any = false;
    for (const sid in this.pending) {
      const buf = this.pending[sid];
      if (!buf || (!buf.content.length && !buf.reasoning.length)) continue;
      this.tickSession(sid);
      any = true;
    }
    if (!any && !this.anyStreaming) this.stopTypewriter();
  }

  /** 揭示某会话的一小段缓冲到可见文本。 */
  private tickSession(sid: string) {
    const buf = this.pending[sid];
    if (!buf) return;
    const c = this.curSession(sid);
    if (!c) return;
    if (buf.content.length) {
      const step = this.typeStep(buf.content.length);
      const move = buf.content.slice(0, step);
      buf.content = buf.content.slice(step);
      this.patchSession(sid, { content: c.content + move });
    }
    if (buf.reasoning.length) {
      const step = this.typeStep(buf.reasoning.length);
      const move = buf.reasoning.slice(0, step);
      buf.reasoning = buf.reasoning.slice(step);
      this.patchSession(sid, { reasoning: (c.reasoning ?? '') + move });
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

  /** 处理文件选择。读取本地预览并上传到服务端。 */
  private async onFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    const maxBytes = 10 * 1024 * 1024; // 10MB 上限
    const newFiles: UploadedFile[] = [];

    for (const f of Array.from(input.files)) {
      // 前置校验
      if (f.size > maxBytes) {
        this.error = `文件过大：${f.name}（上限 10MB）`;
        continue;
      }
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/svg+xml',
        'text/plain',
        'text/markdown',
        'text/csv',
        'application/json'
      ];
      if (
        !f.type.startsWith('image/') &&
        !f.type.startsWith('text/') &&
        !f.type.includes('json') &&
        !['.txt', '.md', '.csv', '.json'].includes(
          f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
        )
      ) {
        this.error = `不支持的文件类型：${f.name}`;
        continue;
      }

      // 本地预览 DataURL
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(f);
      });

      const key = `${f.name}_${Date.now()}`;
      const file: UploadedFile = {
        name: f.name,
        size: f.size,
        type: f.type,
        dataUrl,
        uploadStatus: 'uploading'
      };
      this.uploadingFiles.set(key, { status: 'uploading' });

      // 立即加入 attachments 显示预览
      newFiles.push(file);
      this.attachments = [...this.attachments, file];

      // 上传到服务端
      try {
        const formData = new FormData();
        formData.append('file', f, f.name);
        const token =
          typeof localStorage !== 'undefined'
            ? localStorage.getItem('ah_token')
            : null;
        const resp = await fetch('/api/upload', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData
        });
        const json = await resp.json();
        if (json.ok && json.meta?.url) {
          // 不可变更新：Lit @state() 仅在重新赋值时触发重渲染，
          // 原地修改数组元素的字段不会刷新 UI（⏳ 会一直卡住）。
          this.attachments = this.attachments.map((a) =>
            a === file
              ? { ...a, serverUrl: json.meta.url, uploadStatus: 'done' }
              : a
          );
          this.uploadingFiles.set(key, { status: 'done' });
        } else {
          throw new Error(json.error || '上传失败');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败';
        this.attachments = this.attachments.map((a) =>
          a === file
            ? { ...a, uploadStatus: 'error', uploadError: msg }
            : a
        );
        this.uploadingFiles.set(key, {
          status: 'error',
          error: msg
        });
        this.error = `上传失败：${f.name} — ${msg}`;
      }
    }

    input.value = '';
  }

  /** 移除已选附件。 */
  private removeAttachment(i: number) {
    const newAttachments = this.attachments.filter((_, idx) => idx !== i);
    this.attachments = newAttachments;
  }

  /** 文件是否可预览（图片 MIME 或常见图片扩展名）。 */
  private isPreviewable(f: UploadedFile): boolean {
    return (
      f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg)$/i.test(f.name)
    );
  }

  /** 打开图片附件的全屏预览。 */
  private openPreview(f: UploadedFile) {
    if (!this.isPreviewable(f)) return;
    this.previewFile = f;
  }

  private closePreview() {
    this.previewFile = null;
  }

  /** Esc 关闭预览（window 级监听，无需聚焦 lightbox）。 */
  private onPreviewKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.previewFile) this.closePreview();
  };

  /** 折叠 / 展开某条消息的深度思考区（思考中不可折叠，保证实时推理可见）。 */
  private toggleThink(id: number) {
    const k = String(id);
    const c = this.messages.find((m) => m.id === id);
    const sIdx = this.streamIdx[this.activeId] ?? -1;
    const isThinking =
      this.streaming[this.activeId] &&
      sIdx >= 0 &&
      this.messages[sIdx]?.id === id &&
      !c?.content;
    if (isThinking) return;
    this.thinkCollapsed = {
      ...this.thinkCollapsed,
      [k]: !this.thinkCollapsed[k]
    };
  }

  /** 切换移动端侧栏抽屉（≤900px 生效）。 */
  private toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
  }

  /** 渲染附件预览（图片缩略图 / 文件图标）。 */
  private renderAttachments(files: UploadedFile[]): TemplateResult {
    const hasImages = files.some((f) => f.type.startsWith('image/'));
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    return html`
      <div class="attachments ${hasImages ? 'has-images' : ''}">
        ${images.map(
          (f) =>
            html`<div
              class="attach-img is-previewable"
              title="点击预览"
              @click=${() => this.openPreview(f)}
            >
              <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
            </div>`
        )}
        ${others.map(
          (f) =>
            html`<div class="attach-file">
              ${this.fileIcon(f)} ${escapeHtml(f.name)}
              (${this.formatSize(f.size)})
            </div>`
        )}
      </div>
    `;
  }

  private fileIcon(f: UploadedFile): string {
    if (f.type.startsWith('image/')) return '🖼';
    if (f.type.includes('pdf')) return '📄';
    if (
      f.type.includes('csv') ||
      f.type.includes('json') ||
      f.type.includes('text')
    )
      return '📝';
    return '📎';
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private renderMessage(m: ChatMsg) {
    // 用户消息：渲染气泡文本 + 附件预览。
    if (m.role === 'user') {
      const hasAttachments = m.attachments && m.attachments.length > 0;
      return html`
        <div class="msg user">
          <div class="avatar">你</div>
          <div class="bubble">
            ${hasAttachments ? this.renderAttachments(m.attachments!) : nothing}
            <div class="msg-text">${unsafeHTML(toRichHtml(m.content))}</div>
          </div>
        </div>
      `;
    }

    // 助手消息：合并视图 —— 深度思考（实时流式）在上，最终回答（分隔后）在下；
    // 模型仍在处理时于对应区域显示「思考中 / 模型正在回复…」文字动效。
    // 流式判定基于「当前显示会话是否正在流式、且本消息即其流式消息」。
    const sIdx = this.streamIdx[this.activeId] ?? -1;
    const isStreamingAssistant =
      this.streaming[this.activeId] === true &&
      sIdx >= 0 &&
      this.messages[sIdx]?.id === m.id &&
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
          ${showThinking && this.deepThink
            ? this.renderThinking(m, isThinking)
            : nothing}
          ${showThinking &&
          this.deepThink &&
          (m.content || isStreamingAssistant)
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
    const parsed =
      m.reasoning && m.reasoning.trim() ? parseDeepThinking(m.reasoning) : null;
    const collapsed = !!this.thinkCollapsed[String(m.id)];
    return html`
      <div
        class="think ${isThinking ? 'live' : ''} ${collapsed
          ? 'collapsed'
          : ''}"
      >
        <div
          class="think-head"
          @click=${() => this.toggleThink(m.id)}
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
  private renderAnswer(
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
                <svg
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
                </svg>
                <span>调用链路</span>
                <span class="tcount"
                  >${this.countTraceNodes(m.trace!)} 节点</span
                >
                ${isStreaming
                  ? html`<span class="dots"><i></i><i></i><i></i></span>`
                  : nothing}
              </summary>
              <div class="trace-body">
                ${m.trace!.map((n) => this.renderTraceNode(n))}
              </div>
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
    const walk = (ns: TraceNode[]) =>
      ns.forEach((x) => {
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
    const defaultOpen =
      n.kind === 'run' || n.kind === 'step' || n.kind === 'llm';
    return html`
      <details
        class="tnode kind-${n.kind} status-${n.status}"
        ?open=${defaultOpen}
      >
        <summary class="tnode-head">
          <span class="tdot"></span>
          <span class="tlabel">${escapeHtml(n.label)}</span>
          ${n.status === 'error'
            ? html`<span class="tbadge err">失败</span>`
            : nothing}
          ${n.status === 'pending'
            ? html`<span class="tbadge pend">进行中</span>`
            : nothing}
          ${n.meta
            ? html`<span class="tchips"
                >${Object.entries(n.meta).map(
                  ([k, v]) =>
                    html`<span class="tchip"
                      ><b>${escapeHtml(k)}</b> ${escapeHtml(v)}</span
                    >`
                )}</span
              >`
            : nothing}
        </summary>
        ${hasDetail
          ? html`<pre class="tdetail">${formatToolJson(n.detail!)}</pre>`
          : nothing}
        ${hasResult
          ? html`<div class="tresult ${isRetrieval ? 'retrieval' : ''}">
              ${isRetrieval
                ? html`<div class="tres-title">检索内容</div>`
                : nothing}${formatToolJson(n.result!)}
            </div>`
          : nothing}
        ${n.children.length
          ? html`<div class="tchildren">
              ${n.children.map((c) => this.renderTraceNode(c))}
            </div>`
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
    const cacheNode = flat.find((n) => n.kind === 'tokencache');
    const meta = root.meta ?? {};
    return {
      model: meta.model,
      agent: meta.agent,
      mode: meta.mode,
      steps,
      toolCount: tools.length + retrievals.length,
      costTokens: cost?.meta?.tokens,
      costValue: cost?.meta?.cost,
      costPriced: cost?.meta?.priced,
      cacheHitRate: cacheNode?.meta?.命中率,
      cacheHits: cacheNode?.meta?.命中,
      costBreakdown: this.parseCostBreakdown(cost?.meta),
      retrievals: retrievals.map((n) => ({
        label: n.label,
        result: n.result ?? ''
      }))
    };
  }

  /**
   * 从 cost 节点的 meta 解析「系统 / 工具 / 历史 / 输出」四项 token 占比。
   * meta 中 工具/历史 的值形如 "320 (45%)"，系统/输出 为纯数字；这里统一提取数字与百分比。
   */
  private parseCostBreakdown(
    meta?: Record<string, string>
  ): Insights['costBreakdown'] {
    if (!meta) return undefined;
    const order: Array<[string, string]> = [
      ['系统', 'system'],
      ['工具', 'tools'],
      ['历史', 'history'],
      ['输出', 'completion']
    ];
    const out: Array<{ label: string; tokens: number; pct: number }> = [];
    for (const [cn, _] of order) {
      const raw = meta[cn];
      if (raw == null) continue;
      const num = parseInt(raw, 10);
      if (Number.isNaN(num)) continue;
      const pctMatch = raw.match(/\((\d+)%\)/);
      const pct = pctMatch ? Number(pctMatch[1]) : 0;
      out.push({ label: cn, tokens: num, pct });
    }
    return out.length ? out : undefined;
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
    push('缓存命中率', ins.cacheHitRate);
    // cost=0 时区分「已定价的免费模型」与「未定价模型」，避免 UI 上 $0.0000 看起来像 bug。
    const costRaw = ins.costValue ?? '';
    const priced = ins.costPriced === 'true';
    const isZero =
      costRaw === '$0.0000' || costRaw === '$0.00' || costRaw === '$0';
    push(
      '成本',
      costRaw ? (isZero ? (priced ? '免费' : '未定价') : costRaw) : undefined
    );
    return html`
      <div class="insights-title">关键信息</div>
      <div class="ins-grid">
        ${stats.map(
          ([k, v]) => html`<div class="ins-item">
            <span class="ins-k">${escapeHtml(k)}</span
            ><span class="ins-v">${escapeHtml(v)}</span>
          </div>`
        )}
      </div>
      ${ins.costBreakdown
        ? html`<div class="ins-breakdown">
            <div class="ins-bd-title">Token 拆解</div>
            <div class="ins-bd-bars">
              ${ins.costBreakdown.map(
                (b) => html`<div class="ins-bd-row">
                  <div class="ins-bd-head">
                    <span class="ins-bd-name">${escapeHtml(b.label)}</span>
                    <span class="ins-bd-val"
                      >${escapeHtml(String(b.tokens))} tok ·
                      ${escapeHtml(String(b.pct))}%</span
                    >
                  </div>
                  <div class="ins-bd-track">
                    <div
                      class="ins-bd-fill"
                      style=${`width:${Math.max(2, b.pct)}%`}
                    ></div>
                  </div>
                </div>`
              )}
            </div>
          </div>`
        : nothing}
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
      <div class="sidebar ${this.sidebarOpen ? 'open' : ''}">
        <div class="side-head">
          <button class="primary new-btn" @click=${() => this.newChat()}>
            ＋ 新对话
          </button>
        </div>
        <div class="session-list">
          ${this.sessions.length === 0
            ? html`<p class="muted">暂无会话，发送消息即自动创建。</p>`
            : this.sessions.map(
                (s) => html`
                  <div
                    class="session ${s.id === this.activeId ? 'active' : ''}"
                    @click=${() => this.selectSession(s.id)}
                  >
                    <span class="dot"></span>
                    <span class="title">${escapeHtml(s.title)}</span>
                    <span class="acts">
                      <button
                        class="icon-btn"
                        title="重命名"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          this.renameSession(s.id);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        class="icon-btn"
                        title="删除"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          this.deleteSession(s.id);
                        }}
                      >
                        🗑
                      </button>
                    </span>
                  </div>
                `
              )}
        </div>
      </div>

      <div class="main">
        <div class="chat-head">
          <button
            class="menu-btn"
            @click=${() => this.toggleSidebar()}
            title="菜单 / 会话列表"
          >
            ☰
          </button>
          <span class="title"
            >${active ? escapeHtml(active.title) : '新对话'}</span
          >
          <span class="spacer"></span>
          <input
            class="model-input"
            placeholder="模型（留空用服务端默认）"
            .value=${this.model}
            @input=${(e: Event) =>
              (this.model = (e.target as HTMLInputElement).value)}
          />
          <select
            class="agent-select"
            title="选择业务 Agent（默认走通用 Agent）"
            style="margin-left:8px;height:32px;max-width:180px;border-radius:8px;border:1px solid var(--ah-border);background:var(--ah-surface-2);color:var(--ah-text);padding:0 6px"
            .value=${this.agentId}
            @change=${(e: Event) =>
              (this.agentId = (e.target as HTMLSelectElement).value)}
          >
            ${this.agents.map(
              (a) => html`<option value=${a.id}>${escapeHtml(a.name)}</option>`
            )}
          </select>
          <button
            class="toggle ${this.deepThink ? 'on' : ''}"
            title="深度思考"
            aria-label="深度思考"
            @click=${() => (this.deepThink = !this.deepThink)}
          >
            <svg
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
          </button>
          <button
            class="toggle ${this.web ? 'on' : ''}"
            title="联网搜索（开发中）"
            aria-label="联网搜索（开发中）"
            @click=${() => (this.web = !this.web)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path
                d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"
              />
            </svg>
          </button>
          <button
            class="ctx-usage"
            title="上下文用量"
            aria-label="上下文用量"
            @click=${() => (this.showCtxUsage = !this.showCtxUsage)}
          >
            <span class="ctx-pct">${this.displayContextUsage().totalPct.toFixed(1)}%</span>
            <span class="ctx-bar"
              ><span
                class="ctx-fill"
                style="width:${Math.min(100, this.displayContextUsage().totalPct)}%"
              ></span
            ></span>
          </button>
          ${this.showCtxUsage
            ? html`<div class="ctx-pop">
                <div class="ctx-pop-head">
                  <span>上下文用量</span>
                  <span class="ctx-pop-total"
                    >${this.displayContextUsage().totalTokens.toLocaleString()}
                    / ${(this.displayContextUsage().window / 1000).toFixed(0)}K</span
                  >
                </div>
                <div class="ctx-seg">
                  ${this.displayContextUsage().items.map(
                    (it) => html`<span
                      class="ctx-seg-i ${it.cls}"
                      style="width:${it.pct}%"
                      title="${it.label} ${it.pct.toFixed(1)}%"
                    ></span>`
                  )}
                </div>
                <ul class="ctx-list">
                  ${this.displayContextUsage().items.map(
                    (it) => html`<li>
                      <span class="ctx-dot ${it.cls}"></span>
                      <span class="ctx-label">${it.label}</span>
                      <span class="ctx-val">${it.pct.toFixed(1)}%</span>
                    </li>`
                  )}
                </ul>
              </div>`
            : nothing}
        </div>

        <div class="scroll-region">
          <div class="scroll" ${ref(this.scrollRef)} @scroll=${this.onScroll}>
          ${this.messages.length === 0
            ? html`
                <div class="empty">
                  <h1>有什么可以帮你的？</h1>
                  <p>
                    基于 agent-harness
                    的多会话对话。下方输入即可开始，右侧可新建 / 切换会话。
                  </p>
                </div>
              `
            : html`<div class="thread">
                ${this.messages.map((m) => this.renderMessage(m))}
              </div>`}
          </div>
          ${this.showScrollDown
            ? html`<button
                class="scroll-down"
                title="回到底部"
                aria-label="回到底部"
                @click=${() => this.scrollToBottomSmooth()}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 5v14M19 12l-7 7-7-7" />
                </svg>
              </button>`
            : nothing}
        </div>

        <div class="composer-wrap">
          <div class="composer">
            ${this.attachments.length > 0
              ? html`<div class="attachments-preview">
                  ${this.attachments.map(
                    (f, i) => html`
                      <div
                        class="attach-preview-item ${f.uploadStatus === 'error'
                          ? 'error'
                          : ''} ${this.isPreviewable(f) ? 'is-image' : ''}"
                        @click=${() => this.openPreview(f)}
                      >
                        ${f.type.startsWith('image/')
                          ? html`<img
                              src=${f.dataUrl}
                              alt=${escapeHtml(f.name)}
                              class="attach-thumb"
                            />`
                          : html`<span class="attach-icon"
                              >${this.fileIcon(f)}</span
                            >`}
                        <span class="attach-name" title=${f.name}
                          >${escapeHtml(f.name)}</span
                        >
                        ${f.uploadStatus === 'uploading'
                          ? html`<span
                              class="attach-status uploading"
                              title="上传中"
                              >⏳</span
                            >`
                          : f.uploadStatus === 'done'
                          ? html`<span class="attach-status done" title="已上传"
                              >✓</span
                            >`
                          : f.uploadStatus === 'error'
                          ? html`<span
                              class="attach-err"
                              title=${f.uploadError || '上传失败'}
                            ></span>`
                          : nothing}
                        <button
                          type="button"
                          class="attach-rm"
                          title="移除"
                          @click=${(e: Event) => {
                            // 阻止冒泡到外层卡片的 openPreview（点删除不应触发预览）。
                            e.stopPropagation();
                            this.removeAttachment(i);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    `
                  )}
                </div>`
              : nothing}
            <div class="composer-body">
              <textarea
                rows="1"
                placeholder="给 Agent 发送消息…（Enter 发送，Shift+Enter 换行）"
                .value=${this.input}
                ?disabled=${this.streaming[this.activeId] === true}
                @input=${this.onInput}
                @keydown=${this.onKey}
              ></textarea>
            </div>
            <div class="composer-footer">
              <label class="attach-btn" title="上传附件">
                <input
                  type="file"
                  multiple
                  accept="image/*,.txt,.md,.csv,.json"
                  style="display:none"
                  @change=${this.onFileSelect}
                />
                +
              </label>
              ${this.streaming[this.activeId] === true
                ? html`<button
                    class="send"
                    title="停止"
                    @click=${() => this.stop()}
                  >
                    ■
                  </button>`
                : html`<button
                    class="send"
                    title="发送"
                    ?disabled=${!this.input.trim()}
                    @click=${() => this.send()}
                  >
                    ↑
                  </button>`}
            </div>
          </div>
          <!-- <div class="hint">
            模式：${this.mode} ·
            token 级流式已开启（打字机效果）· 深度思考/联网为 UI 占位
          </div> -->
        </div>
      </div>

      <div
        class="scrim ${this.sidebarOpen ? 'show' : ''}"
        @click=${() => (this.sidebarOpen = false)}
      ></div>
      ${this.previewFile
        ? html`<div class="lightbox" @click=${() => this.closePreview()}>
            <button
              class="lightbox-close"
              title="关闭 (Esc)"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.closePreview();
              }}
            >
              ×
            </button>
            <img
              src=${this.previewFile.dataUrl}
              alt=${escapeHtml(this.previewFile.name)}
              @click=${(e: Event) => e.stopPropagation()}
            />
            <div class="lightbox-info">
              ${escapeHtml(this.previewFile.name)} ·
              ${this.formatSize(this.previewFile.size)}
            </div>
          </div>`
        : nothing}
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
function parseDeepThinking(raw: string): {
  text: string;
  vars: Array<[string, string]>;
} {
  if (!raw || !raw.trim()) return { text: '', vars: [] };
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim());
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
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
