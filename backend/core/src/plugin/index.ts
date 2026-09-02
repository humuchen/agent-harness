/**
 * 插件框架模块（P1.③ 骨架）。
 *
 * 用 PluginManifest 描述可插拔能力包，PluginLoader 负责 install/enable/disable/upgrade
 * 生命周期，并把 manifest.capabilities 自动转成 AgentCard 注册进 Registry —— 插件能力
 * 由此无缝进入既有的路由 / 编排 / 隔离体系，与核心 agent 走完全相同代码路径。
 */

export * from './manifest';
export * from './normalize';
export * from './context';
export * from './module';
export * from './loader';
export * from './registry';
export * from './signature';
