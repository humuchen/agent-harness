/**
 * chat-run-runtime 集成冒烟测试（Phase 5 余下 + Phase 6 收口闸门）。
 *
 * 覆盖「整条运行生命周期」全态序列：
 *   dispatchPrompt → threadFor/nextId/setStreamIdx/setThreads/setStreaming(true)
 *   → customModelEndpoint → runWithReconnect → streamRun(SSE 事件流)
 *   → ingest 逐事件汇入（job:accepted 记 jobId / llm:token 累积内容 / llm:usage 累加用量 / run:end 记 finalBy）
 *   → typewriter 打字机（ensureTypewriter 启动 interval、pending 缓冲）
 *   → 收尾 finally：stopTypewriter → drain/flush 揭示缓冲 → setStreaming(false) → saveHistory。
 *
 * 与 chat-run-runtime.test.ts（仅断连重连状态机）互补：本文件锁住「流式 UI 路径」契约，
 * 此前 50 个纯 util 测试零覆盖该路径，盲抽时极易静默破坏打字机/流式 UI。
 *
 * 注：dispatchPrompt/ingest 不触碰 document（仅 onVisibilityChange/silentWatchdog 用），
 * 故本测试无需 jsdom，node 环境即可稳定跑（避免为单一路径引入 jsdom 依赖）。
 */
import { describe, it, expect } from 'vitest';
import {
  ChatRunRuntime,
  type RunDeps,
  type BackendUsage
} from './chat-run-runtime';
import { ChatTypewriter, type TypewriterCaps } from './chat-typewriter';
import type { ChatMsg, TraceCtx, PlanExecState } from './chat-types';

type Ev = { type: string; [k: string]: unknown };

function buildHost() {
  const threads: Record<string, ChatMsg[]> = {};
  const streamIdx: Record<string, number> = {};
  const traces: Record<string, TraceCtx> = {};
  const planExec: Record<number, PlanExecState> = {};
  const streaming: Record<string, boolean> = {};
  const connState: Record<string, 'connected' | 'reconnecting' | 'lost'> = {};
  const calls: Array<{ op: string; [k: string]: unknown }> = [];
  let messages: ChatMsg[] = [];
  const activeId = 's1';
  let backendUsage: BackendUsage | null = null;
  let nextId = 1;
  let events: Ev[] = [];
  let onTraceCb: undefined | ((ev: unknown, sid: string) => void);

  const patchSession = (sid: string, p: Partial<ChatMsg>) => {
    calls.push({ op: 'patchSession', sid, p });
    const t = threads[sid];
    const idx = streamIdx[sid];
    if (!t || idx == null) return;
    const cur = t[idx];
    if (cur) t[idx] = { ...cur, ...p };
    if (sid === activeId) messages = t;
  };
  const curSession = (sid: string): ChatMsg | null => {
    const t = threads[sid];
    const idx = streamIdx[sid];
    const m = t && idx != null ? t[idx] : undefined;
    return m ? m : null;
  };
  const isAnyStreaming = () => Object.values(streaming).some(Boolean);

  const deps: RunDeps = {
    getConnState: (s) => connState[s] ?? 'connected',
    setConn: (s, v) => {
      connState[s] = v;
      calls.push({ op: 'setConn', s, v });
    },
    getStreaming: (s) => !!streaming[s],
    getStreamingDict: () => streaming,
    setStreaming: (s, v) => {
      streaming[s] = v;
      calls.push({ op: 'setStreaming', s, v });
    },

    threadFor: (s) => threads[s] ?? (threads[s] = []),
    setStreamIdx: (s, idx) => {
      streamIdx[s] = idx;
    },
    setThreads: (s, t) => {
      threads[s] = t;
    },
    getThreads: (s) => threads[s],
    getActiveId: () => activeId,
    setMessages: (t) => {
      messages = t;
    },
    getTraces: (s) => traces[s],
    getPlanExec: () => planExec,
    setPlanExec: (v) => {
      calls.push({ op: 'setPlanExec', v });
    },
    getServerCtxWindow: () => 8000,
    getServerModelBaseUrl: () => '',
    getBackendUsage: () => backendUsage,
    setBackendUsage: (v) => {
      backendUsage = v;
      calls.push({ op: 'setBackendUsage', v });
    },
    getMode: () => 'real',
    getModel: () => 'gpt',
    getAgentId: () => '',
    getWeb: () => false,
    getInteractionMode: () => 'qa',
    getAttachments: () => [],
    setShowCtxUsage: (b) => {
      calls.push({ op: 'setShowCtxUsage', b });
    },
    setRunCumulative: (v) => {
      calls.push({ op: 'setRunCumulative', v });
    },

    curSession,
    patchSession,
    resetTrace: (s) => {
      traces[s] = { root: null, parent: null, llm: null, lastTool: null, seq: 0 };
    },
    customModelEndpoint: async () => ({}) as Record<string, unknown>,
    traceHandle: (ev, s) => {
      calls.push({ op: 'traceHandle', s, type: (ev as Ev).type });
      const tc =
        traces[s] ??
        (traces[s] = {
          root: null,
          parent: null,
          llm: null,
          lastTool: null,
          seq: 0
        });
      if (!tc.root)
        tc.root = {
          id: 't0',
          kind: 'run',
          label: 'run',
          status: 'ok',
          children: []
        } as any;
      onTraceCb?.(ev, s);
    },
    autoCollapseThink: () => {
      calls.push({ op: 'autoCollapseThink' });
    },
    rebuildTraceMessages: () => {
      calls.push({ op: 'rebuildTraceMessages' });
    },
    saveHistory: (s) => {
      calls.push({ op: 'saveHistory', s });
    },
    resetScrollToBottom: () => {
      calls.push({ op: 'resetScrollToBottom' });
    },
    nextId: () => nextId++,
    requestUpdate: () => {},

    streamRun: async function* (
      payload: Record<string, unknown>,
      opts: { signal: AbortSignal }
    ): AsyncGenerator<unknown> {
      calls.push({ op: 'streamRun', payload });
      for (const ev of events) {
        if (opts.signal.aborted) throw new Error('aborted');
        yield ev;
      }
    }
  };

  const caps: TypewriterCaps = {
    patchSession,
    curSession,
    isAnyStreaming,
    requestUpdate: () => {}
  };

  return {
    deps,
    caps,
    curSession,
    calls,
    setEvents: (e: Ev[]) => {
      events = e;
    },
    setOnTrace: (f: (ev: unknown, sid: string) => void) => {
      onTraceCb = f;
    }
  };
}

describe('ChatRunRuntime 集成：dispatchPrompt→ingest→typewriter→flush/drain→setStreaming(false)', () => {
  it('1) 正常流式：全态序列 + 内容经打字机揭示 + 收尾 setStreaming(false)', async () => {
    const host = buildHost();
    const typewriter = new ChatTypewriter(host.caps);
    const rt = new ChatRunRuntime(host.deps, typewriter);
    host.setEvents([
      { type: 'job:accepted', jobId: 'job-1', seq: 0 },
      { type: 'llm:token', delta: 'Hello ', seq: 1 },
      { type: 'llm:token', delta: 'world', seq: 2 },
      {
        type: 'llm:usage',
        window: 8000,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        breakdown: {
          system: 1,
          tools: 2,
          messages: 3,
          mcp: 0,
          skills: 1,
          completion: 8
        }
      },
      { type: 'run:end', final: 'Hello world (final)', seq: 3 }
    ]);

    const result = await rt.dispatchPrompt('s1', 'hi');

    expect(result).toBe('ok');
    // 生命周期：先 setStreaming(true) 再 setStreaming(false)
    const streamCalls = host.calls
      .filter((c) => c.op === 'setStreaming')
      .map((c) => c.v);
    expect(streamCalls[0]).toBe(true);
    expect(streamCalls[streamCalls.length - 1]).toBe(false);
    // 内容经打字机由 token 累积并揭示（received=true → 不走 final 覆盖）
    const m = host.curSession('s1');
    expect(m?.content).toBe('Hello world');
    // jobId 经 job:accepted 记入运行簿记
    expect(rt.jobMap['s1']).toBe('job-1');
    // 后端上下文用量经 llm:usage 更新
    expect(host.calls.some((c) => c.op === 'setBackendUsage')).toBe(true);
    // 每个事件都汇入调用链路追踪
    expect(
      host.calls.filter((c) => c.op === 'traceHandle').length
    ).toBe(5);
    // 收尾重建追踪 + 回填 trace 到消息
    expect(host.calls.some((c) => c.op === 'rebuildTraceMessages')).toBe(true);
    expect(
      host.calls.some(
        (c) => c.op === 'patchSession' && (c.p as Partial<ChatMsg>)?.trace
      )
    ).toBe(true);
    // 容错持久化：发送时 + 收尾各一次以上
    expect(
      host.calls.filter((c) => c.op === 'saveHistory').length
    ).toBeGreaterThanOrEqual(2);
  });

  it('2) 用户中途停止：返回 stopped、flush 揭示已收内容、不标错误、setStreaming(false)', async () => {
    const host = buildHost();
    const typewriter = new ChatTypewriter(host.caps);
    const rt = new ChatRunRuntime(host.deps, typewriter);
    // 在 ingest 处理到 stop-now 时主动停止（确定性，无需计时等待）
    host.setOnTrace((ev) => {
      if ((ev as Ev).type === 'stop-now') rt.stop();
    });
    host.setEvents([
      { type: 'job:accepted', jobId: 'job-1', seq: 0 },
      { type: 'llm:token', delta: 'partial', seq: 1 },
      { type: 'stop-now' },
      { type: 'llm:token', delta: 'tail' } // 不会被 yield（已在 stop-now 处 abort）
    ]);

    const result = await rt.dispatchPrompt('s1', 'hi');

    expect(result).toBe('stopped');
    const m = host.curSession('s1');
    expect(m?.content).toContain('partial'); // flush 立即揭示 pending，而非 drain 逐字
    expect(m?.error).toBeFalsy();
    const last = [...host.calls].reverse().find((c) => c.op === 'setStreaming');
    expect(last?.v).toBe(false);
    // 用户手动停止后，stoppedMap 标记 true：供渲染层把空气泡从「等待响应…」切到「已停止」。
    expect(rt.stoppedMap['s1']).toBe(true);
  });

  it('3) 新一轮派发复位「已停止」标记：stoppedMap 回到 false', async () => {
    const host = buildHost();
    const typewriter = new ChatTypewriter(host.caps);
    const rt = new ChatRunRuntime(host.deps, typewriter);
    host.setOnTrace((ev) => {
      if ((ev as Ev).type === 'stop-now') rt.stop();
    });
    host.setEvents([
      { type: 'job:accepted', jobId: 'job-1', seq: 0 },
      { type: 'stop-now' }
    ]);
    await rt.dispatchPrompt('s1', 'hi');
    expect(rt.stoppedMap['s1']).toBe(true);

    // 新一轮派发（用户重新发起）应在开头清除标记，否则气泡会误显「已停止」。
    host.setEvents([{ type: 'run:end', final: '', seq: 0 }]);
    await rt.dispatchPrompt('s1', 'hi again');
    expect(rt.stoppedMap['s1']).toBe(false);
  });

  it('4) llm:usage 携带 compressed:true：对应流式气泡标记 compressed（移出用量浮层、挂到消息）', async () => {
    const host = buildHost();
    const typewriter = new ChatTypewriter(host.caps);
    const rt = new ChatRunRuntime(host.deps, typewriter);
    host.setEvents([
      { type: 'job:accepted', jobId: 'job-1', seq: 0 },
      {
        type: 'llm:usage',
        window: 8000,
        promptTokens: 7000,
        completionTokens: 5,
        totalTokens: 7005,
        compressed: true,
        model: 'gpt',
        breakdown: {
          system: 1,
          tools: 2,
          messages: 3,
          mcp: 0,
          skills: 1,
          completion: 8
        }
      },
      { type: 'run:end', final: 'done', seq: 1 }
    ]);

    const result = await rt.dispatchPrompt('s1', 'hi');

    expect(result).toBe('ok');
    const m = host.curSession('s1');
    // 标记随本轮流式消息落库：渲染层据此在该气泡下方显示「已压缩」，而非用量圆环旁。
    expect(m?.compressed).toBe(true);
    // 全局用量快照仍记录 compressed（供历史用量回填，不用于浮层徽标渲染）。
    expect(host.calls.some((c) => c.op === 'setBackendUsage')).toBe(true);
  });
});
