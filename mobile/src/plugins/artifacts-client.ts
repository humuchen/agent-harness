/**
 * 移动端 artifacts 上传客户端
 *
 * 复用 server 端既有 `POST /api/artifacts` 端点：
 * - 接收 base64 内容
 * - 需要 artifact:write 权限（与 webapp 共享鉴权体系）
 *
 * 该模块仅做数据组装与 fetch 调用，不重复实现 artifact-store 的存储逻辑。
 */
import { getPlugins } from '../bridge/register-plugins';

export interface UploadArtifactInput {
  name: string;
  contentBase64: string; // 不含 data: 前缀的纯 base64
  mimeType?: string;
  kind?: string;
  note?: string;
}

export interface UploadArtifactResult {
  ok: boolean;
  item?: {
    id: string;
    name: string;
    sizeBytes: number;
    createdAt: string;
  };
  error?: string;
}

const API_BASE = '/api';

/**
 * 上传 artifact（同源 cookie 鉴权）。
 * 自动从 Preferences 读取 token 注入 Authorization 头（如需要）。
 */
export async function uploadArtifact(
  input: UploadArtifactInput
): Promise<UploadArtifactResult> {
  const { isNative } = getPlugins();
  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };

  // 移动端：从 Preferences 读取 token 注入（如 server 走静态令牌模式）
  if (isNative) {
    const { preferences } = getPlugins();
    const result = await preferences.get({ key: 'auth_token' });
    if (result.value) {
      headers['authorization'] = `Bearer ${result.value}`;
    }
  }

  try {
    const res = await fetch(`${API_BASE}/artifacts`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({
        name: input.name,
        contentBase64: input.contentBase64,
        mimeType: input.mimeType ?? 'application/octet-stream',
        kind: input.kind ?? 'other',
        note: input.note
      })
    });

    const data = (await res.json().catch(() => ({}))) as {
      item?: UploadArtifactResult['item'];
      error?: string;
    };

    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, item: data.item };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'network error' };
  }
}

/**
 * 从 data URL 提取纯 base64（去掉 `data:image/xxx;base64,` 前缀）。
 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}
