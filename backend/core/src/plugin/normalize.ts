/**
 * 插件清单归一化（P2 · manifest 统一）。
 *
 * 背景：真实插件（memo / customer-service / medical-aesthetics-lead）的 manifest 字段齐全、形态一致，
 * 但脚手架脚本 create-plugin.cjs 早期生成的是另一套 schema（requiresIsolation / isolationLevel /
 * 字符串 capabilities / author），且引用了不存在的 PluginRuntime 类型——这是 manifest 漂移的根。
 *
 * 本模块提供单一事实来源：任何来源的 manifest（手写在插件里 / 脚手架生成 / 远端 registry 拉取 /
 * JSON 反序列化）都先经 normalizeManifest 收敛成统一的 PluginManifest，消除「同一字段多种写法」。
 *
 * 非侵入：纯函数、仅填默认值、不修改入参（返回新对象），不依赖任何运行时状态。
 */

import type { AgentCapability, AgentTransport } from '../agents/types';
import type { PluginManifest } from './manifest';

/** 把任意 capabilities 写法（字符串 / {id} / 带其它字段）统一为 AgentCapability[]。 */
function normalizeCapabilities(input: unknown): AgentCapability[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((c): c is string | Record<string, unknown> => typeof c === 'string' || (typeof c === 'object' && c !== null))
    .map((c) => (typeof c === 'string' ? { id: c } : (c as unknown as AgentCapability)));
}

/**
 * 把一份（可能不完整的）manifest 收敛为统一的 PluginManifest：
 * - id 为必填；缺失视为非法（调用方 bootstrap 已先校验 id，这里再兜底抛错，便于早期失败）。
 * - name 缺省用 id；
 * - domain 缺省 'generic'（不触发强合规隔离）；
 * - transport 缺省 'local'；
 * - isolation 缺省 'none'；
 * - capabilities 缺省 []，并统一为 AgentCapability[]（兼容早期字符串写法）；
 * - version 缺省 '0.0.0'。
 * 其余字段（description / dependencies / permissions / endpoint / entry / assembly）原样透传。
 */
export function normalizeManifest(input: Partial<PluginManifest> & { id: string }): PluginManifest {
  if (!input || !input.id) {
    throw new Error('normalizeManifest: manifest.id is required');
  }
  // 保留 input 的 id:string 收窄（勿再 cast 成 Partial，否则 id 会被放宽为 string|undefined）。
  const m = input;
  const out: PluginManifest = {
    id: m.id,
    version: m.version ?? '0.0.0',
    name: m.name ?? m.id,
    description: m.description,
    capabilities: normalizeCapabilities(m.capabilities),
    dependencies: m.dependencies,
    permissions: m.permissions,
    transport: (m.transport as AgentTransport | undefined) ?? 'local',
    endpoint: m.endpoint,
    entry: m.entry,
    domain: m.domain ?? 'generic',
    isolation: m.isolation ?? 'none',
    assembly: m.assembly,
  };
  return out;
}
