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
  /**
   * 按用户 BYOK 的 TypeSafe AI（Jev 决策模型）Key（明文，服务端从加密库解密后注入）。
   * 子系统（护栏 / 路由 / RAG / 上下文压缩）直调 Jev 时优先使用；缺省回落 env 的
   * TYPESAFE_API_KEY。绝不写入 process.env（避免跨用户泄露）。
   */
  jevApiKey?: string;
  /** 按用户 BYOK 的 TypeSafe 接口地址（优先于 env 的 TYPESAFE_BASE_URL）。 */
  jevBaseUrl?: string;
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

// ─── 运行级 runId 上下文（独立 store，不与 RunUser 混存）─────────────────────
// 用途：把当前 runId 沿 harness.run 的异步链路传递到工具执行层，使插件工具能
// 精确归属「自己是哪个 run」（如 ma 插件按 run 归集对话），替代易串扰的
// 进程级单例变量（并发 run 下 run:end 会清掉其他并发 run 的状态）。
// 独立 store 的原因：server 已用本文件的用户 store 包裹 harness.run，若复用同一
// store，harness 内部的 run() 会在 enterWith 时覆盖用户字段。

const runIdStorage = new AsyncLocalStorage<string>();

/**
 * 在当前异步链路绑定 runId。仅 harness.runInner 开头调用（enterWith 作用于
 * 当前同步执行流的后续 + 其派生的全部异步任务，无需包裹函数体）。
 */
export function bindRunId(runId: string): void {
  runIdStorage.enterWith(runId);
}

/** 读取当前异步链路的 runId；不在 harness.run 内时返回 null。 */
export function getRunId(): string | null {
  return runIdStorage.getStore() ?? null;
}
