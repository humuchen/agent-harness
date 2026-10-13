/// <reference types="vite/client" />
// Vite 客户端类型：为 `?raw` 等特殊导入提供模块声明（mac-ui-adapter.test.ts 读取
// ah-drawer.svelte 源码断言移动端头部 CSS）。tsconfig 的 types 数组保持 [] 不变，
// 由本文件按需引入，避免全局自动注入全部 @types。

// svelte-check 对 `*.svelte?raw` 不走 vite/client 的 `*?raw` 通配（.svelte 后缀被
// svelte 语言工具优先接管），显式补一条声明。
declare module '*.svelte?raw' {
  const src: string;
  export default src;
}
