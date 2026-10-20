/**
 * ah-drawer：类型出口（Svelte 迁移后组件本体在 ah-drawer.svelte）。
 * 原 AhDrawer 类无外部 import（仅模板使用），此处保留类型导出供需要处引用。
 */
export type {
  DrawerPlacement,
  DrawerCloseReason
} from './ah-drawer.svelte';
