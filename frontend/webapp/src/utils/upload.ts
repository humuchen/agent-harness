/**
 * upload：前端附件上传的纯函数实现（与 UI 组件解耦，便于单测）。
 *
 * 服务端 /api/upload 走鉴权（guard 'upload:file'），故必须复用 authedFetch
 * （携带会话头，401 时统一跳转登录），不能用裸 fetch（否则未带凭证会被 401 拦）。
 * 返回结构对齐 server 的 handleUpload：{ ok, meta:{ url } }。
 */
import { authedFetch } from '../api';

export interface UploadResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/** 把单个文件 POST 到 /api/upload，成功返回服务端 URL（供 <img> 预览/回显）。 */
export async function uploadFileToApi(file: File): Promise<UploadResult> {
  try {
    const formData = new FormData();
    formData.append('file', file, file.name);
    const resp = await authedFetch('/api/upload', { method: 'POST', body: formData });
    const json = (await resp.json().catch(() => null)) as
      | { ok: true; meta: { url: string } }
      | { ok: false; error?: string }
      | null;
    if (json && json.ok && json.meta?.url) return { ok: true, url: json.meta.url };
    return { ok: false, error: json && !json.ok ? json.error : '上传失败' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '上传失败' };
  }
}
