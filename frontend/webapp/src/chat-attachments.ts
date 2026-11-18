/**
 * 附件上传/预览管线（P1-5 chat.svelte 拆分第三刀：从 <script module> 整体外迁）。
 *
 * 与首刀（stores/chat-scroll.svelte.ts）/ 第二刀（stores/chat-message-ui.svelte.ts）
 * 同范式：纯逻辑与约束常量移出巨型组件，chat.svelte module 层 re-export 保持
 * 既有导入点（chat-attachments.test.ts / chat-upload-batch.test.ts 等）零改动兼容。
 *
 * 依赖注入形态不变：核心函数以「状态对象」参数化（AttachState），组件实例经
 * attachBridge 桥接 $state，单测直接构造最小状态驱动，不触碰渲染与组件状态。
 */
import { authedFetch } from './api';
import type { UploadedFile } from './agent-context';
import { notifyError } from './utils/errors';
import { notify } from './components/ah-notification';
import { compressImage } from './utils/compress-image';

/**
 * 附件约束（导出以便单测与 UI 文案复用，避免两处写死不一致）。
 * 拖拽遮罩的提示文案与该强制校验共用同一常量。
 */
export const MAX_ATTACHMENTS = 15;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 单个 10MB

/**
 * 附件预览条折叠时最多直接展示的条目数。
 *
 * 预览条位于输入框上方、高度固定为一行；条目一多就会把最后一项硬裁在
 * 容器右缘（既看不出被裁了，也不知道总共几个）。超过本阈值后余量收进
 * 「+N」按钮，点开再以多行网格展开。
 */
export const ATTACH_COLLAPSE_LIMIT = 6;

/**
 * 批量上传的并发度。
 * 串行会导致首张慢请求堵死整批；无上限并发则一次拖 15 张会瞬间打出 15 个请求。
 * 取 4 是两者的折中：显著快于串行，又不至于压垮服务端 / 占满浏览器连接池。
 */
export const UPLOAD_CONCURRENCY = 4;

/** 已通过校验、待上传的条目：本地预览元信息 + 原始 File + 实际上传 File + 追踪 key。 */
export interface PendingUpload {
  meta: UploadedFile;
  raw: File;
  /** 实际上传的文件；图片可能经过压缩。 */
  uploadFile: File;
  key: string;
}

/** 允许上传的扩展名（MIME 为空时的兜底判定）。 */
const ALLOWED_EXTS = ['.txt', '.md', '.csv', '.json'];

/** 文件是否属于允许上传的类型（图片 / 文本 / JSON）。 */
export function isAllowedAttachment(f: File): boolean {
  if (f.type) {
    if (f.type.startsWith('image/') || f.type.startsWith('text/')) return true;
    if (f.type.includes('json')) return true;
  }
  // MIME 缺失时按扩展名兜底（部分来源拖入的文件 type 为空字符串）。
  const dot = f.name.lastIndexOf('.');
  return dot >= 0 && ALLOWED_EXTS.includes(f.name.slice(dot).toLowerCase());
}

/** 读取文件为 DataURL，用于本地预览。 */
export function readAsDataUrl(f: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(f);
  });
}

/**
 * 以固定并发度执行一组任务。
 *
 * 契约：任务自身必须已捕获异常 —— 本函数不兜 reject，
 * 某任务若抛错会经 Promise.all 冒泡（调用方应保证任务不抛）。
 * 任务全部执行完才 resolve；并发度会被裁剪到任务数，不会空转。
 */
export async function runWithConcurrency(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit = UPLOAD_CONCURRENCY
): Promise<void> {
  if (!tasks.length || limit <= 0) return;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (cursor < tasks.length) {
        const i = cursor++;
        const task = tasks[i];
        if (!task) break;
        await task();
      }
    }
  );
  await Promise.all(workers);
}

/**
 * 按折叠状态解算附件预览条的展示切片。
 *
 * 纯函数，供渲染与单测共用 —— 保证「按钮上显示的数字」与「实际渲染的
 * 条目数」永远一致，不会出现文案说有 N 个、列表却渲染了别的数量。
 */
export function resolveAttachmentView<T>(
  list: readonly T[],
  expanded: boolean,
  limit: number = ATTACH_COLLAPSE_LIMIT
): { visible: T[]; collapsedCount: number } {
  const collapsedCount = Math.max(0, list.length - limit);
  const visible = expanded ? list.slice() : list.slice(0, limit);
  return { visible, collapsedCount };
}

/** 附件上传/预览管线所操作的最小状态（组件实例经桥接对象注入 $state；单测直接构造普通对象）。 */
export interface AttachState {
  attachments: UploadedFile[];
  uploadingFiles: Map<
    string,
    { status: 'uploading' | 'done' | 'error'; error?: string }
  >;
}

/**
 * 按对象**引用**就地更新某个附件字段。
 * 用引用而非下标 —— 上传期间用户可能移除其它附件，下标会错位打到别的文件上。
 */
export function patchAttachmentCore(
  st: AttachState,
  target: UploadedFile,
  patch: Partial<UploadedFile>
) {
  st.attachments = st.attachments.map((a) =>
    a === target ? { ...a, ...patch } : a
  );
}

/**
 * 上传单个附件并就地更新其状态。
 * 失败只标记该文件为 error，绝不影响同批其它文件。
 */
export async function uploadOneCore(p: PendingUpload, st: AttachState): Promise<void> {
  try {
    const formData = new FormData();
    formData.append('file', p.uploadFile, p.uploadFile.name);
    const resp = await authedFetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const json = await resp.json();
    if (!json?.ok || !json.meta?.url) {
      throw new Error(json?.error || '上传失败');
    }
    // 不可变更新：重新赋值触发响应式重渲染。
    patchAttachmentCore(st, p.meta, {
      serverUrl: json.meta.url,
      uploadStatus: 'done'
    });
    st.uploadingFiles.set(p.key, { status: 'done' });
  } catch (err) {
    let msg = err instanceof Error ? err.message : '上传失败';
    // 后端 raw body 超过阈值时返回该文案；转换为更友好的提示。
    if (/request body too large/i.test(msg)) {
      msg = `图片体积过大，上传被服务端拒绝：${p.raw.name}`;
    }
    patchAttachmentCore(st, p.meta, {
      uploadStatus: 'error',
      uploadError: msg
    });
    st.uploadingFiles.set(p.key, { status: 'error', error: msg });
    notifyError(new Error(msg), {
      title: '附件上传',
      fallback: `上传失败：${p.raw.name}`,
      key: 'chat-upload'
    });
  }
}

/**
 * 处理文件选择。读取本地预览并上传到服务端。
 *
 * 入参是 File[] 而非 Event —— 两条入口（「+」面板点击选择 / 拖拽到 chat 区域）
 * 最终都归一成 File[] 汇到这里。
 *
 * 三个阶段刻意分开：
 *   1. 逐个校验 + 读本地预览（失败只跳过该文件，绝不中断整批）；
 *   2. **整批一次性并入** attachments —— UI 立刻显示全部 N 个；
 *   3. 受限并发上传 —— 单张失败只影响自己。
 */
export async function handleFilesCore(st: AttachState, picked: File[]): Promise<void> {
  if (!picked.length) return;

  // 数量上限：拖拽遮罩的提示文案（MAX_ATTACHMENTS）在这里才真正生效。
  const room = MAX_ATTACHMENTS - st.attachments.length;
  if (room <= 0) {
    notify.warning(
      `已达上传上限（${MAX_ATTACHMENTS} 个），请先移除部分文件再添加`,
      { key: 'chat-upload' }
    );
    return;
  }
  let list = picked;
  if (list.length > room) {
    const skipped = list.length - room;
    notify.warning(
      `最多支持上传 ${MAX_ATTACHMENTS} 个文件：本次已添加 ${room} 个，另有 ${skipped} 个未添加`,
      { key: 'chat-upload' }
    );
    list = list.slice(0, room);
  }

  // ---- 阶段一：校验 + 读预览 + 图片压缩。单个文件失败只跳过它自己 ----
  const pending: PendingUpload[] = [];
  for (const f of list) {
    if (f.size > MAX_ATTACHMENT_BYTES) {
      notify.warning(
        `文件过大：${f.name}（上限 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB）`,
        { key: 'chat-upload' }
      );
      continue;
    }
    if (!isAllowedAttachment(f)) {
      notify.warning(`不支持的文件类型：${f.name}`, { key: 'chat-upload' });
      continue;
    }

    let dataUrl: string;
    try {
      dataUrl = await readAsDataUrl(f);
    } catch {
      notify.warning(`读取失败：${f.name}`, { key: 'chat-upload' });
      continue;
    }

    // 图片在上传前自动压缩，降低 multipart 请求体大小；预览仍用原图 dataUrl。
    let uploadFile = f;
    if (f.type.startsWith('image/')) {
      try {
        uploadFile = await compressImage(f);
      } catch {
        // 压缩失败不影响上传，回退原文件。
        uploadFile = f;
      }
    }

    pending.push({
      meta: {
        name: f.name,
        size: f.size,
        type: f.type,
        dataUrl,
        uploadStatus: 'uploading'
      },
      raw: f,
      uploadFile,
      // 追加序号：同名文件在同一毫秒内也能拿到互不相同的 key。
      key: `${f.name}_${Date.now()}_${pending.length}`
    });
  }
  if (!pending.length) return;

  // ---- 阶段二：整批一次性入列，UI 立即显示全部 ----
  st.attachments = [...st.attachments, ...pending.map((p) => p.meta)];
  for (const p of pending) {
    st.uploadingFiles.set(p.key, { status: 'uploading' });
  }

  // ---- 阶段三：受限并发上传 ----
  await runWithConcurrency(
    pending.map((p) => () => uploadOneCore(p, st)),
    UPLOAD_CONCURRENCY
  );
}
