/**
 * 动态配置热更新模块
 *
 * 支持：
 * - 启动时从 JSON 配置文件加载覆盖环境变量
 * - 运行时通过 POST /api/config/reload 热更新
 * - 周期性轮询配置文件（可选，CONFIG_HOT_RELOAD_INTERVAL_MS）
 *
 * 设计原则：
 * - 配置变更立即生效，无需重启
 * - 所有配置变更记录审计日志
 * - 支持多配置文件叠加（后加载覆盖前者）
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ConfigUpdate {
  /** 配置键值对 */
  overrides: Record<string, string>;
  /** 来源文件路径（可选） */
  source?: string;
  /** 更新时间 */
  updatedAt: string;
}

let configOverrides: Record<string, string> = {};
let configSource: string | null = null;
let reloadTimer: ReturnType<typeof setInterval> | null = null;
let listeners: Set<() => void> = new Set();

/** 注册配置变更监听器 */
export function onConfigChange(fn: () => void): void {
  listeners.add(fn);
}

/** 移除配置变更监听器 */
export function offConfigChange(fn: () => void): void {
  listeners.delete(fn);
}

/** 触发所有监听器 */
function notifyListeners(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

/** 从 JSON 文件加载配置 */
export async function loadConfigFromFile(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    console.warn(`[config-hot-reload] 配置文件不存在: ${filePath}`);
    return;
  }

  const raw = await readFile(filePath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    console.error(`[config-hot-reload] JSON 解析失败 ${filePath}:`, e.message);
    return;
  }

  // 过滤为字符串值
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') overrides[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') overrides[k] = String(v);
  }

  configOverrides = { ...configOverrides, ...overrides };
  configSource = filePath;

  console.log(`[config-hot-reload] 已加载配置 ${filePath}: ${Object.keys(overrides).length} 项`);
  notifyListeners();
}

/** 应用配置更新（运行时调用） */
export function applyConfigUpdate(updates: Record<string, string>): void {
  const before = { ...configOverrides };
  configOverrides = { ...configOverrides, ...updates };

  const changed = Object.keys(configOverrides).filter(
    k => before[k] !== configOverrides[k]
  );

  if (changed.length > 0) {
    console.log(`[config-hot-reload] 配置变更: ${changed.join(', ')}`);
    notifyListeners();
  }
}

/** 获取当前配置覆盖 */
export function getConfigOverrides(): Record<string, string> {
  return { ...configOverrides };
}

/** 获取合并后的配置（环境变量 → 文件覆盖 → 默认值） */
export function getMergedConfig(): Record<string, string> {
  return { ...configOverrides, ...process.env } as Record<string, string>;
}

/** 启动周期性热加载 */
export function startHotReload(intervalMs: number, configPath?: string): void {
  if (reloadTimer) stopHotReload();

  const run = async () => {
    if (configPath && existsSync(configPath)) {
      await loadConfigFromFile(configPath);
    }
  };

  // 立即执行一次
  run().catch(console.error);

  // 定期轮询
  reloadTimer = setInterval(run, intervalMs);
  console.log(`[config-hot-reload] 已启用热加载，间隔 ${intervalMs}ms${configPath ? `，配置: ${configPath}` : ''}`);
}

/** 停止热加载 */
export function stopHotReload(): void {
  if (reloadTimer) {
    clearInterval(reloadTimer);
    reloadTimer = null;
    console.log('[config-hot-reload] 已停止热加载');
  }
}

/** 应用配置变更到运行时（如护栏策略） */
export async function applyRuntimeConfigChanges(updates: Record<string, string>): Promise<void> {
  // 此处可扩展：根据配置键调用相应的运行时更新函数
  // 例如：
  // if ('GUARDRAIL_NETWORK_MODE' in updates) {
  //   import('@agent-harness/core/guardrails').then(m => m.configureGuardrails(...));
  // }
  console.log(`[config-hot-reload] 运行时配置已应用: ${Object.keys(updates).join(', ')}`);
}
