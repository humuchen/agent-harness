import { describe, it, expect, vi } from 'vitest';
import { registerServiceWorker, SW_PATH } from './sw-register';

/** 构造最小 ServiceWorkerContainer 替身（只实现 register 面）。 */
function makeSwApi(ok = true) {
  const register = vi.fn(async () => ({ scope: '/' }));
  if (!ok) {
    register.mockRejectedValue(new Error('quota exceeded'));
  }
  return { register } as unknown as ServiceWorkerContainer;
}

describe('registerServiceWorker', () => {
  it('环境不支持（无 serviceWorker）→ 返回 null 且不抛错', async () => {
    const out = await registerServiceWorker(undefined, {
      protocol: 'https:',
      hostname: 'example.com'
    });
    expect(out).toBeNull();
  });

  it('非安全上下文（http + 非本机）→ 策略跳过，不调用 register', async () => {
    const swApi = makeSwApi();
    const out = await registerServiceWorker(swApi, {
      protocol: 'http:',
      hostname: '192.168.1.5'
    });
    expect(out).toBeNull();
    expect(swApi.register).not.toHaveBeenCalled();
  });

  it('http + localhost（开发环境）→ 允许注册，路径为 /sw.js、scope 根', async () => {
    const swApi = makeSwApi();
    const out = await registerServiceWorker(swApi, {
      protocol: 'http:',
      hostname: 'localhost'
    });
    expect(out).toEqual({ scope: '/' });
    expect(swApi.register).toHaveBeenCalledExactlyOnceWith(SW_PATH, { scope: '/' });
  });

  it('https 任意主机 → 注册', async () => {
    const swApi = makeSwApi();
    const out = await registerServiceWorker(swApi, {
      protocol: 'https:',
      hostname: 'ah.example.com'
    });
    expect(out).toEqual({ scope: '/' });
    expect(swApi.register).toHaveBeenCalledTimes(1);
  });

  it('注册失败（reject）→ 静默返回 null，不向调用方抛错', async () => {
    const out = await registerServiceWorker(makeSwApi(false), {
      protocol: 'https:',
      hostname: 'ah.example.com'
    });
    expect(out).toBeNull();
  });
});
