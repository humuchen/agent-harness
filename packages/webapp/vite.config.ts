import { defineConfig } from 'vite';

// 构建产物默认输出到 dist/（packages/webapp/dist），
// 由 packages/server 服务端同源托管（server.ts 优先读取该目录）。
export default defineConfig({
  build: {
    // 输出为可直接被 node:http 静态托管的纯静态资源（无 SSR）。
    target: 'es2022',
  },
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
