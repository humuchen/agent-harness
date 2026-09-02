/**
 * 插件加载器（P1.③ 插件框架骨架 + P3 业务插件契约）。
 *
 * 生命周期：install → enable →（run）→ disable / upgrade / uninstall。
 * 骨架层聚焦「清单 → AgentCard 注册」这一核心闭环，让插件能力无缝进入既有的路由/编排/隔离体系：
 * - install / installModule：登记（默认 disabled，不立即暴露给 router）。installModule 额外持有
 *   代码形态的 PluginModule（生命周期钩子），install 仅持清单（远端/静态声明式插件）。
 * - enable：先隔离钩子（若有）→ 注入 PluginContext 并调用模块 setup(ctx)/onStart(ctx) →
 *   把 manifest.capabilities 转成 AgentCard 注册进 Registry（可被选中执行）。
 * - disable：调用模块 onStop(ctx)（若有）→ 从 Registry 注销。
 * - uninstall：onStop（若仍 enabled）→ onUnload(ctx) 清理全部副作用 → 移出进程。
 * - upgrade：替换 manifest（版本须一致 id），按原启用态重注册。
 *
 * 非侵入式关键：业务插件**只通过 PluginContext 调用 core 已导出的公共 API**，绝不直接 import/修改
 * core 源码；server / web 宿主由运行时注入（PluginContext.server / PluginContext.web，可选）。
 */

import { type AgentCard } from '../agents/types';
import { AgentRegistry } from '../agents/registry';
import type { AgentStore } from '../agents/store';
import { VolatileAgentStore } from '../agents/store';
import type { PluginManifest } from './manifest';
import { PluginRegistryClient, type RegistryEntry } from './registry';
import { verifyManifest } from './signature';
import type { PluginModule } from './module';
import {
  type PluginContext,
  type PluginLogger,
  type ServerExtensionHost,
  type ServerExtension,
  type WebExtensionHost,
  type PluginUIView,
  type PluginEventListener,
  type PluginEvent,
  getPluginToolRegistry,
} from './context';
import { getIntentRouter } from '../router/intent';
import { ToolRegistry } from '../tools';
import { DagEngine } from '../workflow/engine';
import type { StepExecutor } from '../workflow/engine';
import type { WorkflowDef } from '../workflow/types';
import { HttpA2ATransport } from '../a2a/transport';
import type { TaskEnvelope, TaskResult } from '../a2a/types';
import { structLog, emitAlert } from '../telemetry';

/** 插件生命周期状态。 */
export type PluginState = 'installed' | 'enabled' | 'disabled';

/** 插件登记记录。 */
export interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  installedAt: number;
  upgradedAt?: number;
}

export interface PluginLoaderOptions {
  /** 注入 registry（测试用独立实例；缺省用共享单例 getAgentRegistry）。 */
  registry?: AgentRegistry;
  /** 注入 AgentStore（仅当未注入 registry 时生效，构造本地 registry 用）。 */
  store?: AgentStore;
  /**
   * 隔离加载钩子（P2 真实 worker/OS 沙箱加载点）。启用插件前调用一次；
   * 传入 manifest（含 entry），返回即视为「已隔离加载」。骨架层缺省为 no-op。
   */
  sandbox?: (manifest: PluginManifest) => Promise<void> | void;
  /** 服务端扩展宿主（server 注入，插件据此挂载 HTTP 路由/事件钩子）。 */
  serverHost?: ServerExtensionHost;
  /** 前端扩展宿主（webapp 注入，插件据此注册 Tab/面板）。 */
  webHost?: WebExtensionHost;
}

export class PluginLoader {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly modules = new Map<string, PluginModule>();
  private readonly contexts = new Map<string, PluginContext>();
  private readonly eventListeners = new Set<PluginEventListener>();
  /**
   * 插件经 ctx.server / ctx.web 注册的视图/路由注销句柄（按 pluginId 收集）。
   * disable 时对称调用，使「停用」真正生效：已禁用插件的看板 Tab 与 HTTP 路由不再暴露。
   */
  private readonly hostUnregs = new Map<string, Array<() => void>>();
  private readonly registry: AgentRegistry;
  private readonly sandbox?: (manifest: PluginManifest) => Promise<void> | void;
  private serverHost?: ServerExtensionHost;
  private webHost?: WebExtensionHost;

  constructor(opts: PluginLoaderOptions = {}) {
    this.registry = opts.registry ?? new AgentRegistry();
    this.sandbox = opts.sandbox;
    this.serverHost = opts.serverHost;
    this.webHost = opts.webHost;
  }

  /** 注入服务端扩展宿主（server 启动时调用一次）。 */
  setServerHost(host: ServerExtensionHost): void {
    this.serverHost = host;
  }

  /** 注入前端扩展宿主（webapp 启动时调用一次）。 */
  setWebHost(host: WebExtensionHost): void {
    this.webHost = host;
  }

  /** 列出全部已安装插件。 */
  list(): PluginRecord[] {
    return [...this.plugins.values()];
  }

  /**
   * 广播一条事件给所有插件事件订阅者（ctx.events.on）。
   * 与 ctx.events.emit 的区别：只走监听器，不再调用 emitAlert，避免桥接场景下重复告警。
   * 平台侧（runner）把核心 harness 运行事件经此方法桥接进插件总线，使插件能订阅
   * run:start / run:end 等运行时事件（如客服对话记录），全程无业务耦合。
   */
  broadcast(e: PluginEvent): void {
    for (const l of this.eventListeners) {
      try {
        void l(e);
      } catch {
        /* 单个监听器异常不影响其它 */
      }
    }
  }

  /** 取单个插件记录。 */
  get(id: string): PluginRecord | undefined {
    return this.plugins.get(id);
  }

  /**
   * 从远程 registry 拉取并安装插件（P2.b 插件市场）。
   * - 拉取清单 + 签名；当 `verifySecret` 给定时执行签名校验（HMAC/Ed25519），验签失败抛错；
   * - 解析目标版本（默认 latest）；依赖解析通过后登记（默认 disabled）；
   * - 若 `autoEnable` 为 true，安装后立即启用（经 sandbox 隔离钩子 + 注册 AgentCard）。
   * 本地 install() 路径完全不变，本方法仅扩展「远程拉取」入口。
   */
  async installFromRegistry(
    client: PluginRegistryClient,
    registryUrl: string,
    id: string,
    version?: string,
    opts: { verifySecret?: string; scheme?: 'hmac' | 'ed25519'; autoEnable?: boolean } = {}
  ): Promise<PluginRecord> {
    const entry: RegistryEntry = await client.get(registryUrl, id, version);
    if (opts.verifySecret) {
      const ok = verifyManifest(
        entry.manifest,
        entry.signature ?? '',
        opts.verifySecret,
        opts.scheme ?? 'hmac'
      );
      if (!ok) throw new Error(`plugin "${id}" signature verification failed`);
    }
    const rec = await this.install(entry.manifest);
    if (opts.autoEnable) await this.enable(id);
    return rec;
  }

  /** 安装：依赖解析通过后登记，默认 disabled（不暴露于路由）。 */
  async install(manifest: PluginManifest): Promise<PluginRecord> {
    if (this.plugins.has(manifest.id)) {
      throw new Error(`plugin already installed: ${manifest.id}`);
    }
    this.resolveDependencies(manifest);
    const rec: PluginRecord = { manifest, state: 'disabled', installedAt: Date.now() };
    this.plugins.set(manifest.id, rec);
    return rec;
  }

  /**
   * 安装一个代码形态的插件模块（非侵入式主入口）。持有 PluginModule 生命周期钩子，
   * 登记为 disabled；后续 enable() 时注入 PluginContext 并调用 setup/onStart。
   */
  async installModule(mod: PluginModule): Promise<PluginRecord> {
    const manifest = mod.manifest;
    if (this.plugins.has(manifest.id)) {
      throw new Error(`plugin already installed: ${manifest.id}`);
    }
    this.resolveDependencies(manifest);
    this.modules.set(manifest.id, mod);
    const rec: PluginRecord = { manifest, state: 'disabled', installedAt: Date.now() };
    this.plugins.set(manifest.id, rec);
    return rec;
  }

  /** 启用：先隔离加载（若有 sandbox 钩子）→ 注入上下文 + 调模块 setup/onStart → 注册 AgentCard。 */
  async enable(id: string): Promise<PluginRecord> {
    const rec = this.require(id);
    if (rec.state === 'enabled') return rec;
    if (this.sandbox) await this.sandbox(rec.manifest);
    const ctx = this.buildContext(rec);
    const mod = this.modules.get(id);
    if (mod) {
      await mod.setup?.(ctx);
      this.mergePluginTools(rec, ctx);
      await mod.onStart?.(ctx);
    }
    await this.registry.register(this.toAgentCard(rec.manifest));
    rec.state = 'enabled';
    return rec;
  }

  /** 停用：调用模块 onStop（若有）→ 对称撤回插件注册的视图/路由 → 从共享插件工具表移除工具 → 从 Registry 注销。 */
  async disable(id: string): Promise<PluginRecord> {
    const rec = this.require(id);
    if (rec.state === 'enabled') {
      const ctx = this.contexts.get(id);
      const mod = this.modules.get(id);
      if (ctx && mod) {
        try {
          await mod.onStop?.(ctx);
        } catch {
          /* 模块停用异常不阻断注销 */
        }
      }
      // 对称撤回该插件经 ctx.web / ctx.server 注册的视图/路由：
      // 「停用」不仅注销 AgentCard，还应让已禁用插件的看板 Tab 与 HTTP 路由不再暴露，
      // 否则 /api/plugins 仍会渲染其看板、对外仍可调其路由。
      this.unregisterHosts(id);
      this.unmergePluginTools(rec);
      await this.registry.deregister(id);
      rec.state = 'disabled';
    }
    return rec;
  }

  /** 卸载：先停用（若仍 enabled）→ 调 onUnload 清理副作用 → 移出进程。 */
  async uninstall(id: string): Promise<PluginRecord> {
    const rec = this.require(id);
    if (rec.state === 'enabled') await this.disable(id);
    const ctx = this.contexts.get(id);
    const mod = this.modules.get(id);
    if (ctx && mod) {
      try {
        await mod.onUnload?.(ctx);
      } catch {
        /* 卸载清理异常不阻断卸载 */
      }
    }
    this.modules.delete(id);
    this.contexts.delete(id);
    this.plugins.delete(id);
    return rec;
  }

  /** 升级：替换 manifest 并按原启用态重注册（版本/id 须一致）。 */
  async upgrade(id: string, manifest: PluginManifest): Promise<PluginRecord> {
    const rec = this.require(id);
    if (manifest.id !== id) throw new Error(`upgrade manifest id mismatch: ${manifest.id} != ${id}`);
    this.resolveDependencies(manifest);
    const wasEnabled = rec.state === 'enabled';
    if (wasEnabled) await this.disable(id);
    rec.manifest = manifest;
    rec.upgradedAt = Date.now();
    rec.state = 'disabled';
    if (wasEnabled) {
      if (this.sandbox) await this.sandbox(manifest);
      await this.registry.register(this.toAgentCard(manifest));
      rec.state = 'enabled';
    }
    return rec;
  }

  /** 依赖解析：manifest.dependencies 中每一项都须已安装。 */
  private resolveDependencies(manifest: PluginManifest): void {
    for (const dep of manifest.dependencies ?? []) {
      if (!this.plugins.has(dep)) {
        throw new Error(`plugin "${manifest.id}" depends on missing plugin "${dep}"`);
      }
    }
  }

  private require(id: string): PluginRecord {
    const rec = this.plugins.get(id);
    if (!rec) throw new Error(`plugin not found: ${id}`);
    return rec;
  }

  /** 构造注入给插件的上下文（缓存，生命周期钩子复用同一实例）。 */
  private buildContext(rec: PluginRecord): PluginContext {
    const cached = this.contexts.get(rec.manifest.id);
    if (cached) return cached;
    const manifest = rec.manifest;
    const logger: PluginLogger = {
      info: (m, f) => structLog('info', `[plugin:${manifest.id}] ${m}`, f),
      warn: (m, f) => structLog('warn', `[plugin:${manifest.id}] ${m}`, f),
      error: (m, f) => structLog('error', `[plugin:${manifest.id}] ${m}`, f),
    };
    const ctx: PluginContext = {
      pluginId: manifest.id,
      manifest,
      config: {},
      logger,
      agentRegistry: this.registry,
      tools: new ToolRegistry(),
      router: getIntentRouter(),
      workflow: {
        createEngine: (executor: StepExecutor) => new DagEngine({ executor }),
        validate: (def: WorkflowDef) => {
          const probe = new DagEngine({ executor: async () => undefined });
          probe.validateWorkflow(def);
        },
      },
      a2a: {
        transport: (baseUrl: string) => new HttpA2ATransport(baseUrl),
        send: async (envelope: TaskEnvelope, baseUrl?: string): Promise<TaskResult> => {
          const url = baseUrl ?? process.env.AGENT_A2A_BASE_URL ?? '';
          if (!url) throw new Error('a2a.send 需要 baseUrl 或 AGENT_A2A_BASE_URL');
          return new HttpA2ATransport(url).send(envelope);
        },
      },
      events: {
        on: (l: PluginEventListener) => {
          this.eventListeners.add(l);
          return () => this.eventListeners.delete(l);
        },
        emit: (e) => {
          for (const l of this.eventListeners) {
            try {
              void l(e);
            } catch {
              /* 单个监听器异常不影响其它 */
            }
          }
          // 桥接到服务端宿主：ServerPluginHost.emit 内已硬编码把 memo:reminder
          // 事件经 reminder-bus 推前端 SSE（plugin-ext.ts）。否则插件 fire 的事件
          // 只在本 loader 内部总线流转，前端永远收不到提醒（曾导致「去喝水」提醒丢失）。
          try {
            this.serverHost?.emit(e);
          } catch {
            /* 宿主桥接异常不影响插件自身 */
          }
          emitAlert('warn', `plugin.${e.type}`, String(e.message ?? e.type), {
            plugin: manifest.id,
            ...e,
          });
        },
      },
      // 注入宿主时包一层：收集插件注册视图/路由的注销句柄，供 disable 对称撤回。
      server: this.serverHost
        ? {
            registerExtension: (ext: ServerExtension) => {
              const unreg = this.serverHost!.registerExtension(ext);
              const id = manifest.id;
              const arr = this.hostUnregs.get(id) ?? [];
              arr.push(unreg);
              this.hostUnregs.set(id, arr);
              return unreg;
            },
            // 透传插件事件给宿主（如 memo:reminder → reminder-bus → 前端 SSE）。
            emit: (e: PluginEvent) => {
              this.serverHost!.emit(e);
            },
          }
        : undefined,
      web: this.webHost
        ? {
            registerView: (view: PluginUIView) => {
              const unreg = this.webHost!.registerView(view);
              const id = manifest.id;
              const arr = this.hostUnregs.get(id) ?? [];
              arr.push(unreg);
              this.hostUnregs.set(id, arr);
              return unreg;
            },
          }
        : undefined,
      env: process.env,
    };
    this.contexts.set(manifest.id, ctx);
    return ctx;
  }

  /** 把插件专属 ToolRegistry 合并进进程共享插件工具表（前缀 `${pluginId}__` 做命名空间隔离）。 */
  private mergePluginTools(rec: PluginRecord, ctx: PluginContext): void {
    const shared = getPluginToolRegistry();
    const prefix = `${rec.manifest.id}__`;
    for (const { name, schema, fn } of ctx.tools.entries()) {
      const full = name.startsWith(prefix) ? name : prefix + name;
      shared.register(full, schema.description, schema.parameters as Record<string, unknown>, fn, `plugin:${rec.manifest.id}`);
    }
  }

  /** 从进程共享插件工具表移除该插件工具（按前缀）。 */
  private unmergePluginTools(rec: PluginRecord): void {
    const shared = getPluginToolRegistry();
    const prefix = `${rec.manifest.id}__`;
    for (const { name } of shared.entries()) {
      if (name.startsWith(prefix)) shared.unregister(name);
    }
  }

  /**
   * 对称撤回某插件经 ctx.server / ctx.web 注册的视图与路由。
   * 由 enable 时 buildContext 注入的包装层收集注销句柄；这里逐个执行并清空。
   * 注意：仅撤回该插件自身注册的内容，不影响其它插件或内置宿主项。
   */
  private unregisterHosts(id: string): void {
    const unregs = this.hostUnregs.get(id);
    if (!unregs) return;
    for (const unreg of unregs) {
      try {
        unreg();
      } catch {
        /* 单个宿主撤回异常不影响其它 */
      }
    }
    this.hostUnregs.delete(id);
  }

  /** 把 PluginManifest 的能力声明转成可路由的 AgentCard（复用既有 agent 代码路径）。 */
  private toAgentCard(m: PluginManifest): AgentCard {
    return {
      id: m.id,
      name: m.name ?? m.id,
      // 插件可声明行业域（用于合规画像叠加 + 跨行业不可信隔离升级），缺省 generic。
      domain: (m.domain as AgentCard['domain']) ?? 'generic',
      description: m.description,
      capabilities: m.capabilities,
      transport: m.transport ?? 'local',
      endpoint: m.endpoint,
      version: m.version,
      // 插件可声明最低隔离级别（P2.d），经 resolveIsolationBackend 收敛。
      isolation: m.isolation,
      // 插件可声明装配配方（系统提示词 / 技能 / MCP / 工具面收窄），复用 AgentAssembly。
      assembly: m.assembly,
      // 启用即视为健康；真实探活/心跳留 P2。
      health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
    };
  }
}
