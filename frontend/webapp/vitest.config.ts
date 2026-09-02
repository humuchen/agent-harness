import { defineConfig } from 'vitest/config';

// Webapp 单元测试配置：仅覆盖「纯函数 / 无 DOM 依赖」模块（utils、由 chat.ts 拆出的工具集等）。
// 不挂载 Lit 组件 / 不拉起真实 server，保持秒级、可在 CI 并行。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false
  }
});
