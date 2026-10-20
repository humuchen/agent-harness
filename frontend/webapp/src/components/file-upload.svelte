<script module lang="ts">
  /** 上传状态枚举。 */
  export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';

  export interface UploadedFileWithStatus extends UploadedFile {
    status: UploadStatus;
    error?: string;
    progress?: number; // 0-100
    file?: File; // 原始 File 引用，用于服务端上传（不进入 dataUrl / 模型载荷）
  }
</script>

<script lang="ts">
  /**
   * file-upload：附件上传（前端应用层「File Upload」落地）—— Svelte 迁移版。
   *
   * 支持点击选择与拖拽上传；读取为 DataURL 后通过 `files-changed` 事件
   * 把 UploadedFile[] 交给父组件（可写入 agentContext 共享给各面板）。
   *
   * - 图片文件在列表中显示缩略图预览（DataURL 本地渲染，0 额外依赖）；
   * - 上传状态：pending / uploading / done / error，配合进度条/图标；
   * - 错误提示通过 `error` 事件上抛，不静默吞掉；
   * - 移动端适配：触摸拖拽 + 响应式布局 + 大图预览限制。
   *
   * 用法：
   *   <FileUpload maxFiles={3} maxSizeMb={5} accept=".txt,.md,.csv" />
   *   root.addEventListener('files-changed', (e) => agentContext.set('files', e.detail));
   *
   * 样式：mobilePill 已全局注入（勿在组件内重复）；:host 规则改写为根类
   * .file-upload-root。
   */
  import type { UploadedFile } from '../agent-context';
  import { uploadFileToApi } from '../utils/upload';
  import { compressImage } from '../utils/compress-image';

  let {
    /** 当前已选附件（受控：父组件也可直接写入）。 */
    files = $bindable([]),
    /** 最多允许的文件数。 */
    maxFiles = 3,
    /** 单文件大小上限（MB）。 */
    maxSizeMb = 5,
    /** accept 过滤（逗号分隔扩展名 / MIME）。 */
    accept = '',
    /** 运行中禁用上传。 */
    disabled = false,
    /** 是否启用服务端上传（true 时本地读完即 POST /api/upload，保留 dataUrl 作降级预览）。 */
    serverUpload = false
  }: {
    files?: UploadedFileWithStatus[];
    maxFiles?: number;
    maxSizeMb?: number;
    accept?: string;
    disabled?: boolean;
    serverUpload?: boolean;
  } = $props();

  let dragover = $state(false);
  let rootEl: HTMLElement | undefined = $state();

  function emit() {
    rootEl?.dispatchEvent(
      new CustomEvent('files-changed', {
        detail: [...files],
        bubbles: true,
        composed: true
      })
    );
  }

  function raise(msg: string) {
    rootEl?.dispatchEvent(
      new CustomEvent('error', { detail: msg, bubbles: true, composed: true })
    );
  }

  function acceptFile(f: File): boolean {
    if (!f) return false;
    if (!accept) return true;
    const allow = accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allow.length) return true;
    const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')).toLowerCase() : '';
    const mime = (f.type || '').toLowerCase();
    return allow.some((a) => (a.startsWith('.') ? a === ext : a === mime));
  }

  async function addFiles(list: FileList | File[]) {
    if (disabled) return;
    const maxBytes = maxSizeMb * 1024 * 1024;
    const arr = Array.from(list);
    if (arr.length === 0) return;

    if (files.length + arr.length > maxFiles) {
      raise(`最多上传 ${maxFiles} 个文件`);
      return;
    }
    for (const f of arr) {
      if (!acceptFile(f)) {
        raise(`不支持的文件类型：${f.name || f.type || '未知'}`);
        return;
      }
      if (f.size > maxBytes) {
        raise(`文件过大：${f.name}（上限 ${maxSizeMb}MB）`);
        return;
      }
    }
    try {
      const added: UploadedFileWithStatus[] = await Promise.all(
        arr.map(
          (f) =>
            new Promise<UploadedFileWithStatus>((resolve) => {
              const reader = new FileReader();
              reader.onerror = () =>
                resolve({
                  name: f.name,
                  size: f.size,
                  type: f.type,
                  dataUrl: '',
                  status: 'error',
                  error: `读取文件失败：${f.name}`
                });
              reader.onload = () => {
                const dataUrl = String(reader.result ?? '');
                const base: UploadedFileWithStatus = {
                  name: f.name,
                  size: f.size,
                  type: f.type,
                  dataUrl,
                  status: 'pending',
                  file: f
                };
                // 若是图片且开启服务端上传，先本地显示 pending，再尝试 POST
                if (serverUpload && f.type.startsWith('image/')) {
                  base.status = 'uploading';
                  files = [...files, base];
                  emit();
                  void uploadToServer(base).then((ok) => {
                    const idx = files.findIndex((u) => u === base);
                    if (idx >= 0) {
                      files = files.map((u, i) =>
                        i === idx ? { ...u, status: ok ? 'done' : 'error' } : u
                      );
                      emit();
                    }
                  });
                  // 已乐观加入 files，这里 resolve 以解除 Promise.all 等待（避免挂起）。
                  resolve(base);
                } else {
                  resolve({ ...base, status: 'done' });
                }
              };
              reader.readAsDataURL(f);
            })
        )
      );
      if (!serverUpload || !arr[0]?.type?.startsWith('image/')) {
        files = [...files, ...added];
        emit();
      }
    } catch (e) {
      raise(e instanceof Error ? e.message : String(e));
    }
  }

  /** 把文件 POST 到 /api/upload，返回是否成功，并回填 serverUrl。 */
  async function uploadToServer(file: UploadedFileWithStatus): Promise<boolean> {
    if (!file.file) return false;
    const uploadFile = file.file.type.startsWith('image/')
      ? await compressImage(file.file)
      : file.file;
    const res = await uploadFileToApi(uploadFile);
    if (res.ok && res.url) {
      file.serverUrl = res.url;
      return true;
    }
    file.error = res.error && /request body too large/i.test(res.error)
      ? '图片体积过大，被服务端拒绝'
      : res.error || '上传失败';
    return false;
  }

  function removeFile(i: number) {
    files = files.filter((_, idx) => idx !== i);
    emit();
  }

  function onInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) void addFiles(input.files);
    input.value = '';
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragover = false;
    if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
  }

  function isImage(f: UploadedFileWithStatus): boolean {
    return f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg)$/i.test(f.name);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function statusIcon(s: UploadStatus): string {
    if (s === 'uploading') return '⏳';
    if (s === 'done') return '✓';
    if (s === 'error') return '✗';
    return '';
  }
</script>

<div class="file-upload-root no-pill" bind:this={rootEl}>
  <label
    class="drop"
    class:dragover
    class:disabled
    ondragover={(e: DragEvent) => {
      e.preventDefault();
      if (!disabled) dragover = true;
    }}
    ondragleave={() => (dragover = false)}
    ondrop={onDrop}
  >
    <input
      type="file"
      multiple
      accept={accept}
      disabled={disabled}
      onchange={onInput}
      style="display:none"
    />
    <span>点击选择或拖拽文件到此处</span>
    <span style="color:var(--ah-text-faint);font-size:12px">
      最多 {maxFiles} 个 · 单个 ≤ {maxSizeMb}MB
    </span>
  </label>
  {#if files.length}
    <div class="files">
      {#each files as f, i (i)}
        <div class="file">
          <div class="thumb">
            {#if isImage(f) && f.dataUrl}
              <img src={f.dataUrl} alt={f.name} loading="lazy" />
            {:else}
              📄
            {/if}
          </div>
          <div class="info">
            <div class="name" title={f.name}>{f.name}</div>
            <div class="meta">
              <span>{formatSize(f.size)}</span>
              {#if f.status !== 'pending'}
                <span class="status" class:uploading={f.status === 'uploading'} class:done={f.status === 'done'} class:error={f.status === 'error'}>{statusIcon(f.status)}</span>
              {/if}
            </div>
            {#if f.status === 'uploading'}
              <div class="progress"><div class="progress-bar" style="width:50%"></div></div>
            {/if}
            {#if f.error}
              <div style="color:var(--ah-danger);font-size:11px;margin-top:2px">{f.error}</div>
            {/if}
          </div>
          <button type="button" class="rm" title="移除" onclick={() => removeFile(i)}>×</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* 原 :host 规则 → 根类 */
  .file-upload-root {
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
    gap: 8px;
    margin-top: 8px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-1);
    border: 1px solid var(--ah-border);
    font-size: 13px;
  }
  .file .thumb {
    flex: 0 0 40px;
    width: 40px;
    height: 40px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--ah-surface-3, var(--ah-surface-2));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
  }
  .file .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .file .info {
    flex: 1 1 auto;
    min-width: 0;
  }
  .file .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ah-text);
    font-size: 13px;
  }
  .file .meta {
    color: var(--ah-text-faint);
    font-size: 12px;
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 2px;
  }
  .file .status {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 10px;
    background: var(--ah-surface-3, var(--ah-surface-2));
  }
  .file .status.uploading {
    color: var(--ah-accent);
    background: var(--ah-accent-soft);
  }
  .file .status.done {
    color: var(--ah-success, #34c759);
    background: color-mix(in srgb, var(--ah-success, #34c759) 12%, transparent);
  }
  .file .status.error {
    color: var(--ah-danger);
    background: var(--ah-danger-soft);
  }
  .file .progress {
    height: 3px;
    border-radius: 2px;
    background: var(--ah-border);
    overflow: hidden;
    margin-top: 4px;
  }
  .file .progress-bar {
    height: 100%;
    background: var(--ah-accent);
    transition: width 0.2s ease;
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
    flex: 0 0 auto;
  }
  .file .rm:hover {
    color: var(--ah-danger);
    background: var(--ah-danger-soft);
  }
  /* 移动端适配 */
  @media (max-width: 640px) {
    .drop {
      padding: 14px 10px;
      font-size: 12px;
    }
    .file {
      gap: 8px;
      padding: 6px 8px;
    }
    .file .thumb {
      width: 32px;
      height: 32px;
      font-size: 16px;
    }
  }
</style>
