/**
 * chat-render-utils：聊天界面中可独立抽取的纯渲染 / 格式化工具。
 *
 * 从 AhChat 单体内抽离，降低耦合与体积。所有导出均为纯函数或仅依赖显式入参，
 * 不读取组件 this.* 状态，便于独立测试与跨渲染方法复用。
 */
import { html, type TemplateResult } from 'lit';
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
 * 渲染消息附件区：
 * - 单张图片：直接缩略图，点击预览。
 * - 多张图片：交错堆叠（错位 + 旋转层叠），点击堆叠区展开为平铺网格；
 *   展开后点击单张预览，点击空白区收起。其它文件走文字条目。
 */
export function renderAttachments(opts: RenderAttachmentsOpts): TemplateResult {
  const { files, onPreview } = opts;
  const hasImages = files.some((f) => f.type.startsWith('image/'));
  const images = files.filter((f) => f.type.startsWith('image/'));
  const others = files.filter((f) => !f.type.startsWith('image/'));

  // 多图堆叠：点击堆叠区在「堆叠 ↔ 展开」间切换；展开后单张点击预览。
  const toggleStack = (e: Event) => {
    const stack = (e.currentTarget as HTMLElement).closest('.attach-stack');
    if (!stack) return;
    const target = e.target as HTMLElement;
    if (stack.classList.contains('expanded') && !target.closest('.attach-img')) {
      stack.classList.remove('expanded');
      return;
    }
    if (!stack.classList.contains('expanded')) stack.classList.add('expanded');
  };
  const onImgClick = (e: Event, f: UploadedFile) => {
    const stack = (e.currentTarget as HTMLElement).closest('.attach-stack');
    if (stack && !stack.classList.contains('expanded')) return; // 未展开：交给 stack 展开
    e.stopPropagation();
    onPreview(f);
  };

  const singleImage = (f: UploadedFile) => html`
    <div class="attach-img is-previewable" title="点击预览" @click=${() => onPreview(f)}>
      <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
    </div>
  `;

  return html`
    <div class="attachments ${hasImages ? 'has-images' : ''}">
      ${images.length > 1
        ? html`<div class="attach-stack" @click=${toggleStack}>
            ${images.map(
              (f, i) =>
                html`<div
                  class="attach-img is-previewable"
                  style="--i:${i}"
                  title="点击展开全部图片"
                  @click=${(e: Event) => onImgClick(e, f)}
                >
                  <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
                  ${i === images.length - 1
                    ? html`<span class="attach-count">${images.length} 张</span>`
                    : ''}
                </div>`
            )}
          </div>`
        : html`${images.map((f) => singleImage(f))}`}
      ${others.map(
        (f) =>
          html`<div class="attach-file">
            ${fileIcon(f)} ${escapeHtml(f.name)} (${formatSize(f.size)})
          </div>`
      )}
    </div>
  `;
}
