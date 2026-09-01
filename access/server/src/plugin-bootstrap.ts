/**
 * 插件引导（Phase 1 · 组合根，无业务词）。
 *
 * 职责：在 server 启动时构造 PluginLoader + 双宿主（Server/Web），并**发现并启用**插件。
 *
 * 非侵入关键点：本文件用「动态 require」加载插件入口（默认 plugins/customer-service/dist），
 * server 源码**不静态 import 任何具体插件包**——具体插件只经配置（AGENT_PLUGINS）在运行时接入。
 * 新增任意业务插件（客服 / 工单 / 营销…）都无需改本文件、无需改 core。
 *
 * 健壮性：单插件加载/启用失败仅告警并跳过，绝不拖垮主服务启动。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import {
  PluginLoader,
  PluginRegistryClient,
  getAgentRegistry,
  normalizeManifest,
  type PluginManifest,
  type PluginModule,
  type PluginEvent,
} from '@agent-harness/core';
import { structLog } from '@agent-harness/core';
import { ServerPluginHost, WebPluginHost } from './plugin-ext';

/** 插件系统（loader + 双宿主）。 */
export interface PluginSystem {
  loader: PluginLoader;
  serverHost: ServerPluginHost;
  webHost: WebPluginHost;
}

/**
 * 进程级插件系统单例引用（由 bootstrapPlugins 在启用期写入）。
 * runner 等模块经 getPluginSystem() 取得 loader，把核心 harness 运行事件桥接进插件总线。
 */
let _system: PluginSystem | null = null;

/** 取当前插件系统（未引导返回 null）。 */
export function getPluginSystem(): PluginSystem | null {
  return _system;
}

/** 把一条核心 harness 运行事件桥接给所有插件事件订阅者（无业务词）。 */
export function bridgeHarnessEvent(e: PluginEvent): void {
  _system?.loader.broadcast(e);
}

/** 构造插件系统：把 server/web 宿主注入 loader，使插件经 PluginContext 挂路由/视图。 */
export function createPluginSystem(): PluginSystem {
  const serverHost = new ServerPluginHost();
  const webHost = new WebPluginHost();
  // 复用进程共享 AgentRegistry（与 /api/agents、运行期路由同源），插件 agent 启用后即可被
  // 能力索引发现、被 TaskRouter 选中、被 A2A/工作流引用——与核心 agent 走完全相同路径。
  const loader = new PluginLoader({ serverHost, webHost, registry: getAgentRegistry() });
  return { loader, serverHost, webHost };
}

/**
 * 目录自动发现：扫描给定 plugins 目录，收集所有「含 dist/index.js 入口」的插件绝对路径。
 *
 * 纯函数（目录路径由调用方传入），便于单测。发现规则：
 * - 仅遍历直接子目录（一层），不递归；
 * - 子目录存在 `<sub>/dist/index.js` 即视为合法插件入口；
 * - 按目录名排序，保证发现顺序确定（不依赖文件系统遍历次序）。
 *
 * 注意：只产出「候选入口路径」，是否真正启用由 bootstrapPlugins 的 require + 契约校验决定。
 */
export function discoverPluginEntries(pluginsDir: string): string[] {
  if (!existsSync(pluginsDir)) return [];
  try {
    return readdirSync(pluginsDir)
      .filter((name) => {
        try {
          const full = join(pluginsDir, name);
          return statSync(full).isDirectory() && existsSync(join(full, 'dist', 'index.js'));
        } catch {
          return false;
        }
      })
      .sort()
      .map((name) => join(pluginsDir, name, 'dist', 'index.js'));
  } catch {
    return [];
  }
}

/**
 * 发现并启用插件。
 * - 入口经 env AGENT_PLUGINS（逗号分隔的 .js 路径）指定；这是**显式覆盖**，优先级最高。
 * - 未配置 AGENT_PLUGINS 时，自动扫描 `plugins/` 目录（目录自动发现）；扫描为空才回落到
 *   三个内置默认插件路径（兼容 Render 等无法解析相对目录的部署形态）。
 * - 每个入口应 `export default` 一个 PluginModule（或 `export const plugin`）。
 * - 加载后先经 normalizeManifest 收敛为统一 manifest 形态（消除 manifest 漂移），再 install/enable。
 */
export async function bootstrapPlugins(system: PluginSystem): Promise<string[]> {
  _system = system;
  const envList = (process.env.AGENT_PLUGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // __dirname = access/server/dist → 需上溯三级到仓库根：../../../plugins/...
  const pluginsDir = resolve(__dirname, '../../../plugins');
  let entries: string[];
  if (envList.length) {
    entries = envList;
  } else {
    const scanned = discoverPluginEntries(pluginsDir);
    if (scanned.length) {
      entries = scanned;
    } else {
      // 兜底：扫描无果时回落三个内置默认插件（与历史部署行为一致）。
      entries = [
        '../../../plugins/customer-service/dist/index.js',
        '../../../plugins/medical-aesthetics-lead/dist/index.js',
        '../../../plugins/memo/dist/index.js',
      ];
    }
  }
  const enabled: string[] = [];

  for (const entry of entries) {
    const abs = isAbsolute(entry) ? entry : resolve(__dirname, entry);
    if (!existsSync(abs)) {
      if (envList.length === 0) {
        structLog('debug', 'plugin.bootstrap.skip', {
          entry,
          reason: 'not found and AGENT_PLUGINS not set (no plugin deployed)',
        });
      } else {
        structLog('warn', 'plugin.bootstrap.skip', { entry, reason: 'file not found' });
      }
      continue;
    }
    try {
      // 动态 require（CommonJS）：server 不静态依赖任何具体插件包。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const req: NodeRequire = require;
      const loaded: any = req(abs);
      const mod: PluginModule | undefined = loaded?.default ?? loaded?.plugin ?? loaded;
      if (!mod || !mod.manifest || !mod.manifest.id) {
        structLog('warn', 'plugin.bootstrap.skip', { entry, reason: 'no default PluginModule export' });
        continue;
      }
      // manifest 归一化（统一形态，消除早期 schema 漂移），不修改插件原对象。
      mod.manifest = normalizeManifest(mod.manifest);
      await system.loader.installModule(mod);
      await system.loader.enable(mod.manifest.id);
      enabled.push(mod.manifest.id);
      structLog('info', 'plugin.bootstrap.enabled', { id: mod.manifest.id, entry });
    } catch (e: any) {
      structLog('error', 'plugin.bootstrap.failed', { entry, error: e?.message ?? String(e) });
    }
  }
  return enabled;
}

/**
 * 解析插件升级目标 manifest（Phase 4 · 版本/依赖解析）。
 * - 优先用请求体中的 `manifest`（平台已校验过的完整清单）；
 * - 否则用 `PLUGIN_REGISTRY_URL` + `version` 经 registry 索引 + `resolveVersion` 拉取；
 *   version 支持 `latest` / `^x.y.z` / 精确版本。
 * 拉取到的 manifest 交给 `loader.upgrade`，其内部会按 `resolveDependencies` 校验依赖
 * 并按原启用态重注册——全链路复用既有能力，无新实现。
 */
export async function resolveUpgradeManifest(
  id: string,
  body: { manifest?: PluginManifest; version?: string }
): Promise<PluginManifest> {
  if (body.manifest && body.manifest.id === id) return body.manifest;
  const registryUrl = process.env.PLUGIN_REGISTRY_URL;
  if (registryUrl && body.version) {
    const client = new PluginRegistryClient();
    const entries = await client.index(registryUrl);
    const matched = entries.filter((e) => e.id === id);
    if (matched.length === 0) throw new Error(`plugin "${id}" not found in registry`);
    return client.resolveVersion(matched, body.version).manifest;
  }
  throw new Error('upgrade requires body.manifest or PLUGIN_REGISTRY_URL + version');
}
