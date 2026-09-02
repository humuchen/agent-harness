/**
 * 运行级用户上下文（AsyncLocalStorage）。
 *
 * 用途：把「当前登录用户」沿一次 agent 运行的异步链路传递到工具执行层，
 * 使业务插件（如 memo 备忘）能把数据与登录用户绑定，而无需改动
 * ToolRegistry.call / ToolFn 的既有签名（对 core 工具体系零侵入）。
 *
 * 使用方：
 * - server（access/server）在执行 run 前 runWithUser({ sub }, fn) 包裹 harness.run；
 * - 插件工具在执行期 getRunUser() 读取归属用户（无上下文时返回 null，调用方自行兜底）。
 *
 * 注意：AsyncLocalStorage 上下文只在「同一异步链路」内可见。经 run-queue 异步执行
 * 的任务必须在 execute 内（真正调用 harness.run 处）包裹，而不是在 HTTP 请求入口
 * 包裹（请求返回后上下文已销毁，队列 worker 不在原链路上）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** 运行级用户身份（与 access/server 的 AuthContext 子集对齐，只保留归属所需字段）。 */
export interface RunUser {
  /** 归属主体标识（账户模式下为登录用户名）。 */
  sub: string;
  /** 展示名（可选）。 */
  name?: string;
}

const storage = new AsyncLocalStorage<RunUser>();

/** 读取当前异步链路上的用户上下文；不在 runWithUser 内时返回 null。 */
export function getRunUser(): RunUser | null {
  return storage.getStore() ?? null;
}

/** 在指定用户上下文内执行 fn（同步或异步），返回其结果。 */
export function runWithUser<T>(user: RunUser | null, fn: () => T): T {
  if (!user) return fn();
  return storage.run(user, fn);
}
