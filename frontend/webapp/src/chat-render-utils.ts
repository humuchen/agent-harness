/**
 * chat-render-utils：聊天界面中可独立抽取的纯渲染 / 格式化工具。
 *
 * 从 AhChat 单体内抽离，降低耦合与体积。所有导出均为纯函数或仅依赖显式入参，
 * 不读取组件 this.* 状态，便于独立测试与跨渲染方法复用。
 */
import { html, nothing, type TemplateResult } from 'lit';
import { escapeHtml } from './utils/markdown';
import type { UploadedFile } from './agent-context';
import type { PlanExecMirror } from '@agent-harness/client';

/** 按文件类型返回展示图标（emoji）。 */
export function fileIcon(f: UploadedFile): string {
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

/** 人类可读的文件大小（B / KB / MB）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 从线程消息里提取「计划进度镜像查找表」：按 plan.goal 对齐 PlanExecMirror。
 * 消息 id 在恢复时重新分配，不能按 id 对齐；goal 是计划卡片的稳定业务键。纯计算。
 */
export function buildPlanStatusLookup(
  msgs: Array<{ plan?: unknown; planStatus?: PlanExecMirror }>
): Map<string, PlanExecMirror> {
  const out = new Map<string, PlanExecMirror>();
  for (const m of msgs) {
    const plan = m.plan as { goal?: unknown } | undefined;
    if (!plan || typeof plan.goal !== 'string' || !m.planStatus) continue;
    if (!out.has(plan.goal)) out.set(plan.goal, m.planStatus);
  }
  return out;
}

export interface RenderAttachmentsOpts {
  files: UploadedFile[];
  /** 点击图片缩略图时的预览回调（原组件内 this.openPreview）。 */
  onPreview: (f: UploadedFile) => void;
}

/**
 * 渲染图片附件：作为独立于气泡的附件卡片（调用方负责放在气泡上方，而非气泡内）。
 * - 单张图片：直接缩略图，点击预览。
 * - 多张图片：折叠态显示首图 +「N 张」角标 +「点击展开」提示；点击卡片展开为
 *   平铺网格，展开后单张点击预览，点击卡片空白区收起。
 */
export function renderImageAttachments(
  opts: RenderAttachmentsOpts
): TemplateResult | typeof nothing {
  const { files, onPreview } = opts;
  const images = files.filter((f) => f.type.startsWith('image/'));
  const first = images[0];
  if (!first) return nothing;

  const singleImage = (f: UploadedFile) => html`
    <div
      class="attach-img is-previewable"
      title="点击预览"
      @click=${() => onPreview(f)}
    >
      <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
    </div>
  `;

  if (images.length === 1) return singleImage(first);

  // 多图：点击卡片在「折叠 ↔ 展开」间切换；展开后单张点击预览。
  const toggleCard = (e: Event) => {
    const card = (e.currentTarget as HTMLElement).closest('.attach-card');
    if (!card) return;
    const target = e.target as HTMLElement;
    if (card.classList.contains('expanded') && !target.closest('.attach-img')) {
      card.classList.remove('expanded');
      return;
    }
    if (!card.classList.contains('expanded')) card.classList.add('expanded');
  };
  const onImgClick = (e: Event, f: UploadedFile) => {
    const card = (e.currentTarget as HTMLElement).closest('.attach-card');
    if (card && !card.classList.contains('expanded')) return; // 未展开：交给卡片展开
    e.stopPropagation();
    onPreview(f);
  };

  return html`
    <div class="attach-card">
      <div
        class="attach-card-cover is-previewable"
        title="点击展开全部图片"
        @click=${toggleCard}
      >
        <img
          class="attach-card-thumb"
          src=${first.dataUrl}
          alt=${escapeHtml(first.name)}
          loading="lazy"
        />
        <span class="attach-card-hint">点击展开</span>
        <span class="attach-card-badge">${images.length} 张</span>
      </div>
      <div class="attach-card-grid">
        ${images.map(
          (f) =>
            html`<div
              class="attach-img is-previewable"
              title="点击预览"
              @click=${(e: Event) => onImgClick(e, f)}
            >
              <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
            </div>`
        )}
      </div>
    </div>
  `;
}

/**
 * 渲染非图片附件（PDF / 文本 / 表格等，走文字条目）。图片已由
 * renderImageAttachments 独立成卡片置于气泡外，此处不再处理图片。
 */
export function renderAttachments(
  opts: RenderAttachmentsOpts
): TemplateResult | typeof nothing {
  const { files } = opts;
  const others = files.filter((f) => !f.type.startsWith('image/'));
  if (others.length === 0) return nothing;
  return html`
    <div class="attachments">
      ${others.map(
        (f) =>
          html`<div class="attach-file">
            ${fileIcon(f)} ${escapeHtml(f.name)} (${formatSize(f.size)})
          </div>`
      )}
    </div>
  `;
}
