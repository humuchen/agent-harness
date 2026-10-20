/**
 * agent-harness webapp Service Worker（评审 P2-10：离线仅保偏好不保视图 →
 * 最小 app-shell 缓存，断网时至少能打开应用壳与已缓存的静态资产）。
 *
 * 刻意的最小边界（每一条都是安全/正确性取舍，改动须同步 sw-register.ts 注释）：
 * - **/api/* 一律不拦截**：SSE 长连接、认证、业务请求全部网络直通——SW 不参与
 *   流式响应（经 SW 转发 EventSource / fetch stream 有缓冲风险），也绝不缓存
 *   任何动态 / 鉴权数据；
 * - 非 GET（写操作）与跨源请求直通；
 * - 同源静态资产（vite hash 文件名）cache-first：命中即离线可用，发版换 hash
 *   自然失效；
 * - 导航请求 network-first：有网先拿最新 index.html（保版本新鲜），失败回缓存壳；
 * - 版本化缓存名（CACHE）+ activate 清旧：改此常量即触发全量资产刷新。
 */
const CACHE = 'ah-shell-v1';
const PRECACHE = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 跨源 / 非 GET / API（含 SSE）直通：SW 完全不介入。
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求：network-first，离线回缓存壳（app shell 可打开）。
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // best-effort 刷新壳缓存；失败不影响本次响应。
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((c) => c.put('/', copy))
            .catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match('/').then((r) => r ?? Response.error())
        )
    );
    return;
  }

  // 同源静态资产：cache-first。
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ??
        fetch(event.request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches
                .open(CACHE)
                .then((c) => c.put(event.request, copy))
                .catch(() => {});
            }
            return res;
          })
          .catch(() => Response.error())
    )
  );
});
