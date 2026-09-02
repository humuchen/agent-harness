/**
 * chat-run-runtime 集成冒烟测试（Phase 5 闸门）。
 *
 * 直接驱动抽离出的 runWithReconnect 重试 / 退避状态机（DOM-free，node 环境即可跑），
 * 用 mock streamRun（AsyncGenerator）模拟 SSE 事件流，断言：
 *   1) 正常消费 —— 事件全量汇入、connState 复位 connected、jobId/seq 簿记正确；
 *   2) 断连重连续传 —— 凭 jobId + since 游标重订阅，不重不漏；
 *   3) jobGone（4xx）—— 立即放弃重试，原样上抛、标记非 UserStoppedRun；
 *   4) 用户手动停止 —— 抛 UserStoppedRun，且不走重连横幅；
 *   5) keepalive 中断 —— 走重连路径（先 reconnecting）后抛 UserStoppedRun；
 *   6) 最大重试次数 —— 6 次退避后放弃，原样上抛；
 *   7) isJobGone / sleep 单测。
 *
 * 这些用例锁住「重连引擎」的契约：后续若再抽 ingest / dispatchPrompt / resumeLost，
 * 行为回归会被本文件第一时间拦截。
 */
import { describe, it, expect } from 'vitest';
import { runWithReconnect, isJobGone, sleep, ReconnectDeps } from './chat-run-runtime';
import { ApiError } from '@agent-harness/client';

type Ev = { type: string; [k: string]: unknown };

interface MockState {
  jobId: string;
  lastSeq: number;
  finished: boolean;
  keepAlive: boolean;
  connState: 'connected' | 'reconnecting' | 'lost';
}

const instant = () => Promise.resolve();

function makeDeps(opts: {
  state: MockState;
  events: Ev[];
  failSeq?: ('ok' | 'throw')[];
  throwEvents?: Ev[];
}) {
  const calls: Array<Record<string, unknown>> = [];
  const connSetCalls: string[] = [];
  const onEventCalls: Ev[] = [];
  let callIdx = 0;

  const streamRun = async function* (
    payload: Record<string, unknown>,
    _opts: { signal: AbortSignal }
  ) {
    calls.push(payload);
    const mode = (opts.failSeq ?? ['ok'])[callIdx] ?? 'ok';
    callIdx++;
    const evs = mode === 'throw' ? (opts.throwEvents ?? []) : opts.events;
    for (const ev of evs) yield ev;
    if (mode === 'throw') throw new Error('network blip');
  };

  const onEvent = (ev: unknown, _sid: string) => {
    const e = ev as Ev;
    onEventCalls.push(e);
    if (e.type === 'job:accepted' && typeof e.jobId === 'string') {
      opts.state.jobId = e.jobId;
    }
    if (typeof e.seq === 'number') {
      opts.state.lastSeq = Math.max(opts.state.lastSeq, e.seq);
    }
    if (e.type === 'run:end' || e.type === '_done' || e.type === 'error') {
      opts.state.finished = true;
    }
  };

  const deps: ReconnectDeps = {
    streamRun,
    onEvent,
    getJobId: (_s: string) => opts.state.jobId,
    getLastSeq: (_s: string) => opts.state.lastSeq,
    isFinished: (_s: string) => opts.state.finished,
    getKeepAliveAbort: (_s: string) => opts.state.keepAlive,
    clearKeepAliveAbort: (_s: string) => {
      opts.state.keepAlive = false;
    },
    getConnState: (_s: string) => opts.state.connState,
    setConn: (_s: string, v: 'connected' | 'reconnecting' | 'lost') => {
      opts.state.connState = v;
      connSetCalls.push(v);
    }
  };

  return { deps, calls, connSetCalls, onEventCalls, state: opts.state };
}

describe('runWithReconnect —— 重连 / 退避状态机', () => {
  it('1) 正常消费：事件全量汇入、connState 复位为 connected', async () => {
    const state: MockState = {
      jobId: '',
      lastSeq: -1,
      finished: false,
      keepAlive: false,
      connState: 'lost'
    };
    const events: Ev[] = [
      { type: 'job:accepted', jobId: 'job-1', seq: 0 },
      { type: 'llm:token', delta: 'hi', seq: 1 },
      { type: 'run:end', seq: 2 }
    ];
    const { deps, calls, connSetCalls, onEventCalls, state: st } = makeDeps({
      state,
      events,
      failSeq: ['ok']
    });

    await runWithReconnect('s1', { prompt: 'hi' }, new AbortController(), deps);

    expect(calls.length).toBe(1);
    expect(onEventCalls.length).toBe(3);
    expect(st.jobId).toBe('job-1');
    expect(st.lastSeq).toBe(2);
    expect(st.finished).toBe(true);
    expect(connSetCalls).toContain('connected');
  });

  it('2) 断连重连续传：凭 jobId + since 重订阅，不重不漏', async () => {
    const state: MockState = {
      jobId: '',
      lastSeq: -1,
      finished: false,
      keepAlive: false,
      connState: 'connected'
    };
    const events: Ev[] = [
      { type: 'job:accepted', jobId: 'job-1', seq: 0 },
      { type: 'llm:token', delta: 'hi', seq: 1 },
      { type: 'run:end', seq: 2 }
    ];
    // 断连发生在 run:end 之前：先给 job:accepted + llm:token，再断。
    const throwEvents: Ev[] = [
      { type: 'job:accepted', jobId: 'job-1', seq: 0 },
      { type: 'llm:token', delta: 'hi', seq: 1 }
    ];
    const { deps, calls, connSetCalls, state: st } = makeDeps({
      state,
      events,
      failSeq: ['throw', 'ok'],
      throwEvents
    });

    await runWithReconnect(
      's1',
      { prompt: 'hi' },
      new AbortController(),
      deps,
      instant
    );

    expect(calls.length).toBe(2);
    // 第二次订阅凭 jobId + since 续传游标（lastSeq 在断连前已记到 1）。
    const second = calls[1];
    expect(second?.jobId).toBe('job-1');
    expect(second?.since).toBe(1);
    expect(connSetCalls).toContain('reconnecting');
    expect(connSetCalls).toContain('connected');
    expect(st.finished).toBe(true);
  });

  it('3) jobGone（4xx）：立即放弃重试，原样上抛且非 UserStoppedRun', async () => {
    const state: MockState = {
      jobId: 'job-1',
      lastSeq: 5,
      finished: false,
      keepAlive: false,
      connState: 'connected'
    };
    const apiErr = new ApiError(404, 'gone');
    const { deps, calls, connSetCalls } = makeDeps({
      state,
      events: [],
      failSeq: ['throw'],
      throwEvents: []
    });
    // 让 streamRun 抛 4xx：包一层覆盖默认 throw。
    const deps2: ReconnectDeps = {
      ...deps,
      streamRun: async function (
        _p: Record<string, unknown>,
        _o: { signal: AbortSignal }
      ) {
        calls.push(_p);
        throw apiErr;
      }
    };

    await expect(
      runWithReconnect('s1', { prompt: 'x' }, new AbortController(), deps2, instant)
    ).rejects.toBe(apiErr);
    expect(calls.length).toBe(1);
    expect(connSetCalls).not.toContain('reconnecting');
  });

  it('4) 用户手动停止：抛 UserStoppedRun，且不走重连横幅', async () => {
    const ac = new AbortController();
    ac.abort();
    const state: MockState = {
      jobId: '',
      lastSeq: -1,
      finished: false,
      keepAlive: false,
      connState: 'connected'
    };
    const { deps, connSetCalls } = makeDeps({
      state,
      events: [],
      failSeq: ['throw'],
      throwEvents: []
    });

    await expect(
      runWithReconnect('s1', {}, ac, deps, instant)
    ).rejects.toMatchObject({ name: 'UserStoppedRun' });
    expect(connSetCalls).not.toContain('reconnecting');
  });

  it('5) keepalive 中断：先走重连路径（reconnecting）再抛 UserStoppedRun', async () => {
    const ac = new AbortController();
    ac.abort();
    const state: MockState = {
      jobId: 'job-1',
      lastSeq: 3,
      finished: false,
      keepAlive: true, // 看门狗 / 切回标签页触发的中止标记
      connState: 'connected'
    };
    const { deps, connSetCalls } = makeDeps({
      state,
      events: [],
      failSeq: ['throw'],
      throwEvents: []
    });

    await expect(
      runWithReconnect('s1', {}, ac, deps, instant)
    ).rejects.toMatchObject({ name: 'UserStoppedRun' });
    // 与用例 4 的区别：keepAlive 路径会先置 reconnecting 再转 UserStoppedRun。
    expect(connSetCalls).toContain('reconnecting');
  });

  it('6) 最大重试次数：6 次退避后放弃，原样上抛', async () => {
    const state: MockState = {
      jobId: 'job-1',
      lastSeq: 3,
      finished: false,
      keepAlive: false,
      connState: 'connected'
    };
    const { deps, calls, connSetCalls } = makeDeps({
      state,
      events: [],
      failSeq: (['throw'] as ('ok' | 'throw')[]).concat(
        Array(10).fill('throw')
      ),
      throwEvents: []
    });

    await expect(
      runWithReconnect('s1', {}, new AbortController(), deps, instant)
    ).rejects.toThrow('network blip');
    // 首次 + 6 次重试 = 7 次 streamRun；重连横幅置位 6 次。
    expect(calls.length).toBe(7);
    expect(connSetCalls.filter((v) => v === 'reconnecting').length).toBe(6);
  });
});

describe('isJobGone / sleep 单测', () => {
  it('isJobGone：4xx 命中、5xx 不命中、非 ApiError 不命中', () => {
    expect(isJobGone(new ApiError(404, 'gone'))).toBe(true);
    expect(isJobGone(new ApiError(500, 'boom'))).toBe(false);
    expect(isJobGone(new Error('x'))).toBe(false);
  });

  it('sleep：未中止时按 ms 解析', async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it('sleep：中止信号立即解析', async () => {
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);
    ac.abort();
    const t0 = Date.now();
    await p;
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
