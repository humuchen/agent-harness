/**
 * 单次工具执行竞速（P1-2：从 harness.ts 拆出）。
 *
 * P4.8：工具执行纳入「中止 + 单次超时」竞速。此前工具执行是裸 await ——
 * 工具挂死时看门狗 abort 无法生效，整个 step 会一直阻塞到该工具自己返回，
 * 用户表现为「等待时间很长，然后才报 step 超时中止」。本模块：
 *   - 运行被中止（超时/取消）→ 立即放弃等待并走中止路径（内容不再丢）；
 *   - 单次工具超过 AGENT_TOOL_TIMEOUT_MS → 以「工具超时」作为工具结果回传，
 *     模型可改道或基于已有信息继续，而不是拖垮整步；
 *   - 超时不再只是「放弃等待」：经工具级独立 AbortController 真实中止
 *     工具执行（shell/sandbox/子 agent 等支持 signal 的工具会及时终止，
 *     孤儿执行不再继续烧 token / 占用资源）；run 级中止级联进工具信号。
 *
 * 纯机制模块：不做护栏校验、不做结果截断、不发业务事件（tool:start/tool:result
 * 由调用方负责）；仅保证副作用顺序（监听器挂载/清理、竞速、计时器清理）与
 * 拆分前逐字一致。
 */
import { withSpan } from '../telemetry';
import type { ToolCall } from '../types';
import type { ToolRegistry } from '../tools';

/** 竞速结果（调用方按 kind 分派，语义与拆分前内联分支完全一致）。 */
export type ToolRaceOutcome =
  | { kind: 'ok'; value: unknown }
  /** 工具正常返回值。 */
  | { kind: 'timeout' }
  /** 工具超时：内部已真实中止工具执行（toolAbort.abort），调用方将超时文案作为结果回传。 */
  | { kind: 'aborted' }
  /** run 级中止获胜：调用方走 abortedResult() 中止路径。 */
  | { kind: 'err'; error: unknown };

export interface ToolRaceParams {
  /** 待执行的工具调用。 */
  call: ToolCall;
  /** run 级取消信号（超时/外部取消），级联进工具信号。 */
  signal: AbortSignal;
  /** run 级中止竞速 promise（中止时 resolve '__aborted__'）。 */
  abortPromise: Promise<'__aborted__'>;
  /** 单次工具超时毫秒（0 = 不限时）。 */
  toolCallTimeoutMs: number;
  /** 全量工具注册表（执行始终走全量，与「发送给 LLM 的子集」无关）。 */
  tools: ToolRegistry;
  /** 工具 ctx：链路追踪标识。 */
  traceId?: string;
  /** 工具 ctx：会话标识（session→业务实体绑定校验）。 */
  sessionId?: string;
  /** 工具 ctx：出网管控策略（DNS rebinding 防护；undefined 表示策略未配置）。 */
  networkPolicy?: unknown;
}

/**
 * 执行单个工具调用，并与「run 中止」和「单次工具超时」竞速。
 *
 * 返回判别联合，调用方分派：
 *   - ok      → result = value
 *   - timeout → result = 超时文案（内部已 abort 工具），errored = true
 *   - aborted → 调用方补齐占位结果并 return abortedResult()
 *   - err     → 调用方 throw error（由外层 catch 转为工具错误文本回传模型）
 *
 * 副作用与拆分前一致：
 *   - run 信号上挂一次性级联监听，工具 promise 结束后移除（防监听器堆积）；
 *   - 工具 promise 的 rejection 转为已决值（防 unhandledRejection crash）；
 *   - 底层 LLM 调用之外的竞速落选 promise 均有兜底 catch；
 *   - 超时计时器在竞速结束后必被清理。
 */
export async function executeToolWithRace(
  p: ToolRaceParams
): Promise<ToolRaceOutcome> {
  const { call, signal, abortPromise, toolCallTimeoutMs } = p;
  const toolAbort = new AbortController();
  const propagateAbort = () => toolAbort.abort(signal.reason);
  if (signal.aborted) propagateAbort();
  else signal.addEventListener('abort', propagateAbort, { once: true });
  let toolTimer: ReturnType<typeof setTimeout> | null = null;
  // 把工具 promise 的 rejection 转为已决值：超时/中止放弃等待后，
  // 底层工具稍后 reject 时不再触发 unhandledRejection（Node ≥15 默认 crash）。
  const toolPromise: Promise<{
    kind: string;
    value?: unknown;
    error?: unknown;
  }> = withSpan(`tool.${call.name}`, async () => ({
    kind: 'ok',
    value: await p.tools.call(call.name, call.arguments, {
      traceId: p.traceId,
      // P1（leadId 注入防护）：会话标识透传给插件工具——服务端据此做
      // session→leadId 绑定校验，拒绝跨会话写他人档案。
      sessionId: p.sessionId,
      // 透传工具级取消信号（级联运行级 abort）：shell 等会落地子进程的工具据此及时强杀。
      signal: toolAbort.signal,
      // DNS rebinding 防护：web_fetch 等出网工具在真实连接前可做解析级私网校验
      // （策略来自 per-run guardrailPolicy.network；undefined 表示策略未配置）。
      networkPolicy: p.networkPolicy
    })
  })).then(
    (v) => v,
    (e) => ({ kind: 'err', error: e })
  );
  // 工具 promise 结束后移除级联监听，避免多次工具调用在 run 信号上堆积监听器。
  void toolPromise
    .finally(() => signal.removeEventListener('abort', propagateAbort))
    .catch(() => {}); // 理论不可达（rejection 已转已决值），防御性兜底
  const racers: Array<Promise<{ kind: string; value?: unknown; error?: unknown }>> = [
    toolPromise,
    abortPromise.then(() => ({ kind: 'aborted' as const }))
  ];
  if (toolCallTimeoutMs > 0) {
    racers.push(
      new Promise<{ kind: string }>((resolve) => {
        toolTimer = setTimeout(
          () => resolve({ kind: 'timeout' }),
          toolCallTimeoutMs
        );
      })
    );
  }

  let raced: { kind: string; value?: unknown; error?: unknown };
  try {
    raced = await Promise.race(racers);
  } finally {
    if (toolTimer) clearTimeout(toolTimer);
  }
  if (raced.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (raced.kind === 'err') {
    // 工具 promise 已被转成已决值（见 toolPromise），此处恢复异常
    // 语义，由调用方外层 catch 统一转为工具错误文本回传模型。
    return { kind: 'err', error: raced.error };
  }
  if (raced.kind === 'timeout') {
    toolAbort.abort(); // 真实取消：仍在执行的工具（含落地子进程）随 signal 退出
    return { kind: 'timeout' };
  }
  return { kind: 'ok', value: raced.value };
}
