/**
 * chat.ts 历史持久化抽离（Phase 2）。
 *
 * 原 `saveHistory` 只是 `saveThread`（chat-history.ts）的薄包装：取当前会话缓冲 +
 * 构造 `MirroredUsage` 用量快照后落盘。抽为纯函数 `persistHistory(opts)`，
 * 由调用方传入 threads / sessions / 用量快照，零 this.* 依赖，便于单测与复用。
 */
import { saveThread, type MirroredUsage } from './chat-history';
import type { ChatMsg, SessionView } from './chat-types';

/** 后端经 SSE `llm:usage` 下发的精确上下文用量结构（与 AhChat.backendUsage 对齐）。 */
export interface BackendUsageLike {
  window: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 自上次用量上报以来是否发生过上下文压缩（历史淘汰）。 */
  compressed?: boolean;
  breakdown: {
    system: number;
    tools: number;
    messages: number;
    mcp: number;
    skills: number;
    completion: number;
  };
}

/** persistHistory 入参：调用方（AhChat）传入当前快照。 */
export interface PersistHistoryOpts {
  sid: string;
  threads: Record<string, ChatMsg[]>;
  sessions: SessionView[];
  backendUsage: BackendUsageLike | null;
  runCumulative: { tokens: number; cost: number } | null;
}

/**
 * 把某会话当前消息缓冲经接口层写入历史镜像（容错持久化，服务端 SQLite 存储）。
 * - 写入独立于恢复流程与 run 结果：发送时与 run 收尾时各写一次，任何错误场景下数据都已可靠保存；
 * - 异步 fire-and-forget：内部吞掉网络/校验异常并降级进程内缓存（见 chat-history.ts），绝不阻塞 UI。
 */
export function persistHistory(opts: PersistHistoryOpts): void {
  const t = opts.threads[opts.sid];
  if (!t || !t.length) return;
  const meta = opts.sessions.find((s) => s.id === opts.sid);
  const usage: MirroredUsage | null = {
    backendUsage: opts.backendUsage
      ? {
          window: opts.backendUsage.window,
          promptTokens: opts.backendUsage.promptTokens,
          completionTokens: opts.backendUsage.completionTokens,
          totalTokens: opts.backendUsage.totalTokens,
          compressed: opts.backendUsage.compressed,
          breakdown: {
            system: opts.backendUsage.breakdown.system,
            tools: opts.backendUsage.breakdown.tools,
            messages: opts.backendUsage.breakdown.messages,
            mcp: opts.backendUsage.breakdown.mcp,
            skills: opts.backendUsage.breakdown.skills,
            completion: opts.backendUsage.breakdown.completion
          }
        }
      : null,
    runCumulative: opts.runCumulative
      ? { tokens: opts.runCumulative.tokens, cost: opts.runCumulative.cost }
      : null
  };
  void saveThread(
    opts.sid,
    { title: meta?.title ?? '新对话', updatedAt: Date.now() },
    t,
    usage
  );
}
