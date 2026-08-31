import { defineConfig, loadEnv } from 'vite';
import pkg from './package.json';

// 构建产物默认输出到 dist/（frontend/webapp/dist），
// 由 access/server 服务端同源托管（server.ts 优先读取该目录）。
export default defineConfig(({ mode }) => {
  // Vite 不会把 .env 填进 process.env（仅 VITE_ 前缀进 import.meta.env），
  // 这里用 loadEnv 从【仓库根】显式加载全部变量，供 define 注入使用。
  // 第三个参数 '' 表示不做 VITE_ 前缀过滤（AH_CRYPTO_KEY 等私有变量也需要）。
  const rootEnv = loadEnv(mode, process.cwd() + '/../..', '');

  return {
    define: {
      // build-time 注入 AES-256 key（64 hex chars）；前端用于 AES-GCM 加密自定义模型 apiKey。
      // 要求：仓库根 .env 中 AH_CRYPTO_KEY 为 64 位十六进制字符串（32 bytes），
      // 与服务端解密（custom-models.ts 读同名环境变量）共用同一值。
      __AH_CRYPTO_KEY__: JSON.stringify(rootEnv.AH_CRYPTO_KEY || ''),
      // build-time 注入应用版本号，取自 package.json（login.ts 展示用）。
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      // 输出为可直接被 node:http 静态托管的纯静态资源（无 SSR）。
      target: 'es2022'
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
