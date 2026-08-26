import { defineConfig } from 'vite';

// 构建产物默认输出到 dist/（frontend/webapp/dist），
// 由 access/server 服务端同源托管（server.ts 优先读取该目录）。
export default defineConfig({
  build: {
    // 输出为可直接被 node:http 静态托管的纯静态资源（无 SSR）。
    target: 'es2022',
  },
  // history 路由回退：dev 模式下 /chat 等深链接刷新时返回 index.html，
  // 与生产端 server.ts 的 SPA fallback 行为保持一致。
  // 注意：Vite 5 中 appType 默认即 'spa'（自带 history fallback），此处显式声明。
  appType: 'spa',
  server: {
    // 本地 dev 时把 /api 代理到已启动的 ui server（默认 4173）。
    proxy: {
      '/api': {
        target: process.env.AH_API_TARGET || 'http://localhost:4173',
        changeOrigin: true,
      },
    },
  },
});
