/**
 * 插件加载器（P1.③ 插件框架骨架）。
 *
 * 生命周期：install → enable →（run）→ disable / upgrade。骨架层聚焦「清单 → AgentCard
 * 注册」这一核心闭环，让插件能力无缝进入既有的路由/编排/隔离体系：
 * - install：依赖解析（依赖须已安装）→ 登记（默认 disabled，不立即暴露给 router）；
 * - enable：把 manifest.capabilities 转成 AgentCard 注册进 Registry（可被选中执行）；
 *           若注入了 `sandbox` 隔离钩子，则先于注册执行（P2 真实 worker/OS 沙箱加载点）；
 * - disable：从 Registry 注销，退出路由候选；
 * - upgrade：替换 manifest（版本须一致 id），按原启用态重注册能力卡片。
 *
 * 骨架层不实现「真实隔离加载 / 远程 registry 拉取 / 签名校验」——这些在 P2 扩展
 * `plugin/`（对应 plan §3），本文件只预留 `sandbox` 钩子与可注入 registry，便于扩展。
 */

import { type AgentCard } from '../agents/types';
import { AgentRegistry } from '../agents/registry';
import type { AgentStore } from '../agents/store';
import { VolatileAgentStore } from '../agents/store';
import type { PluginManifest } from './manifest';

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
}

export class PluginLoader {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly registry: AgentRegistry;
  private readonly sandbox?: (manifest: PluginManifest) => Promise<void> | void;

  constructor(opts: PluginLoaderOptions = {}) {
    this.registry = opts.registry ?? new AgentRegistry(opts.store ?? new VolatileAgentStore());
    this.sandbox = opts.sandbox;
  }

  /** 列出全部已安装插件。 */
  list(): PluginRecord[] {
    return [...this.plugins.values()];
  }

  /** 取单个插件记录。 */
  get(id: string): PluginRecord | undefined {
    return this.plugins.get(id);
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

  /** 启用：先隔离加载（若有 sandbox 钩子），再把能力卡片注册进 Registry。 */
  async enable(id: string): Promise<PluginRecord> {
    const rec = this.require(id);
    if (rec.state === 'enabled') return rec;
    if (this.sandbox) await this.sandbox(rec.manifest);
    await this.registry.register(this.toAgentCard(rec.manifest));
    rec.state = 'enabled';
    return rec;
  }

  /** 停用：从 Registry 注销，退出路由候选。 */
  async disable(id: string): Promise<PluginRecord> {
    const rec = this.require(id);
    if (rec.state === 'enabled') {
      await this.registry.deregister(id);
      rec.state = 'disabled';
    }
    return rec;
  }

  /** 升级：替换 manifest 并按原启用态重注册（版本/id 须一致）。 */
  async upgrade(id: string, manifest: PluginManifest): Promise<PluginRecord> {
    const rec = this.require(id);
    if (manifest.id !== id) throw new Error(`upgrade manifest id mismatch: ${manifest.id} != ${id}`);
    this.resolveDependencies(manifest);
    const wasEnabled = rec.state === 'enabled';
    if (wasEnabled) await this.registry.deregister(id);
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

  /** 把 PluginManifest 的能力声明转成可路由的 AgentCard（复用既有 agent 代码路径）。 */
  private toAgentCard(m: PluginManifest): AgentCard {
    return {
      id: m.id,
      name: m.name ?? m.id,
      domain: 'generic',
      description: m.description,
      capabilities: m.capabilities,
      transport: m.transport ?? 'local',
      endpoint: m.endpoint,
      version: m.version,
      // 启用即视为健康；真实探活/心跳留 P2。
      health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
    };
  }
}
