import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadFileToApi, type UploadResult } from './upload';

/**
 * /api/upload 走鉴权（guard 'upload:file'），upload.ts 复用 api.ts 的 authedFetch。
 * 这里整体 mock ../api，避免触碰真实 fetch / document / 登录态，专注单测纯函数逻辑。
 */
vi.mock('../api', () => ({
  authedFetch: vi.fn()
}));

import { authedFetch } from '../api';

function makeFile(name = 'a.png', type = 'image/png'): File {
  return new File(['x'], name, { type });
}

beforeEach(() => {
  (authedFetch as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe('uploadFileToApi', () => {
  it('成功：返回 { ok:true, url }', async () => {
    (authedFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ ok: true, meta: { url: 'https://cdn.example/a.png' } })
    });
    const r: UploadResult = await uploadFileToApi(makeFile());
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://cdn.example/a.png');
    // 追加为 multipart/form-data，字段名 file
    const call = (authedFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('/api/upload');
    expect(call[1].method).toBe('POST');
    expect(call[1].body).toBeInstanceOf(FormData);
  });

  it('服务端返回 ok:false：透传 error 文案', async () => {
    (authedFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ ok: false, error: '文件过大' })
    });
    const r = await uploadFileToApi(makeFile());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('文件过大');
    expect(r.url).toBeUndefined();
  });

  it('网络异常被捕获为 { ok:false, error }', async () => {
    (authedFetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    const r = await uploadFileToApi(makeFile());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('network down');
  });

  it('响应 body 非 JSON：json() 抛错时回退默认文案「上传失败」', async () => {
    (authedFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => {
        throw new Error('bad json');
      }
    });
    const r = await uploadFileToApi(makeFile());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('上传失败');
  });

  it('响应 ok:true 但缺 meta.url：视为失败回退默认文案', async () => {
    (authedFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ ok: true })
    });
    const r = await uploadFileToApi(makeFile());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('上传失败');
  });
});
