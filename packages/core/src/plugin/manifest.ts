/**
 * 插件清单（P1.③ 插件框架骨架）。
 *
 * 设计目标：用一份可 JSON 序列化的 PluginManifest 描述「一个可插拔能力包」，
 * 让第三方/行业 agent 以统一形态入驻平台。清单的 `capabilities` 会自动转成
 * AgentCard 注册进 Registry（见 loader.ts），从而被 TaskRouter 选中、被 A2A 派发、
 * 被工作流引用 —— 与核心 agent 走完全相同的代码路径（演进而非重写）。
 *
 * 与既有约定一致：
 * - 全部字段可 JSON 序列化（无函数/类实例）；
 * - `transport`/`endpoint` 直接复用 AgentCard 语义，远端行业 agent 天然支持入驻。
 */

import type { AgentCapability, AgentTransport } from '../agents/types';

/** 插件清单。 */
export interface PluginManifest {
  /** 唯一插件 id（同时作为注册进 Registry 的 agentId）。 */
  id: string;
  /** 语义化版本号（如 "1.2.0"）。 */
  version: string;
  /** 展示名（缺省用 id）。 */
  name?: string;
  description?: string;
  /** 能力声明：启用时自动转成 AgentCard.capabilities，供能力索引 / 路由发现。 */
  capabilities: AgentCapability[];
  /** 依赖的其它插件 id（启用前必须已全部安装；版本约束留 P2 远程 registry）。 */
  dependencies?: string[];
  /** 权限声明（P2 配额/合规/最小权限用，骨架层仅记录）。 */
  permissions?: string[];
  /** 接入/协作传输方式（复用 AgentCard 语义；远端行业 agent 设 a2a+endpoint）。 */
  transport?: AgentTransport;
  /** 远端地址（transport=a2a/mcp 时必填）。 */
  endpoint?: string;
  /** 隔离加载入口（P2 真实 worker/容器加载用；骨架层仅记录，不强制加载）。 */
  entry?: string;
}
