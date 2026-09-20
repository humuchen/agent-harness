/**
 * 运行级旁路事件通道（AsyncLocalStorage）。
 *
 * 用途：让「不经过 harness LLM/工具事件流的子系统直连调用」——如 TypeSafe Jev 决策模型的
 * 注入门禁（guardrails）/ 上下文压缩（harness fitToBudget）/ 内置工具（builtin__jev_decide）——
 * 也能把调用事实作为 run 事件上报，而无需改动这些子系统函数的签名
 * （对 core 工具/护栏体系零侵入，与 run-user.ts 的 ALS 模式同构）。
 *
 * 使用方：
 * - harness.run() 入口以 runWithEventSink(sink, fn) 包裹主循环，sink = onEvent；
 * - typesafe-jev.ts 的 jevDecide 在 HTTP 调用成功/失败后 emitRunEvent({ type: 'jev:call', ... })；
 * - access/server 与前端 traceHandle 对 'jev:call' 事件建轻量 trace 节点，让
 *   「typesafe 后台有调用量」在系统调用链可见。
 *
 * 注意：AsyncLocalStorage 上下文只在「同一异步链路」内可见。发生在 harness.run() 之前的
 * 调用（如 TaskRouter 的意图分类，TASK_ROUTER 阶段）不在链路内，收不到通道事件——
 * 这类路径维持原有 structLog + 进程级统计可观测，不强行补链。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** 旁路事件：type 为字符串标签，其余字段随事件而定（宽松结构，转发层按 type 消费）。 */
export interface RunSideEvent {
  type: string;
  [key: string]: unknown;
}

export type RunEventSink = (e: RunSideEvent) => void;

const storage = new AsyncLocalStorage<RunEventSink>();

/** 读取当前异步链路上的事件汇；不在 runWithEventSink 内时返回 null。 */
export function getRunEventSink(): RunEventSink | null {
  return storage.getStore() ?? null;
}

/**
 * 向当前 run 的事件汇发一条旁路事件。
 * 无事件汇（调用发生在 run 链路外）/ 汇抛错时静默返回——观测通道永不干扰主流程。
 */
export function emitRunEvent(e: RunSideEvent): void {
  const sink = storage.getStore();
  if (!sink) return;
  try {
    sink(e);
  } catch {
    /* 观测通道异常不影响业务 */
  }
}

/** 在指定事件汇上下文内执行 fn（同步或异步），返回其结果。sink 为空时直接执行（零包裹开销）。 */
export function runWithEventSink<T>(
  sink: RunEventSink | null | undefined,
  fn: () => T
): T {
  if (!sink) return fn();
  return storage.run(sink, fn);
}
