/**
 * composer-plus：输入框「+」入口 —— 一个按钮收口三类输入增强能力。
 *
 * 背景：原先 composer 底部工具栏把「上传 / 模式 / 专家」拆成三个并排控件
 * （.attach-btn + ah-agent-picker + ah-mode-picker），首屏占位长、移动端拥挤。
 * 本组件改为单一「+」触发按钮 + 向上弹出的分区面板：
 *
 *   1. 文件 —— 点击选择 / 拖拽上传（真实上传仍由宿主的 handleFiles 执行）
 *   2. 模式 —— 问答 Ask / 计划 Plan 二选一
 *   3. 专家 —— 已有智能体列表（按 domain 分组）
 *
 * 关键约定（与宿主 chat.ts 的职责边界）：
 * - 本组件不持有业务状态：mode / agentId / attachments 全部由宿主透传，
 *   选择结果经 `mode-change` / `agent-change` / `files-select` / `remove-attachment`
 *   事件上抛，宿主写回 @state 并持久化。
 * - **选择结果常驻展示在 + 按钮紧邻的胶囊上**（而非只在面板里打勾），
 *   保证「关掉面板也看得到当前上下文一致」。胶囊本身可点击，
 *   直接把面板打开并定位到对应分区 —— 少一次点击。
 *
 * 移动端（≤600px）：面板收窄为 calc(100vw - 28px)、高度限 60vh 内部滚动，
 * 胶囊做省略号截断，保证 footer 不换行、不被右侧模型选择器挤爆。
 */
import { LitElement, html, css, nothing, type CSSResultGroup } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import type { UploadedFile } from '../agent-context';

/** 宿主传入的智能体条目（与 agent-picker 的 AgentOption 保持一致）。 */
export interface ComposerAgentOption {
  id: string;
  name: string;
  /** 行业领域 / 分类标签（用于分组展示）。 */
  domain?: string;
}

/** 运行模式定义：值与宿主 interactionMode 对齐。 */
interface ModeItem {
  value: 'qa' | 'plan';
  /** 胶囊上的短名。 */
  label: string;
  /** 面板卡片标题。 */
  title: string;
  /** 一句话说明，帮用户区分两种模式。 */
  desc: string;
  iconPath: string;
}

const MODES: ModeItem[] = [
  {
    value: 'qa',
    label: 'Ask',
    title: '问答',
    desc: '直接给出答案，适合快速提问',
    // 对话气泡
    iconPath:
      'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'
  },
  {
    value: 'plan',
    label: 'Plan',
    title: '计划',
    desc: '先产出执行计划，确认后逐步执行',
    // 剪贴板清单
    iconPath:
      'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9l2 2 4-4'
  }
];

/** 兜底模式：mode 属性拿到非法值时的回落（问答 Ask）。 */
const DEFAULT_MODE: ModeItem = MODES[0]!;

/** 领域 → 中文分组标题。 */
const domainLabels: Record<string, string> = {
  'medical-aesthetics': '医美运营分析',
  finance: '金融',
  healthcare: '医疗',
  education: '教育',
  generic: '通用'
};

const BOT_ICON =
  'M12 2v2m0 0a2 2 0 0 1 2 2h-4a2 2 0 0 1 2-2zM8 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2M9 13h.01M15 13h.01M9.5 16.5h5';

const CLIP_ICON =
  'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48';

/** 非图片附件在面板文件列表里用的通用文件图标。 */
const FILE_ICON = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6';

@customElement('ah-composer-plus')
export class AhComposerPlus extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      /* 面板的定位上下文（left:0 即对齐 + 按钮左边缘）。
         不可加 transform —— 会让内部 position:fixed 的遮罩改以本元素为包含块。 */
      position: relative;
      min-width: 0;
      max-width: 100%;
    }

    /* ---------- 触发按钮 ---------- */
    .plus {
      appearance: none;
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-3);
      color: var(--ah-text-muted);
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition:
        color 0.15s ease,
        background 0.15s ease,
        border-color 0.15s ease,
        transform 0.18s ease;
    }
    .plus svg {
      width: 15px;
      height: 15px;
      display: block;
    }
    .plus:hover {
      color: var(--ah-accent, #2997ff);
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 45%,
        var(--ah-border)
      );
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 12%,
        transparent
      );
    }
    /* 展开时 + 旋转成 ×：一个按钮承担开/关两种语义，不用额外画图标 */
    .plus.open {
      transform: rotate(45deg);
      color: var(--ah-accent, #2997ff);
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 55%,
        var(--ah-border)
      );
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 16%,
        transparent
      );
    }

    /* ---------- 常驻结果胶囊（+ 紧邻右侧） ---------- */
    .chips {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      overflow: hidden;
    }
    /* 只读状态胶囊：仅作展示，不响应任何交互。
       cursor: default（不用 pointer，避免误导为可点击）+ 无 hover 反馈；
       user-select: none 让它在整块 composer 里不会因为拖选文字被选中。
       注意：.chips 上的 pointer-events 不做 none —— 那样会让 title 悬浮提示
       和「附件」胶囊的省略号信息也一并失效，反而不如保留原生 tooltip。 */
    .chip {
      appearance: none;
      border: none;
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 500;
      height: 24px;
      padding: 0 9px;
      border-radius: var(--ah-radius-pill, 999px);
      cursor: default;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 128px;
      min-width: 0;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .chip svg {
      width: 12px;
      height: 12px;
      flex: 0 0 auto;
    }
    .chip .txt {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    /* 模式胶囊：Ask=青绿 / Plan=紫，与面板内卡片同色系。
       ⚠️ 类名必须跟 mode 的取值（'qa' / 'plan'）严格一致 ——
       写成 .chip.mode-ask 会永远匹配不上模板生成的 mode-qa，
       胶囊丢掉底色与文字色，图标也就跟着淹没在背景里。 */
    .chip.mode-qa {
      background: rgba(40, 184, 148, 0.18);
      color: rgb(40, 184, 148);
    }
    .chip.mode-plan {
      background: rgba(108, 77, 255, 0.2);
      color: rgb(169, 151, 255);
    }
    .chip.agent {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 14%,
        transparent
      );
      color: var(--ah-accent, #2997ff);
    }
    .chip.file {
      background: var(--ah-surface-3);
      color: var(--ah-text-muted);
    }

    /* ---------- 面板 ---------- */
    .panel {
      position: absolute;
      left: 0;
      bottom: calc(100% + 10px);
      z-index: 60;
      width: 320px;
      max-width: calc(100vw - 28px);
      /* absolute 同样是「已定位祖先」，故 .sec 的 offsetTop 以本元素为基准，
         scrollTop 定位可直接用 —— 不要再写 position:relative 覆盖掉绝对定位。 */
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg, 16px);
      box-shadow: 0 12px 38px rgba(0, 0, 0, 0.34);
      padding: 8px;
      box-sizing: border-box;
      max-height: min(60vh, 440px);
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      animation: pop-in 0.16s ease-out;
    }
    @keyframes pop-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    /* 尊重「减少动效」系统偏好 */
    @media (prefers-reduced-motion: reduce) {
      .panel {
        animation: none;
      }
    }

    .sec {
      padding: 4px 4px 8px;
      border-radius: 10px;
    }
    .sec + .sec {
      margin-top: 4px;
      border-top: 1px solid var(--ah-border);
      padding-top: 10px;
    }
    .sec-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: var(--ah-text-muted);
      text-transform: uppercase;
      padding: 0 6px 7px;
    }

    /* --- 分区 1：文件 --- */
    .drop {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 14px 10px;
      border: 1px dashed var(--ah-border);
      border-radius: 10px;
      background: var(--ah-surface-2);
      color: var(--ah-text-muted);
      cursor: pointer;
      text-align: center;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
    }
    .drop:hover {
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 55%,
        var(--ah-border)
      );
      color: var(--ah-text);
    }
    .drop svg {
      width: 20px;
      height: 20px;
    }
    /* 子元素不吃指针事件：拖拽高亮不再由本组件负责，但保留此规则可避免
       光标落在 <span>/<svg> 上时点击热区判定抖动（一致命中 .drop 本体）。 */
    .drop > * {
      pointer-events: none;
    }
    .drop .t1 {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--ah-text);
    }
    .drop .t2 {
      font-size: 11px;
      color: var(--ah-text-faint, var(--ah-text-muted));
    }

    .file-list {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    /* 文件行沿用 composer 顶部 .attach-preview-item 的视觉语言：
       surface-3 卡片 + 1px 边框 + 12px 圆角 + 圆形缩略图，两处观感一致。 */
    .file-row {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 4px 6px;
      border-radius: 12px;
      background: var(--ah-surface-3);
      border: 1px solid var(--ah-border);
      font-size: 11.5px;
      color: var(--ah-text);
      min-width: 0;
      transition: background 0.18s ease, border-color 0.18s ease;
    }
    .file-row:hover {
      background: var(--ah-surface-2);
    }
    /* 图片附件：圆形缩略图（对齐原 .attach-thumb 的 border-radius:50% + cover） */
    .file-row .fthumb {
      flex: 0 0 auto;
      width: 20px;
      height: 20px;
      object-fit: cover;
      border-radius: 50%;
      display: block;
      background: var(--ah-surface-2);
    }
    /* 非图片附件：圆角方块 + 线性文件图标（对齐原 .attach-icon 的容器观感） */
    .file-row .fthumb-file {
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      border-radius: 7px;
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-2);
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--ah-text-muted);
    }
    .file-row .fthumb-file svg {
      width: 13px;
      height: 13px;
    }
    .file-row .fname {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-row .fstate {
      flex: 0 0 auto;
      font-size: 11px;
    }
    .file-row .fstate.done {
      color: var(--ah-success, #30d158);
    }
    .file-row .fstate.error {
      color: var(--ah-danger, #ff453a);
    }
    .file-row .frm {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--ah-text-muted);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
      flex: 0 0 auto;
    }
    .file-row .frm:hover {
      color: var(--ah-danger, #ff453a);
    }

    /* --- 分区 2：模式（两张卡片并排） --- */
    .mode-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .mode-card {
      appearance: none;
      font-family: inherit;
      text-align: left;
      border: 1px solid var(--ah-border);
      background: var(--ah-surface-2);
      border-radius: 10px;
      padding: 9px 10px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 3px;
      color: var(--ah-text);
      transition: border-color 0.15s, background 0.15s;
      position: relative;
      min-width: 0;
    }
    .mode-card:hover {
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 45%,
        var(--ah-border)
      );
    }
    .mode-card svg {
      width: 16px;
      height: 16px;
      color: var(--ah-text-muted);
    }
    .mode-card .mt {
      font-size: 12.5px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .mode-card .md {
      font-size: 10.5px;
      line-height: 1.4;
      color: var(--ah-text-muted);
    }
    .mode-card.qa.sel {
      border-color: rgb(40, 184, 148);
      background: rgba(40, 184, 148, 0.12);
    }
    .mode-card.qa.sel svg,
    .mode-card.qa.sel .mt {
      color: rgb(40, 184, 148);
    }
    .mode-card.plan.sel {
      border-color: rgb(169, 151, 255);
      background: rgba(108, 77, 255, 0.14);
    }
    .mode-card.plan.sel svg,
    .mode-card.plan.sel .mt {
      color: rgb(169, 151, 255);
    }
    .mode-card .tick {
      position: absolute;
      top: 7px;
      right: 8px;
      font-size: 11px;
    }

    /* --- 分区 3：专家 --- */
    .agent-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 176px;
      overflow-y: auto;
      scrollbar-width: thin;
    }
    .agent-item {
      appearance: none;
      font-family: inherit;
      text-align: left;
      border: none;
      background: transparent;
      border-radius: 8px;
      padding: 6px 9px;
      font-size: 12px;
      color: var(--ah-text);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      transition: background 0.12s;
    }
    .agent-item:hover {
      background: color-mix(
        in srgb,
        var(--ah-text-muted, #999) 12%,
        transparent
      );
    }
    .agent-item.sel {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 14%,
        transparent
      );
    }
    .agent-item svg {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
      color: var(--ah-text-muted);
    }
    .agent-item.sel svg {
      color: var(--ah-accent, #2997ff);
    }
    .agent-item .aname {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agent-item .chk {
      flex: 0 0 auto;
      color: var(--ah-accent, #2997ff);
      font-size: 12px;
    }
    .group-label {
      padding: 6px 9px 2px;
      font-size: 10px;
      font-weight: 600;
      color: var(--ah-text-faint, var(--ah-text-muted));
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .empty {
      padding: 8px 9px;
      font-size: 11.5px;
      color: var(--ah-text-faint, var(--ah-text-muted));
    }

    /* ---------- 遮罩：点击空白处关闭（移动端友好） ---------- */
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 50;
      width: 100%;
      height: 100%;
      background: transparent;
      border: none;
      padding: 0;
      cursor: default;
    }

    /* ---------- 移动端（≤600px） ---------- */
    @media (max-width: 600px) {
      :host {
        gap: 4px;
      }
      .plus {
        width: 32px;
        height: 32px;
      }
      .chips {
        max-width: calc(100vw - 190px);
      }
      .chip {
        max-width: 92px;
        padding: 0 8px;
        font-size: 11px;
      }
      .panel {
        width: calc(100vw - 28px);
        max-width: 340px;
        max-height: min(56vh, 400px);
        bottom: calc(100% + 8px);
        padding: 6px;
      }
      .mode-grid {
        grid-template-columns: 1fr 1fr;
      }
      .agent-list {
        max-height: 150px;
      }
    }
  ` as CSSResultGroup;

  /** 可选智能体列表（由宿主持有）。 */
  @property({ attribute: false }) agents: ComposerAgentOption[] = [];

  /** 当前选中的智能体 id。 */
  @property({ type: String }) agentId = '';

  /** 当前运行模式。 */
  @property({ type: String }) mode: 'qa' | 'plan' = 'qa';

  /** 已添加附件（面板内展示进度 / 可移除）。 */
  @property({ attribute: false }) attachments: UploadedFile[] = [];

  /** 文件选择框的 accept（与宿主原 attach-btn 保持一致）。 */
  @property({ type: String }) accept = 'image/*,.txt,.md,.csv,.json';

  @state() private open = false;

  @query('input[type=file]') private fileInputEl?: HTMLInputElement | null;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.onDocKey, true);
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onDocKey, true);
    super.disconnectedCallback();
  }

  /** Esc 关闭面板（捕获阶段，避免被输入框的键盘处理吃掉）。 */
  private onDocKey = (e: KeyboardEvent): void => {
    if (this.open && e.key === 'Escape') {
      e.stopPropagation();
      this.open = false;
    }
  };

  /* --------------------------- 面板开合 --------------------------- */

  private toggle(): void {
    this.open = !this.open;
  }

  /* --------------------------- 选择回调 --------------------------- */

  private selectMode(v: 'qa' | 'plan'): void {
    if (v !== this.mode) {
      this.dispatchEvent(
        new CustomEvent('mode-change', {
          detail: { value: v },
          bubbles: true,
          composed: true
        })
      );
    }
    // 选完即收起：结果已固化到 + 旁的胶囊上，无需用户再点一次空白。
    this.open = false;
  }

  private selectAgent(id: string): void {
    if (id !== this.agentId) {
      this.dispatchEvent(
        new CustomEvent('agent-change', {
          detail: { value: id },
          bubbles: true,
          composed: true
        })
      );
    }
    this.open = false;
  }

  /* --------------------------- 文件区 --------------------------- */

  private pickFile(): void {
    this.fileInputEl?.click();
  }

  private onPicked(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    // 立刻清空 value：否则连续选同一个文件不会再触发 change。
    input.value = '';
    if (files.length) this.emitFiles(files);
  }

  private emitFiles(files: File[]): void {
    this.dispatchEvent(
      new CustomEvent('files-select', {
        detail: { files },
        bubbles: true,
        composed: true
      })
    );
    this.open = false;
  }

  private removeFile(index: number): void {
    this.dispatchEvent(
      new CustomEvent('remove-attachment', {
        detail: { index },
        bubbles: true,
        composed: true
      })
    );
  }

  /* --------------------------- 渲染 --------------------------- */

  /** 专家按 domain 分组（无 domain / generic 归入「通用」置顶）。 */
  private get groupedAgents(): {
    label: string | null;
    items: ComposerAgentOption[];
  }[] {
    const groups: { label: string | null; items: ComposerAgentOption[] }[] = [];
    const generic: ComposerAgentOption[] = [];
    const byDomain = new Map<string, ComposerAgentOption[]>();
    for (const a of this.agents) {
      if (!a.domain || a.domain === 'generic') {
        generic.push(a);
      } else {
        const arr = byDomain.get(a.domain) ?? [];
        arr.push(a);
        byDomain.set(a.domain, arr);
      }
    }
    if (generic.length) groups.push({ label: null, items: generic });
    for (const [domain, items] of byDomain) {
      groups.push({ label: domainLabels[domain] ?? domain, items });
    }
    return groups;
  }

  private get currentMode(): ModeItem {
    // 注意：tsconfig 开了 noUncheckedIndexedAccess，MODES[0] 的类型是
    // `ModeItem | undefined`，不能直接当兜底返回 —— 这里显式取常量。
    return MODES.find((m) => m.value === this.mode) ?? DEFAULT_MODE;
  }

  private get currentAgentName(): string {
    return this.agents.find((a) => a.id === this.agentId)?.name ?? '默认';
  }

  private icon(path: string, cls = '') {
    return html`<svg
      class=${cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d=${path} />
    </svg>`;
  }

  render() {
    const mode = this.currentMode;
    const fileCount = this.attachments.length;

    return html`
      <button
        class="plus ${this.open ? 'open' : ''}"
        title="添加文件 / 切换模式 / 选择专家"
        aria-label="更多输入选项"
        aria-haspopup="dialog"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => this.toggle()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      <!-- 常驻结果胶囊：**纯展示**，只反映当前模式 / 专家 / 附件数。
           用 <span> 而非 <button>：它们不再触发任何交互（切换请走左侧「+」面板），
           也拿掉了 chevron —— 箭头会暗示「可点开」，与只读定位矛盾。
           role="status" + aria-live 让屏幕阅读器在切换后播报新状态。 -->
      <div class="chips" role="status" aria-live="polite">
        <span
          class="chip mode-${mode.value}"
          title="运行模式：${mode.title} · ${mode.desc}"
        >
          ${this.icon(mode.iconPath)}
          <span class="txt">${mode.label}</span>
        </span>
        <span class="chip agent" title="当前专家：${this.currentAgentName}">
          ${this.icon(BOT_ICON)}
          <span class="txt">${this.currentAgentName}</span>
        </span>
        ${fileCount > 0
          ? html`<span class="chip file" title="已添加 ${fileCount} 个附件">
              ${this.icon(CLIP_ICON)}
              <span class="txt">${fileCount}</span>
            </span>`
          : nothing}
      </div>

      ${this.open
        ? html`
            <button
              class="scrim"
              aria-label="关闭输入选项面板"
              @click=${() => (this.open = false)}
            ></button>
            <div class="panel" role="dialog" aria-label="输入选项">
              <!-- 分区 1：文件 -->
              <div class="sec" data-sec="file">
                <div class="sec-title">文件</div>
                <!-- 点击区只负责「唤起选择器」；拖拽改由 ah-chat 全区域统一接管
                     （见 chat.ts 的整屏拖拽遮罩），故这里不再挂 dragover/drop。 -->
                <div
                  class="drop"
                  role="button"
                  tabindex="0"
                  @click=${() => this.pickFile()}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      this.pickFile();
                    }
                  }}
                >
                  ${this.icon(CLIP_ICON)}
                  <span class="t1">点击选择图片上传</span>
                  <span class="t2">支持图片、文本与 JSON · 单个 ≤ 10MB</span>
                </div>
                <input
                  type="file"
                  multiple
                  accept=${this.accept}
                  style="display:none"
                  @change=${this.onPicked}
                />
                ${fileCount > 0
                  ? html`<div class="file-list">
                      ${this.attachments.map(
                        (f, i) => html`
                          <div class="file-row">
                            ${f.type.startsWith('image/')
                              ? html`<img
                                  class="fthumb"
                                  src=${f.dataUrl}
                                  alt=""
                                />`
                              : html`<span class="fthumb-file"
                                  >${this.icon(FILE_ICON)}</span
                                >`}
                            <span class="fname" title=${f.name}>${f.name}</span>
                            ${f.uploadStatus === 'done'
                              ? html`<span class="fstate done" title="已上传"
                                  >✓</span
                                >`
                              : f.uploadStatus === 'error'
                                ? html`<span
                                    class="fstate error"
                                    title=${f.uploadError || '上传失败'}
                                    >!</span
                                  >`
                                : html`<span class="fstate" title="上传中"
                                    >⏳</span
                                  >`}
                            <button
                              type="button"
                              class="frm"
                              title="移除"
                              aria-label="移除 ${f.name}"
                              @click=${() => this.removeFile(i)}
                            >
                              ×
                            </button>
                          </div>
                        `
                      )}
                    </div>`
                  : nothing}
              </div>

              <!-- 分区 2：模式 -->
              <div class="sec" data-sec="mode">
                <div class="sec-title">模式</div>
                <div class="mode-grid" role="radiogroup" aria-label="运行模式">
                  ${MODES.map(
                    (m) => html`
                      <button
                        type="button"
                        class="mode-card ${m.value} ${this.mode === m.value
                          ? 'sel'
                          : ''}"
                        role="radio"
                        aria-checked=${this.mode === m.value ? 'true' : 'false'}
                        @click=${() => this.selectMode(m.value)}
                      >
                        ${this.icon(m.iconPath)}
                        <span class="mt">${m.title} ${m.label}</span>
                        <span class="md">${m.desc}</span>
                        ${this.mode === m.value
                          ? html`<span class="tick">✓</span>`
                          : nothing}
                      </button>
                    `
                  )}
                </div>
              </div>

              <!-- 分区 3：专家 -->
              <div class="sec" data-sec="agent">
                <div class="sec-title">专家</div>
                ${this.agents.length === 0
                  ? html`<div class="empty">暂无可用专家，将使用默认智能体</div>`
                  : html`<div class="agent-list" role="listbox" aria-label="专家">
                      ${this.groupedAgents.map(
                        (g) => html`
                          ${g.label
                            ? html`<div class="group-label">${g.label}</div>`
                            : nothing}
                          ${g.items.map(
                            (a) => html`
                              <button
                                type="button"
                                class="agent-item ${this.agentId === a.id
                                  ? 'sel'
                                  : ''}"
                                role="option"
                                aria-selected=${this.agentId === a.id
                                  ? 'true'
                                  : 'false'}
                                title=${a.name}
                                @click=${() => this.selectAgent(a.id)}
                              >
                                ${this.icon(BOT_ICON)}
                                <span class="aname">${a.name}</span>
                                ${this.agentId === a.id
                                  ? html`<span class="chk">✓</span>`
                                  : nothing}
                              </button>
                            `
                          )}
                        `
                      )}
                    </div>`}
              </div>
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-composer-plus': AhComposerPlus;
  }
}
