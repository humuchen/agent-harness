/**
 * file-upload：附件上传（前端应用层「File Upload」落地）。
 *
 * 支持点击选择与拖拽上传；读取为 DataURL 后通过 `files-changed` 事件
 * 把 UploadedFile[] 交给父组件（可写入 agentContext 共享给各面板）。
 * 内置校验：文件数上限、单文件大小上限、accept 类型过滤；任何一步失败
 * 都以 `error` 事件（detail: string）上抛，不静默吞掉。
 *
 * 用法：
 *   <ah-file-upload max-files="3" max-size-mb="5" accept=".txt,.md,.csv"></ah-file-upload>
 *   el.addEventListener('files-changed', (e) => agentContext.set('files', e.detail));
 */
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { UploadedFile } from './agent-context';

@customElement('ah-file-upload')
export class AhFileUpload extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .drop {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 18px 12px;
      border: 1px dashed var(--ah-border);
      border-radius: var(--ah-radius-md);
      background: var(--ah-surface-2);
      color: var(--ah-text-muted);
      font-size: 13px;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .drop.dragover {
      border-color: var(--ah-accent);
      background: var(--ah-accent-soft);
      color: var(--ah-accent);
    }
    .drop.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .files {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }
    .file {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: var(--ah-radius-sm);
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      font-size: 13px;
    }
    .file .name {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ah-text);
    }
    .file .meta {
      color: var(--ah-text-faint);
      font-size: 12px;
    }
    .file .rm {
      border: none;
      background: none;
      color: var(--ah-text-faint);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 2px 6px;
      border-radius: var(--ah-radius-sm);
    }
    .file .rm:hover {
      color: var(--ah-danger);
      background: var(--ah-danger-soft);
    }
  `;

  /** 当前已选附件（受控：父组件也可直接写入）。 */
  @property({ type: Array })
  files: UploadedFile[] = [];

  /** 最多允许的文件数。 */
  @property({ type: Number, attribute: 'max-files' })
  maxFiles = 3;

  /** 单文件大小上限（MB）。 */
  @property({ type: Number, attribute: 'max-size-mb' })
  maxSizeMb = 5;

  /** accept 过滤（逗号分隔扩展名 / MIME，如 ".txt,.md,text/plain"）。 */
  @property({ type: String })
  accept = '';

  /** 运行中禁用上传。 */
  @property({ type: Boolean })
  disabled = false;

  @state()
  private dragover = false;

  private emit() {
    this.dispatchEvent(
      new CustomEvent('files-changed', {
        detail: [...this.files],
        bubbles: true,
        composed: true,
      })
    );
  }

  private raise(msg: string) {
    this.dispatchEvent(
      new CustomEvent('error', { detail: msg, bubbles: true, composed: true })
    );
  }

  private acceptFile(f: File): boolean {
    if (!f) return false;
    if (!this.accept) return true;
    const allow = this.accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allow.length) return true;
    const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')).toLowerCase() : '';
    const mime = (f.type || '').toLowerCase();
    return allow.some((a) => (a.startsWith('.') ? a === ext : a === mime));
  }

  private async addFiles(list: FileList | File[]) {
    if (this.disabled) return;
    const maxBytes = this.maxSizeMb * 1024 * 1024;
    const arr = Array.from(list);
    if (arr.length === 0) return;

    if (this.files.length + arr.length > this.maxFiles) {
      this.raise(`最多上传 ${this.maxFiles} 个文件`);
      return;
    }
    for (const f of arr) {
      if (!this.acceptFile(f)) {
        this.raise(`不支持的文件类型：${f.name || f.type || '未知'}`);
        return;
      }
      if (f.size > maxBytes) {
        this.raise(`文件过大：${f.name}（上限 ${this.maxSizeMb}MB）`);
        return;
      }
    }
    try {
      const added: UploadedFile[] = await Promise.all(
        arr.map(
          (f) =>
            new Promise<UploadedFile>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error(`读取文件失败：${f.name}`));
              reader.onload = () =>
                resolve({
                  name: f.name,
                  size: f.size,
                  type: f.type,
                  dataUrl: String(reader.result ?? ''),
                });
              reader.readAsDataURL(f);
            })
        )
      );
      this.files = [...this.files, ...added];
      this.emit();
    } catch (e) {
      this.raise(e instanceof Error ? e.message : String(e));
    }
  }

  private removeFile(i: number) {
    this.files = this.files.filter((_, idx) => idx !== i);
    this.emit();
  }

  private onInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) void this.addFiles(input.files);
    input.value = ''; // 允许重复选择同一文件
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragover = false;
    if (e.dataTransfer?.files) void this.addFiles(e.dataTransfer.files);
  }

  render() {
    return html`
      <label
        class="drop ${this.dragover ? 'dragover' : ''} ${this.disabled ? 'disabled' : ''}"
        @dragover=${(e: DragEvent) => {
          e.preventDefault();
          if (!this.disabled) this.dragover = true;
        }}
        @dragleave=${() => (this.dragover = false)}
        @drop=${this.onDrop}
      >
        <input
          type="file"
          multiple
          accept=${this.accept}
          ?disabled=${this.disabled}
          @change=${this.onInput}
          style="display:none"
        />
        <span>点击选择或拖拽文件到此处</span>
        <span style="color:var(--ah-text-faint);font-size:12px">
          最多 ${this.maxFiles} 个 · 单个 ≤ ${this.maxSizeMb}MB
        </span>
      </label>
      ${this.files.length
        ? html`<div class="files">
            ${this.files.map(
              (f, i) => html`
                <div class="file">
                  <span class="name" title=${f.name}>${f.name}</span>
                  <span class="meta">${(f.size / 1024).toFixed(1)} KB</span>
                  <button type="button" class="rm" title="移除" @click=${() => this.removeFile(i)}>×</button>
                </div>
              `
            )}
          </div>`
        : ''}
    `;
  }
}
