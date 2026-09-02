import { defineConfig } from 'vite';
import pkg from './package.json';

// 构建产物默认输出到 dist/（frontend/webapp/dist），
// 由 access/server 服务端同源托管（server.ts 优先读取该目录）。
export default defineConfig(({ mode }) => {
  // 前端不再注入任何密钥材料（P1.4 起 AES-GCM 加解密全部在 server 侧完成，
  // 前端仅以明文经 HTTPS 提交 Key，由服务端加密落库，bundle 零密钥）。
  // __APP_VERSION__ 取自 package.json（login.ts 展示用）。

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      // 输出为可直接被 node:http 静态托管的纯静态资源（无 SSR）。
      target: 'es2022',
      // 测试文件（*.test.ts）仅用于 vitest，禁止打进生产产物。
      rollupOptions: {
        external: [/\.test\.ts$/]
      }
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
          changeOrigin: true
        }
      }
    }
  };
});
