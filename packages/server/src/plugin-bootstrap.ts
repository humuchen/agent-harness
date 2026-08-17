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

import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import {
  PluginLoader,
  getAgentRegistry,
  type PluginModule,
} from '@agent-harness/core';
import { structLog } from '@agent-harness/core';
import { ServerPluginHost, WebPluginHost } from './plugin-ext';

/** 插件系统（loader + 双宿主）。 */
export interface PluginSystem {
  loader: PluginLoader;
  serverHost: ServerPluginHost;
  webHost: WebPluginHost;
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
 * 发现并启用插件。
 * - 入口经 env AGENT_PLUGINS（逗号分隔的 .js 路径）指定；未配置则尝试默认客服插件。
 * - 默认入口不存在时静默跳过（避免无插件部署刷错误日志）。
 * - 每个入口应 `export default` 一个 PluginModule（或 `export const plugin`）。
 */
export async function bootstrapPlugins(system: PluginSystem): Promise<string[]> {
  const envList = (process.env.AGENT_PLUGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = ['../../plugins/customer-service/dist/index.js'];
  const entries = envList.length ? envList : defaults;
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
