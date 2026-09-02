/**
 * Slash Command 联想 + 选中胶囊组件。
 *
 * ── 职责边界 ────────────────────────────────────────────────────────
 * 组件只做两件事，命令的「执行」仍在宿主的 chat-commands 框架里：
 *   1. 联想：输入框以 `/` 开头时，按功能分组展示可用命令（点击 / 键盘选中）。
 *   2. 胶囊：命令被选中后，在输入框上方以胶囊（tag）形式固化展示，
 *      悬停 / 聚焦显示 × 删除，退回普通输入态。
 *
 * ── 模块结构（自上而下，单向依赖）──────────────────────────────────
 *   ① 元数据层  COMMAND_ICONS / COMMAND_GROUPS    命令的展示信息
 *   ② 匹配层    scoreCommand / filterCommands / groupCommands  纯函数
 *   ③ 状态层    value / selected / activeIndex / dismissed
 *   ④ 交互层    handleKey / select / remove / dismiss
 *   ⑤ 视图层    renderChipBar / renderPanel / renderHeader / renderGroup …
 *
 * ── 视觉约定 ────────────────────────────────────────────────────────
 * 与 ah-agent-picker / ah-mode-picker 同族：surface-1 面板 + border +
 * radius-lg + shadow，条目为「线性 SVG 图标 + 名称 + 描述 + 别名 pill」，
 * 高亮走 --ah-accent-soft。所有色值只引用 --ah-* 令牌，不写死颜色。
 *
 * 注意：组件是 LitElement + shadow DOM（`static styles`），
 * 面板 / 胶囊的样式必须写在本文件的 static styles 内，
 * 不能依赖 chat-styles.ts 的 light DOM 选择器（CSS 不穿透 shadow 边界）。
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  getCommands,
  parseCommand,
  type SlashCommand
} from '../chat-commands';

/* ==================================================================
 * ① 元数据层：命令的展示信息（图标 / 分组）
 * ================================================================== */

/** 通用命令图标（终端箭头）—— 未单独配置的命令与面板标题共用。 */
const ICON_TERMINAL = 'M4 17l6-6-6-6M12 19h8';

/**
 * 命令图标：24×24 线性图标的 path，与 mode-picker / agent-picker 同一套
 * 视觉语言（stroke=currentColor、fill=none）。未配置的命令回落到终端图标。
 */
const COMMAND_ICONS: Record<string, string> = {
  // 新会话：文档 +
  new: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 11v6M9 14h6',
  // 帮助：问号圆
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  // 联网：地球
  web: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  // 运行模式：滑杆
  mode: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  // 计划模式：剪贴板清单（与 mode-picker 的 Plan 图标一致）
  plan:
    'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9l2 2 4-4',
  // 复制
  copy:
    'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  // 导出：外链
  export: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
  // 停止：方块
  stop: 'M6.5 6.5h11v11h-11z'
};

/**
 * 命令按职责分组（替代原先「按首字母」分组 —— 8 个命令按字母分只会产生
 * 噪音，按职责分才是用户脑中的目录）。未列出的命令归入末尾的「其他」。
 */
const COMMAND_GROUPS: { label: string; cmds: string[] }[] = [
  { label: '会话', cmds: ['new'] },
  { label: '模式', cmds: ['mode', 'plan', 'web'] },
  { label: '输出', cmds: ['copy', 'export'] },
  { label: '系统', cmds: ['help', 'stop'] }
];

/** 一个分组及其下的命令。 */
interface CommandGroup {
  label: string;
  items: SlashCommand[];
}

/* ==================================================================
 * ② 匹配层：纯函数，负责「输入 → 有序分组结果」
 * ================================================================== */

/**
 * 命令与查询词的相关度打分（0 = 不匹配）。
 * 优先级：名称精确 > 名称前缀 > 名称包含 > 别名精确 > 别名前缀 >
 * 别名包含 > 描述包含。别名与描述参与匹配，让 `/新对话`、`/清空` 也能命中。
 */
function scoreCommand(cmd: SlashCommand, query: string): number {
  if (!query) return 1; // 无查询词：全部命中，保持注册顺序
  const name = cmd.name.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;

  for (const alias of cmd.aliases ?? []) {
    const a = alias.toLowerCase();
    if (a === query) return 50;
    if (a.startsWith(query)) return 40;
    if (a.includes(query)) return 30;
  }
  return cmd.description.toLowerCase().includes(query) ? 10 : 0;
}

/** 按查询词过滤并按分数降序排列。 */
function filterCommands(query: string): SlashCommand[] {
  return getCommands()
    .map((cmd) => ({ cmd, score: scoreCommand(cmd, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
    .map((x) => x.cmd);
}

/** 按 COMMAND_GROUPS 的职责顺序分组；未分组命令归入「其他」。 */
function groupCommands(commands: SlashCommand[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  const rest: SlashCommand[] = [];
  const taken = new Set<string>();

  for (const g of COMMAND_GROUPS) {
    const items = commands.filter(
      (c) => g.cmds.includes(c.name) && !taken.has(c.name)
    );
    if (items.length === 0) continue;
    items.forEach((c) => taken.add(c.name));
    groups.push({ label: g.label, items });
  }
  for (const c of commands) if (!taken.has(c.name)) rest.push(c);
  if (rest.length > 0) groups.push({ label: '其他', items: rest });
  return groups;
}

/* ==================================================================
 * 组件
 * ================================================================== */

@customElement('ah-command-suggestions')
export class AhCommandSuggestions extends LitElement {
  static styles = css`
    /* 宿主不参与布局：两个子节点（胶囊条 / 面板）直接挂进宿主的
       flex 容器（.composer），胶囊条占位、面板绝对定位浮起。 */
    :host {
      display: contents;
    }

    /* ---------- 通用：线性图标 ---------- */
    svg.i {
      flex: 0 0 auto;
      display: block;
      width: 15px;
      height: 15px;
      stroke-width: 2;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* ---------- 通用：键位标记（header / 空态 / footer 共用一套） ---------- */
    kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: var(--ah-radius-sm, 8px);
      background: var(--ah-surface-3);
      border: 1px solid var(--ah-border);
      font-size: 10px;
      font-family: var(--ah-font-mono);
      color: var(--ah-text-muted);
      line-height: 1;
    }

    /* ================================================================
     * 胶囊条（选中固化区）
     * ================================================================ */
    .chip-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 8px 12px 2px;
    }
    .chip-hint {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 11px;
      color: var(--ah-text-faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* 胶囊本体：accent 系胶囊，与底部工具栏的 mode-picker 触发按钮同源 */
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: var(--ah-h-md, 26px);
      padding: 0 3px 0 9px;
      max-width: 100%;
      border-radius: var(--ah-radius-pill, 999px);
      background: var(--ah-accent-soft);
      border: 1px solid
        color-mix(in srgb, var(--ah-accent, #2997ff) 34%, transparent);
      color: var(--ah-accent, #2997ff);
      font-family: var(--ah-font-mono);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      transition: background 0.14s ease, border-color 0.14s ease;
    }
    .chip:hover {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 22%,
        transparent
      );
      border-color: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 55%,
        transparent
      );
    }
    .chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* 删除按钮：默认隐藏但保留占位宽度（避免 hover 时布局跳动），
       胶囊 hover 或按钮获得键盘焦点时淡入。 */
    .chip-x {
      appearance: none;
      border: none;
      background: transparent;
      padding: 0;
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      color: inherit;
      font-family: var(--ah-font-sans);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transform: scale(0.8);
      transition: opacity 0.12s ease, transform 0.12s ease,
        background 0.12s ease;
    }
    .chip:hover .chip-x,
    .chip:focus-within .chip-x {
      opacity: 1;
      transform: none;
    }
    .chip-x:hover {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 28%,
        transparent
      );
    }
    .chip-x:focus-visible {
      opacity: 1;
      transform: none;
      outline: 2px solid var(--ah-accent, #2997ff);
      outline-offset: 1px;
    }

    /* ================================================================
     * 联想面板
     * ================================================================ */
    .panel {
      position: absolute;
      /* 锚定 .composer（宿主容器需 position:relative）顶部之上 8px：
         整块浮在输入框上方，不遮挡上方消息区。 */
      left: 0;
      bottom: calc(100% + 8px);
      z-index: 60;
      width: min(340px, 100%);
      max-height: min(320px, 60vh);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 6px;
      box-sizing: border-box;
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg, 16px);
      box-shadow: var(--ah-shadow);
      scrollbar-width: thin;
      scrollbar-color: var(--ah-border) transparent;
      animation: cs-in 0.14s cubic-bezier(0.2, 0.8, 0.3, 1);
    }
    @keyframes cs-in {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    /* 滚动条（WebKit）与 --ah-* 对齐 */
    .panel::-webkit-scrollbar {
      width: 8px;
    }
    .panel::-webkit-scrollbar-thumb {
      background: var(--ah-border);
      border-radius: 4px;
    }
    .panel::-webkit-scrollbar-thumb:hover {
      background: var(--ah-text-muted);
    }

    /* 面板头：终端图标 + 标题 + 快捷键提示 */
    .panel-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px 8px;
      color: var(--ah-accent, #2997ff);
    }
    .panel-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--ah-text-faint);
      white-space: nowrap;
    }
    .panel-keys {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      color: var(--ah-text-faint);
      font-size: 11px;
      white-space: nowrap;
    }

    /* 分组标签 */
    .group-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      color: var(--ah-text-faint);
      padding: 6px 10px 4px;
    }
    .group + .group {
      margin-top: 2px;
    }

    /* 命令条目：图标 + 名称/描述 + 别名 pill */
    .cmd-item {
      appearance: none;
      border: none;
      background: transparent;
      width: 100%;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      margin-bottom: 2px;
      border-radius: var(--ah-radius-sm, 8px);
      color: var(--ah-text);
      font-family: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .cmd-item:last-child {
      margin-bottom: 0;
    }
    .cmd-item svg.i {
      width: 16px;
      height: 16px;
      color: var(--ah-text-muted);
      transition: color 0.12s ease;
    }
    /* 唯一高亮态：鼠标 hover 与键盘导航共用 activeIndex，避免双高亮 */
    .cmd-item.active {
      background: var(--ah-accent-soft);
      box-shadow: inset 2px 0 0 var(--ah-accent, #2997ff);
    }
    .cmd-item.active svg.i {
      color: var(--ah-accent, #2997ff);
    }
    .cmd-item:focus-visible {
      outline: 2px solid var(--ah-accent, #2997ff);
      outline-offset: -2px;
    }

    .cmd-body {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .cmd-name {
      font-family: var(--ah-font-mono);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--ah-text);
    }
    .cmd-desc {
      font-size: 11px;
      line-height: 1.35;
      color: var(--ah-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cmd-alias {
      flex: 0 0 auto;
      padding: 2px 7px;
      border-radius: var(--ah-radius-pill, 999px);
      background: var(--ah-surface-3);
      border: 1px solid var(--ah-border);
      font-family: var(--ah-font-mono);
      font-size: 10px;
      color: var(--ah-text-muted);
      white-space: nowrap;
    }

    /* 空态 / 页脚 */
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 16px 12px;
    }
    .empty svg.i {
      width: 20px;
      height: 20px;
      color: var(--ah-text-faint);
    }
    .empty-text {
      font-size: 12px;
      font-weight: 600;
      color: var(--ah-text);
    }
    .empty-hint {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--ah-text-muted);
    }
    .panel-foot {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px 2px;
      font-size: 11px;
      color: var(--ah-text-faint);
    }

    /* 窄屏：面板占满容器宽度 */
    @media (max-width: 560px) {
      .panel {
        width: 100%;
      }
    }
    /* 尊重系统的「减少动态效果」设置 */
    @media (prefers-reduced-motion: reduce) {
      .panel {
        animation: none;
      }
      .chip,
      .chip-x,
      .cmd-item {
        transition: none;
      }
    }
  `;

  /* ================================================================
   * ③ 状态层
   * ================================================================ */

  /** 输入框当前内容。命令联想态下是 `/xxx`，胶囊态下是命令参数。 */
  @property({ type: String }) value = '';

  /** 已胶囊化的命令名（不含 `/`）；空串表示尚未选中命令。 */
  @property({ type: String }) selected = '';

  /** 当前高亮项在「扁平候选列表」中的下标（键盘与鼠标共用）。 */
  @state() private activeIndex = 0;

  /** Esc / 点击外部后关闭联想面板；输入重新以 `/` 开头时自动复位。 */
  @state() private dismissed = false;

  /* ================================================================
   * 生命周期
   * ================================================================ */

  /** 点击面板 / 胶囊条之外时收起联想（捕获阶段，先于业务 handler）。 */
  private onDocPointerDown = (e: Event): void => {
    if (!this.panelOpen) return;
    const path = e.composedPath();
    if (path.includes(this)) return;
    // 点击输入框属于「继续输入命令」，不应关闭面板。
    if ((e.target as HTMLElement | null)?.tagName === 'TEXTAREA') return;
    this.dismissed = true;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('value')) {
      // Esc / 点击外部关闭后，直到输入不再以 `/` 开头才复位 —— 否则继续
      // 敲字会把刚关掉的面板又弹出来。
      if (!this.isCommandInput()) this.dismissed = false;
      // 有查询词就高亮首项（输入 /pl 后直接回车选中 plan）；
      // 只有裸 `/` 时不高亮任何项，避免误选首个命令（如 /new 会清空会话）。
      this.activeIndex = this.query ? 0 : -1;
    }
  }

  /* ================================================================
   * ③ 状态派生
   * ================================================================ */

  /** 输入框是否处于「正在输入命令名」的状态。 */
  private isCommandInput(): boolean {
    // 命令一旦胶囊化，输入框里剩下的是参数，不再触发联想。
    return !this.selected && this.value.trimStart().startsWith('/');
  }

  /** 当前查询词（不含前导 `/`，小写）。 */
  private get query(): string {
    if (!this.isCommandInput()) return '';
    return (parseCommand(this.value)?.cmd ?? '').toLowerCase();
  }

  /** 扁平候选列表（已排序）。 */
  private get candidates(): SlashCommand[] {
    return this.isCommandInput() ? filterCommands(this.query) : [];
  }

  /** 联想面板是否打开。 */
  private get panelOpen(): boolean {
    return this.isCommandInput() && !this.dismissed;
  }

  /* ================================================================
   * ④ 交互层
   * ================================================================ */

  /**
   * 供宿主 textarea 的 keydown 转发调用（焦点在 light DOM 的输入框里，
   * 事件不会自己冒泡进 shadow DOM 的面板）。
   * 返回 true 表示已消费该按键，宿主不应再走默认发送逻辑。
   */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.panelOpen) return false;

    const total = this.candidates.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        // 空候选时无项可移，仅吞掉按键（避免光标跳到行首/行尾）
        this.activeIndex = total ? (this.activeIndex + 1) % total : 0;
        this.scrollActiveIntoView();
        return true;
      case 'ArrowUp':
        e.preventDefault();
        // activeIndex 为 -1（未高亮）时向上应落到最后一项
        this.activeIndex = total
          ? this.activeIndex <= 0
            ? total - 1
            : this.activeIndex - 1
          : 0;
        this.scrollActiveIntoView();
        return true;
      case 'Enter':
      case 'Tab': {
        const cmd = this.candidates[this.activeIndex];
        if (!cmd) return false; // 无匹配：交还宿主，走普通发送
        e.preventDefault();
        this.select(cmd.name);
        return true;
      }
      case 'Escape':
        e.preventDefault();
        this.dismissed = true;
        return true;
      default:
        return false;
    }
  }

  /** 选中命令：派发给宿主，由宿主决定是否胶囊化。 */
  private select(name: string): void {
    this.dismissed = true;
    this.dispatchEvent(
      new CustomEvent<CommandSelectDetail>('command-select', {
        detail: { name },
        bubbles: true,
        composed: true
      })
    );
  }

  /**
   * 移除已选命令（胶囊上的 ×）。
   * 注意：不能命名为 remove —— 会与 Element.remove() 冲突。
   */
  private removeCommand(): void {
    this.dispatchEvent(
      new CustomEvent<CommandSelectDetail>('command-remove', {
        detail: { name: this.selected },
        bubbles: true,
        composed: true
      })
    );
  }

  /** 让高亮项始终可见（面板可滚动时）。 */
  private scrollActiveIntoView(): void {
    this.updateComplete.then(() => {
      this.renderRoot
        .querySelector('.cmd-item.active')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ================================================================
   * ⑤ 视图层
   * ================================================================ */

  /** 线性图标渲染助手。 */
  private icon(path: string): TemplateResult {
    return html`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d=${path} />
    </svg>`;
  }

  /** 命令图标 path：未配置回落终端图标。 */
  private iconPath(name: string): string {
    return COMMAND_ICONS[name] ?? ICON_TERMINAL;
  }

  render(): TemplateResult | typeof nothing {
    const chip = this.selected
      ? this.renderChipBar(this.selected)
      : nothing;
    const panel = this.panelOpen ? this.renderPanel() : nothing;
    // 两者可能同时为空 —— 返回 nothing，让 .composer 不产生空行。
    if (chip === nothing && panel === nothing) return nothing;
    return html`${chip}${panel}`;
  }

  /** ④ 胶囊条：已选命令 + 悬停删除。 */
  private renderChipBar(name: string): TemplateResult {
    const desc = getCommands().find((c) => c.name === name)?.description ?? '';
    return html`
      <div class="chip-bar" role="group" aria-label="已选命令">
        <span class="chip" title=${desc ? `/${name} — ${desc}` : `/${name}`}>
          ${this.icon(this.iconPath(name))}
          <span class="chip-name">/${name}</span>
          <button
            type="button"
            class="chip-x"
            aria-label=${`移除命令 /${name}`}
            title="移除命令"
            @click=${() => this.removeCommand()}
          >
            ×
          </button>
        </span>
        <span class="chip-hint">${desc}</span>
      </div>
    `;
  }

  /** 联想面板。 */
  private renderPanel(): TemplateResult {
    const candidates = this.candidates;
    return html`
      <div class="panel" role="listbox" aria-label="可用命令">
        ${this.renderHead(candidates.length)}
        ${candidates.length === 0
          ? this.renderEmpty()
          : groupCommands(candidates).map((g) => this.renderGroup(g))}
        ${this.renderFoot(candidates.length)}
      </div>
    `;
  }

  private renderHead(count: number): TemplateResult {
    return html`
      <div class="panel-head">
        ${this.icon(ICON_TERMINAL)}
        <span class="panel-title">命令${count ? ` · ${count}` : ''}</span>
        <span class="panel-keys"
          ><kbd>↑</kbd><kbd>↓</kbd><kbd>⏎</kbd><kbd>Esc</kbd></span
        >
      </div>
    `;
  }

  /** 单个分组。offset 为该组首项在扁平候选列表中的下标，用于 activeIndex 对齐。 */
  private renderGroup(group: CommandGroup): TemplateResult {
    const base = this.flatOffsetOf(group);
    return html`
      <div class="group" role="group" aria-label=${group.label}>
        <div class="group-label">${group.label}</div>
        ${group.items.map((c, i) => this.renderItem(c, base + i))}
      </div>
    `;
  }

  private renderItem(cmd: SlashCommand, index: number): TemplateResult {
    const active = index === this.activeIndex;
    return html`
      <button
        type="button"
        class="cmd-item ${active ? 'active' : ''}"
        role="option"
        aria-selected=${active ? 'true' : 'false'}
        title=${cmd.description}
        @click=${() => this.select(cmd.name)}
        @mouseenter=${() => (this.activeIndex = index)}
      >
        ${this.icon(this.iconPath(cmd.name))}
        <span class="cmd-body">
          <span class="cmd-name">/${cmd.name}</span>
          <span class="cmd-desc">${cmd.description}</span>
        </span>
        ${cmd.aliases && cmd.aliases.length
          ? html`<span class="cmd-alias">${cmd.aliases.join(', ')}</span>`
          : nothing}
      </button>
    `;
  }

  private renderEmpty(): TemplateResult {
    return html`
      <div class="empty">
        ${this.icon('M11 20a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM21 21l-4.35-4.35')}
        <span class="empty-text">无匹配命令</span>
        <span class="empty-hint">
          <kbd>Esc</kbd> 关闭，或继续输入以搜索
        </span>
      </div>
    `;
  }

  private renderFoot(count: number): TemplateResult {
    return html`
      <div class="panel-foot">
        ${count
          ? html`<kbd>⏎</kbd> 选中命令，随后输入参数`
          : html`<kbd>Esc</kbd> 关闭面板`}
      </div>
    `;
  }

  /** 分组首项在扁平候选列表中的下标。 */
  private flatOffsetOf(group: CommandGroup): number {
    const first = group.items[0];
    if (!first) return 0;
    return this.candidates.findIndex((c) => c.name === first.name);
  }
}

/** `command-select` / `command-remove` 事件载荷。 */
export interface CommandSelectDetail {
  /** 命令名（不含前导 `/`）。 */
  name: string;
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-command-suggestions': AhCommandSuggestions;
  }
}

/* HMR 防呆：自定义元素无法在热更新时重新注册（customElements.define 已占用该 tag），
 * 若直接 HMR 本模块，DOM 中已有的 <ah-command-suggestions> 会停留在「旧类」实例，
 * 导致宿主调用 handleKey 时出现「is not a function」。decline() 让 Vite 在本模块
 * 变更时改为整页刷新，保证元素始终升级到最新类。生产构建中 import.meta.hot 为空，
 * 此段会被摇树移除，不影响产物。 */
const _hmeta = import.meta as unknown as { hot?: { decline(): void } };
if (_hmeta.hot) {
  _hmeta.hot.decline();
}
