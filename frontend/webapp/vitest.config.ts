import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Webapp 单元测试配置：覆盖「纯函数 / 无 DOM 依赖」模块（utils、由 chat.ts 拆出的工具集等）
// 以及 Svelte 组件（jsdom 挂载）。不拉起真实 server，保持秒级、可在 CI 并行。
export default defineConfig({
  plugins: [svelte()],
  // 组件测试用 mount()（client API）：vitest 默认走 svelte 的 server 导出，
  // 需强制 browser 条件解析（vite-plugin-svelte 官方推荐写法）。
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  // 与 vite.config.ts 对齐：组件模块在顶层读取 __APP_VERSION__（user-menu / settings-center），
  // 测试进程不经 vite build，需在此显式注入，否则 import 阶段即 ReferenceError。
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test')
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false
  }
});
