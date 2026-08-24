/**
 * 插件上下文（非侵入式插件契约 · 注入面）。
 *
 * 设计要点：
 * - 业务插件**只通过 PluginContext 调用 core 已导出的公共 API**，绝不直接 import/修改 core 源码。
 * - `server` / `web` 宿主由 server / webapp 在运行时注入（core 只定义接口契约，不依赖具体实现，
 *   因此无循环依赖）；未注入时插件可降级（跳过 UI / HTTP 扩展）。
 * - `tools` 是「插件专属」ToolRegistry（隔离命名空间），启用后由 loader 自动合并进进程共享的
 *   插件工具注册表（前缀 `${pluginId}__`），供 server 的 assembleAgent 合并进运行。
 */

import type { AgentRegistry } from '../agents/registry';
import { ToolRegistry } from '../tools';
import type { IntentRouter } from '../router/intent';
import type { DagEngine, StepExecutor } from '../workflow/engine';
import type { WorkflowDef } from '../workflow/types';
import type { HttpA2ATransport } from '../a2a/transport';
import type { TaskEnvelope, TaskResult } from '../a2a/types';
import type { PluginManifest } from './manifest';

/** 结构化日志接口（统一前缀，绝不上报密钥/token）。 */
export interface PluginLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** 插件事件（经核心 alert 通道桥接的轻量事件总线）。 */
export interface PluginEvent {
  type: string;
  [key: string]: unknown;
}
export type PluginEventListener = (e: PluginEvent) => void | Promise<void>;

/** 工作流接入 API：插件注册/校验 DAG。真正的「执行一个 step」由插件注入 StepExecutor（核心不解耦 harness 装配）。 */
export interface PluginWorkflowApi {
  /** 以给定 step 执行器构造一个 DagEngine（复用核心拓扑分层/补偿/检查点能力）。 */
  createEngine(executor: StepExecutor): DagEngine;
  /** 校验 DAG 拓扑合法性（环/未知依赖/重复 stepId），fail-fast。 */
  validate(def: WorkflowDef): void;
}

/** A2A 协作 API：把任务派发给其它 agent（本地 handoff 或跨主机投递）。 */
export interface PluginA2AApi {
  /** 向目标 agent 派发任务；跨主机需 baseUrl（缺省取 env AGENT_A2A_BASE_URL）。 */
  send(envelope: TaskEnvelope, baseUrl?: string): Promise<TaskResult>;
  /** 构造一个跨主机传输（供高级场景复用）。 */
  transport(baseUrl: string): HttpA2ATransport;
}

/** 事件订阅 API：订阅核心事件总线，并向总线发事件（自动桥接 alert 通道）。 */
export interface PluginEventApi {
  /** 订阅；返回注销函数。 */
  on(listener: PluginEventListener): () => void;
  /** 发布一条事件（同时转交核心 emitAlert 以便被 Webhook/日志 sink 捕获）。 */
  emit(event: PluginEvent): void;
}

/** 单个 HTTP 路由处理器（express-free：直接对接 node:http 的 req/res）。 */
export type PluginRouteHandler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
) => void | Promise<void>;

/** 服务端扩展（由插件提供，server 在运行时消费）。 */
export interface ServerExtension {
  /** 扩展 id（同插件应唯一）。 */
  id: string;
  /** 挂载 HTTP 路由：path → 处理器（server 负责准入/前缀/CORS）。 */
  mountRoutes?: Record<string, PluginRouteHandler>;
  /** 订阅核心事件（与 PluginContext.events.on 同款）。 */
  onEvent?: PluginEventListener;
}

/** 服务端扩展宿主：server 注入，插件据此挂载路由/事件钩子（无业务词）。 */
export interface ServerExtensionHost {
  /** 注册一个服务端扩展，返回注销函数。 */
  registerExtension(ext: ServerExtension): () => void;
}

/** 插件前端视图（由插件提供，webapp 在运行时渲染为动态 Tab）。 */
export interface PluginUIView {
  /** Tab 唯一 id（同插件应唯一，避免与其它插件/内置 Tab 冲突）。 */
  tabId: string;
  /** Tab 展示名。 */
  label: string;
  /** 返回一个可直接渲染的 HTML 字符串（webapp 注入到内容区，无框架耦合）。 */
  render(): string;
}

/** 前端扩展宿主：webapp 注入，插件据此注册 Tab/面板（无业务词）。 */
export interface WebExtensionHost {
  /** 注册一个前端视图，返回注销函数。 */
  registerView(view: PluginUIView): () => void;
}

/**
 * 注入给插件的上下文（非侵入式接入面）。
 * 插件只「调用」这些公共 API，不修改 core；server / web 宿主可选注入。
 */
export interface PluginContext {
  /** 插件 id（= manifest.id = 注册进 AgentRegistry 的 agentId）。 */
  readonly pluginId: string;
  /** 插件清单（可 JSON 序列化）。 */
  readonly manifest: PluginManifest;
  /** 合并后的配置（manifest.env + 进程 env）。插件读取配置的唯一入口。 */
  readonly config: Readonly<Record<string, unknown>>;
  /** 统一前缀日志。 */
  readonly logger: PluginLogger;
  /** 进程共享 AgentRegistry（按 capability/domain 发现与注册 agent）。 */
  readonly agentRegistry: AgentRegistry;
  /** 插件专属 ToolRegistry（启用后自动合并进进程共享插件工具表，前缀 `${pluginId}__`）。 */
  readonly tools: ToolRegistry;
  /** 进程共享意图路由器（规则/LLM 意图分类）。 */
  readonly router: IntentRouter;
  /** 工作流 DAG 接入 API。 */
  readonly workflow: PluginWorkflowApi;
  /** A2A 协作 API。 */
  readonly a2a: PluginA2AApi;
  /** 事件订阅/发布 API。 */
  readonly events: PluginEventApi;
  /** 服务端扩展宿主（server 注入；未注入则插件不挂 HTTP 路由）。 */
  readonly server?: ServerExtensionHost;
  /** 前端扩展宿主（webapp 注入；未注入则插件不加 Tab）。 */
  readonly web?: WebExtensionHost;
  /** 进程环境变量（只读视图）。 */
  readonly env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// 进程共享的「插件工具注册表」：所有插件启用时把自身 tools 合并进来（加前缀），
// server 的 assembleAgent 在构造运行工具集时统一 mergeFrom 此表。
// ---------------------------------------------------------------------------

let _pluginTools: ToolRegistry | null = null;
/** 取得进程共享的插件工具注册表（插件系统内部使用；server assembleAgent 也读它）。 */
export function getPluginToolRegistry(): ToolRegistry {
  if (!_pluginTools) _pluginTools = new ToolRegistry();
  return _pluginTools;
}
