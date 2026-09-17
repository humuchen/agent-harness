/**
 * 工作流服务端执行器（P1-⑤）。
 *
 * 把核心 `DagEngine` 的「执行一个 step」回调接到本仓库既有的运行装配：
 * `assembleAgent(card) → AgentHarness.run(input)`。这样工作流复用与 `/api/run` 完全相同的
 * 工具 / 技能 / MCP / 护栏 / 记忆装配链路，不另起炉灶。
 *
 * - 默认走 `mock` 模式（离线、无需密钥），与 `/api/run` 演示行为一致；
 * - 每 step 用独立 sessionKey（`wf:<workflowId>:<stepId>`）隔离记忆窗口；
 * - harness 事件透传给上层 SSE 接收者（onEvent），实现工作流进度的细粒度直播；
 * - 若 WorkflowDef 带 tenantId，则构造 TenantContext 注入，复用 P0.3 的租户护栏 + 记忆分区。
 */

import type { StepExecutor, RunContext } from '@agent-harness/core';
import { getAgentRegistry, getWorkflowStore, enforceTenantIsolation, getTeamManager, createVerifier, composeVerifiers, specsVerifier, inspectStepOutput, type TeamManager, type AgentCard, type TenantContext, type VerifyConfig, type StepTraceNode, type Verifier, type AssertSpec, STEP_TRACE_MAX_NODES, STEP_TRACE_DETAIL_MAX } from '@agent-harness/core';
import type { HarnessEvent } from '@agent-harness/core';
import { assembleAgent, type RunMode } from './runner';
import { PLAN_TASK_TIMEOUT_MS } from './run-queue';

/**
 * 把 step 的 input 对象（由 planToWorkflowDef.buildInputMapping 生成的
 * `{ goal, taskMeta, upstream_<dep>* }` 结构）装配成可读 prompt。
 *
 * 语义（见 design/plan-mode-multiagent.md §5）：
 * - `goal`：来自 inputMapping 的 `'input'`（= plan.goal，由 engine.run(def, goal) 传入）；
 * - `taskMeta`：字面量源（= JSON.stringify({id,title,steps[],expectedOutput})），
 *   本 helper 内 parse 后再格式化，**不** 把原始 JSON 字符串丢给模型；
 * - `upstream_<dep>`：来自 `'steps.<dep>'`（= 上游 step 的真实 output，原样保留，零有损）。
 *
 * 兼容现有 workflow 的 step input（任意 JSON 可序列化值 / 字符串）：
 * - string → 原样（保持 /api/workflows 现有行为）；
 * - 对象带 `goal` 或 `taskMeta` 键 → 走 plan 装配路径（可识别）；
 * - 其它对象 → `JSON.stringify`（保持现有回退，零回归）。
 */
export function formatStepInput(input: unknown, compensate?: boolean): string {
  const comp = !!compensate;
  if (typeof input === 'string') return comp ? `（回滚补偿）${input}` : input;
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    // Plan 来源（buildInputMapping 产出的形状）：必须同时有 goal + taskMeta。
    if ('goal' in rec && 'taskMeta' in rec) {
      const lines: string[] = [];
      let meta: { id?: string; title?: string; steps?: unknown[]; expectedOutput?: string } | null;
      try {
        meta = typeof rec.taskMeta === 'string' ? JSON.parse(rec.taskMeta) : null;
      } catch {
        meta = null; // taskMeta 解析失败时不阻断 step，仅少打 task 头
      }
      if (meta?.title) {
        lines.push(`【计划任务 ${meta.id ?? '(未命名)'}】${meta.title}`);
        if (Array.isArray(meta.steps) && meta.steps.length) {
          lines.push('步骤：');
          meta.steps.forEach((s, i) => lines.push(`${i + 1}. ${String(s)}`));
        }
        if (meta.expectedOutput) lines.push(`预期产出：${meta.expectedOutput}`);
      }
      lines.push(`目标：${String(rec.goal ?? '')}`);
      // 共享黑板：upstream_* 是上游 step 的**真实** output（engine.resolveInput 经
      // inputMapping 的 `steps.<dep>` 取上游 outputs[dep]），原样注入 → 零摘要、零有损。
      // P4.5 上游注记：产出经 inspectStepOutput 判为无效（空 / 中断 / 护栏兜底）时显式
      // 标注 + 降级指引，让下游「知情」，不再静默喂垃圾（跑题级联的放大点）。
      for (const [k, v] of Object.entries(rec)) {
        if (!k.startsWith('upstream_')) continue;
        const dep = k.slice('upstream_'.length);
        const insp = inspectStepOutput(v);
        if (insp.issue === 'ok') {
          lines.push(`上游 ${dep} 产出：${typeof v === 'string' ? v : JSON.stringify(v)}`);
          continue;
        }
        if (insp.issue === 'empty') {
          lines.push(
            `上游 ${dep} 产出：（空）——上游 ${dep} 未产出有效结果。请基于「目标」与本任务步骤独立执行；` +
            `若外部检索失败，降级整合其它上游产出并在产出中显式标注数据缺口，不得以道歉或放弃收尾。`
          );
        } else if (insp.issue === 'partial') {
          lines.push(
            `上游 ${dep} 产出（⚠️ 该产出在中途截断，仅作参考）：${String(v)}\n` +
            `提示：上游 ${dep} 结果不完整，请基于「目标」与本任务步骤自行补齐，并在产出中标注引用了不完整来源。`
          );
        } else {
          lines.push(
            `上游 ${dep} 产出：（被安全护栏拦截，无实质内容）——请基于「目标」与本任务步骤独立执行，` +
            `不得转述被拦截内容；数据缺口在产出中显式标注。`
          );
        }
      }
      const body = lines.join('\n');
      return comp ? `（回滚补偿）${body}` : body;
    }
    // 其它对象：保持现有 workflow 行为（JSON.stringify），零回归。
    const dumped = JSON.stringify(rec, null, 2) ?? '';
    return comp ? `（回滚补偿）${dumped}` : dumped;
  }
  return '';
}


export interface WorkflowExecutorOptions {
  /** harness 事件透传（SSE 直播）。 */
  onEvent?: (e: HarnessEvent) => void;
  /** 运行模式：默认 mock（离线）。真实多 agent 协同可设 real / real-mcp。 */
  mode?: RunMode;
  /** 外部取消信号。 */
  signal?: AbortSignal;
  /**
   * 图片附件透传（图片上传修复）：工作流 step 经本字段把前端图片带给 harness.run 的第 2 参，
   * 确保多模态上下文在工作流 / 团队派发链路不丢（此前漏传 → 图片未到达 LLM）。
   * 类型与 `AgentHarness.run` 的第 2 参完全一致。
   */
  attachments?: Array<{ url: string; name: string; type: string }>;
  /**
   * BYOK 模型与凭据透传（P3：plan DAG real 模式修复）：与 /api/run（run-queue）对齐，
   * 让每个 step 的 assembleAgent 拿到调用方当前会话的模型名 / 自定义端点 / 上下文窗口。
   * 缺省（undefined）时行为与旧版完全一致——real 模式回落到服务端默认凭证解析，
   * mock 模式无影响。
   */
  model?: string;
  modelBaseUrl?: string;
  modelApiKey?: string;
  apiKeys?: string[];
  ctxWindow?: number;
  /** 联网搜索开关（/api/run 的 job.web 语义）：true 注册 web_fetch + 联网检索技能。缺省关闭。 */
  webEnabled?: boolean;
  /**
   * 运行期自动验证门禁（P0-2，与 /api/run 的 job.verify 同语义）：传入 VerifyConfig
   * （如 { auto: true }）时，每个 step 的 harness 产出后经 createVerifier 装配的规则门禁
   * 校验「运行健康度」；未通过且 AGENT_VERIFY_MAX_RETRIES>0 时注入自检提示重跑（反思循环）。
   * 缺省 undefined 行为与旧版完全一致（门禁关闭，零回归）。
   */
  verify?: VerifyConfig;
  /**
   * P4.5 验证重试预算覆盖：仅当 executor 级 verifier 存在时生效（优先于 AGENT_VERIFY_MAX_RETRIES）。
   * plan 桥路径由 server 按 AGENT_PLAN_VERIFY_RETRIES（默认 1）注入；非 plan 路径缺省 undefined →
   * 回落 AGENT_VERIFY_MAX_RETRIES（存量语义不变）。
   */
  verifyMaxRetries?: number;
  /**
   * P4.5 结果断言：逐 task 的「产出必须包含」短词（taskMeta.outputChecks，planner 生成）
   * 自动转 contains 断言，与本 executor 的 verify 验证器组合为 per-step 验证器。
   * 无 taskMeta / 无 outputChecks 的 step 用 executor 级验证器（零回归）；
   * 仅 plan 桥 step 携带该字段，手工 workflow 不受影响。
   */
  planOutputChecks?: boolean;
}

/**
 * P2.5 调用链路采集器（workflow-executor 专用）：把 step 执行期间流过的 harness 事件
 * 收敛为紧凑的 `StepTraceNode` 序列（LLM 调用 / 工具 / 护栏 / 校验 / 用量 / 收尾），
 * 由 executor 写入 `ctx.trace`，引擎在 step 收尾合并进 `StepRun.trace` 并随检查点持久化 ——
 * 使「执行详情」抽屉能看到每个节点的运行过程，而不只是完成后的耗时。
 *
 * 纪律：
 * - **白名单捕获**：只记录关键事件；token 级流式增量（llm:token / llm:reasoning）与高频噪声
 *   （run:tools / step:start / run:meta / run:token-cache / plan:proposed）不落盘；
 * - **截断**：detail 超 STEP_TRACE_DETAIL_MAX 截断（保首段）；节点数超 STEP_TRACE_MAX_NODES 停采
 *   （引擎合并侧同样兜底，双保险）；
 * - **BYOK 红线**：只记模型名，modelBaseUrl / apiKeys 永不进入节点（事件流本就不携带凭据）；
 * - **per-step 隔离**：每个 workflow step 各建一个实例（波次内并行 step 不互相串流）。
 */
export class StepTraceCollector {
  private readonly traceNodes: StepTraceNode[] = [];
  /** 本 step 实际使用的模型名（AssembledAgent.accountModel，仅模型名——BYOK 红线不变）。 */
  private model?: string;

  /** 观察一个 harness 事件；白名单命中即追加节点（超限后静默丢弃）。 */
  observe(e: HarnessEvent): void {
    if (this.traceNodes.length >= STEP_TRACE_MAX_NODES) return;
    const ts = Date.now();
    switch (e.type) {
      case 'run:start':
        this.traceNodes.push({
          type: e.type,
          ts,
          label: '任务开始',
          detail: clip(e.input),
        });
        return;
      case 'guardrail:blocked':
        this.traceNodes.push({
          type: e.type,
          ts,
          label: `护栏拦截（${e.phase}）`,
          detail: clip(e.reason),
          status: 'blocked',
          meta: e.tool ? { tool: e.tool } : undefined,
        });
        return;
      case 'llm:call':
        this.traceNodes.push({
          type: e.type,
          step: e.step,
          ts,
          label: 'LLM 调用',
          meta: {
            ...(this.model ? { model: this.model } : {}),
            msgs: String(e.messageCount),
            tools: String(e.toolCount)
          },
        });
        return;
      case 'llm:response': {
        const toolNames = e.toolCalls.map((c) => c.name).filter(Boolean);
        this.traceNodes.push({
          type: e.type,
          step: e.step,
          ts,
          label: e.partial ? '模型响应（中断截断）' : toolNames.length ? `响应 → 调用工具 [${toolNames.join(', ')}]` : '模型响应',
          status: e.partial ? 'error' : 'ok',
          detail: clip(e.content || toolNames.map((n) => `调用 ${n}`).join(' ')),
          meta: e.partial ? { partial: 'true' } : undefined,
        });
        return;
      }
      case 'tool:start':
        this.traceNodes.push({
          type: e.type,
          step: e.step,
          ts,
          label: `工具 ${e.call.name}`,
          detail: clip(e.call.arguments),
        });
        return;
      case 'tool:result':
        this.traceNodes.push({
          type: e.type,
          step: e.step,
          ts,
          label: `工具 ${e.call.name} 结果`,
          status: e.errored ? 'error' : 'ok',
          detail: clip(e.result),
        });
        return;
      case 'tool:deduped':
        this.traceNodes.push({
          type: 'tool:result', // 归一为结果节点（回放端按 status + label 区分）
          step: e.step,
          ts,
          label: `工具 ${e.call.name} 结果（缓存复用）`,
          status: e.errored ? 'error' : 'ok',
          detail: clip(e.result),
        });
        return;
      case 'run:cost':
        this.traceNodes.push({
          type: e.type,
          step: e.step,
          ts,
          label: '用量',
          meta: {
            ...(e.model ? { model: e.model } : {}),
            tokens: String(e.usage?.total_tokens ?? 0),
            cost: e.stepCost.toFixed(4),
            ...(e.priced === false ? { priced: 'est' } : {})
          },
        });
        return;
      case 'llm:usage':
        this.traceNodes.push({
          type: e.type,
          step: e.step,
          ts,
          label: e.compressed ? '上下文用量（已压缩）' : '上下文用量',
          meta: {
            ...(e.model ? { model: e.model } : {}),
            prompt: String(e.promptTokens),
            completion: String(e.completionTokens),
            window: String(e.window)
          },
        });
        return;
      case 'budget:exceeded':
        this.traceNodes.push({
          type: e.type,
          ts,
          label: `预算熔断（${e.kind}）`,
          detail: `已用 ${e.used} / 上限 ${e.limit}`,
          status: 'error'
        });
        return;
      case 'verify:result':
        this.traceNodes.push({
          type: e.type,
          ts,
          label: e.passed ? '自动验证通过' : `自动验证未通过（第 ${e.attempt} 次, 得分 ${e.score}）`,
          status: e.passed ? 'ok' : 'error',
          detail: e.reasons.length ? clip(e.reasons.join('；')) : undefined
        });
        return;
      case 'run:end':
        this.traceNodes.push({
          type: e.type,
          ts,
          label: '任务结束',
          status: 'ok',
          detail: clip(e.final),
          meta: { steps: String(e.steps) }
        });
        return;
      default:
        // 白名单外的纯流式 / 元数据事件不落盘（控体积，保关键信息）。
        return;
    }
  }

  /** 已捕获的节点序列（引擎合并侧还会做截断 + detail 兜底）。 */
  nodes(): StepTraceNode[] {
    return this.traceNodes;
  }

  /** 注入本 step 实际使用的模型名（AssembledAgent.accountModel）。
   *  仅模型名，无 base URL / apiKey——BYOK 红线不变。缺省（未注入）时 LLM 调用行不带模型 chip。 */
  setModel(model: string | null | undefined): void {
    this.model = model || undefined;
  }
}

/** detail 截断（与引擎 STEP_TRACE_DETAIL_MAX 同上限，双保险保早期内容）。 */
function clip(s: unknown, max: number = STEP_TRACE_DETAIL_MAX): string | undefined {
  if (s == null) return undefined;
  let t: string;
  try {
    t = typeof s === 'string' ? s : JSON.stringify(s);
  } catch {
    t = String(s);
  }
  t = t.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * 把 WorkflowExecutorOptions 的 BYOK 参数展开为 assembleAgent 的 15–23 号位置参数
 * 组成的元组（team 路径与主路径共用），避免两处 24 参调用各自维护、易漏。
 *
 * 参数序（assembleAgent 签名，1-indexed）：
 *  8  timeoutMs        9  maxSteps       10  memoryArg
 * 11  verifier         12  verifyMaxRetries  13  card        14  tenantCtx
 * 15  sandboxBackend   16  streamTokens   17  webEnabled    18  planPropose
 * 19  planTask         20  modelBaseUrl   21  modelApiKey   22  ctxWindow
 * 23  apiKeys
 */
/** 15–23 号位置参数元组（与 assembleAgent 签名一一对应，保证 spread 类型安全）。 */
type AssembleAgentTail = [
  string | null | undefined, // 15 sandboxBackend
  boolean | undefined, // 16 streamTokens
  boolean, // 17 webEnabled
  boolean, // 18 planPropose
  boolean, // 19 planTask
  string | undefined, // 20 modelBaseUrl
  string | undefined, // 21 modelApiKey
  number | undefined, // 22 ctxWindow
  string[] | undefined // 23 apiKeys
];

function tailArgs(o: WorkflowExecutorOptions): AssembleAgentTail {
  // 工作流 step 属计划任务执行（语义等价 run-queue 的 isPlanTaskRun）：
  // - timeoutMs 放宽到 PLAN_TASK_TIMEOUT_MS（默认 10 分钟），重任务不被 5 分钟看门狗掐断；
  // - planTask=true → 输出走 checkTaskOutput 宽松扫描（研报 / 综述类产出含
  //   「system prompt」等弱信号短语时不被 medium 注入护栏误拦成兜底话术）；
  // - webEnabled 沿用 /api/run 语义（显式开启才出网，缺省 false 不出网）。
  // 注：8 号位 timeoutMs 与 4 号位 modelOverride 不在本元组内，由调用点按序直传。
  return [
    undefined, // 15 sandboxBackend：沿用 SANDBOX_BACKEND 全局值（per-step 隔离后端 P2.d 未接入工作流）
    undefined, // 16 streamTokens：默认开启（受 AGENT_STREAM_TOKENS 控制）
    o.webEnabled ?? false, // 17 webEnabled
    false, // 18 planPropose：step 执行的是具体任务，非计划生成阶段
    true, // 19 planTask：计划任务执行（输出宽松扫描）
    o.modelBaseUrl, // 20
    o.modelApiKey, // 21
    o.ctxWindow, // 22
    o.apiKeys && o.apiKeys.length > 0 ? o.apiKeys : undefined // 23
  ];
}

export function createWorkflowExecutor(opts: WorkflowExecutorOptions = {}): StepExecutor {
  const mode = opts.mode ?? 'mock';
  // 校验/反思门禁（P0-2）：与 /api/run（run-queue.ts:773）同款装配——
  // createVerifier(verifyConfig) 生成组合验证器；重试预算优先取 opts.verifyMaxRetries
  // （P4.5 plan 桥注入），缺省回落 AGENT_VERIFY_MAX_RETRIES（默认 0 = 仅校验+标记，
  // >0 时 harness 注入自检提示重跑 = 反思循环）。executor 级验证器在装配期构建一次。
  const baseVerifier = createVerifier(opts.verify);
  const baseRetries = baseVerifier
    ? (opts.verifyMaxRetries ?? (Number(process.env.AGENT_VERIFY_MAX_RETRIES ?? 0) || 0))
    : 0;

  /**
   * P4.5 结果断言（per-step）：plan 桥 step 的 inputMapping.taskMeta 携带
   * outputChecks（planner 生成的「产出必须包含」短词）时，逐项转 contains 断言
   * 与 executor 级验证器组合成本 step 专属验证器；无 taskMeta / 无 outputChecks /
   * 解析失败 → 原样回落 baseVerifier（零回归，不阻断 step）。
   * 注：纯断言（base 缺省未开）时保守「只标记不重跑」——反思循环需 executor 级
   * 验证器存在（plan 默认路径由 server 保证 auto 开启）。
   */
  const buildStepVerifier = (step: any): { verifier: Verifier | undefined; retries: number } => {
    if (!opts.planOutputChecks) return { verifier: baseVerifier, retries: baseRetries };
    const taskMetaRaw: string | undefined = step?.inputMapping?.taskMeta;
    if (!taskMetaRaw || typeof taskMetaRaw !== 'string') {
      return { verifier: baseVerifier, retries: baseRetries };
    }
    let meta: { outputChecks?: unknown } | null;
    try {
      const parsed: unknown = JSON.parse(taskMetaRaw);
      meta = parsed && typeof parsed === 'object' ? (parsed as { outputChecks?: unknown }) : null;
    } catch {
      return { verifier: baseVerifier, retries: baseRetries }; // taskMeta 非法：不阻断，少装配
    }
    const specs: AssertSpec[] = Array.isArray(meta?.outputChecks)
      ? (meta!.outputChecks as unknown[])
          .map((c) => ({ contains: String(c).trim() }))
          .filter((s) => s.contains !== '')
      : [];
    if (specs.length === 0) return { verifier: baseVerifier, retries: baseRetries };
    if (baseVerifier) {
      return {
        verifier: composeVerifiers(baseVerifier, specsVerifier(specs)),
        retries: baseRetries,
      };
    }
    // 无 executor 级验证器（verify 未传）：仅装配结果断言，重试预算保守取 0。
    return { verifier: specsVerifier(specs), retries: 0 };
  };

  return async (step: any, input: any, ctx: RunContext) => {
    // P2.5 调用链路采集（per-step 隔离）：波次内并行 step 各自持有 collector，
    // 经包装的 traceOnEvent 汇入本 step 专属序列（同时保留原 SSE 直播）；
    // step 收尾（成功 / 失败）把节点写 ctx.trace，引擎合并进 StepRun.trace 随检查点持久化。
    const col = new StepTraceCollector();
    const traceOnEvent = opts.onEvent
      ? (e: HarnessEvent) => {
          opts.onEvent?.(e);
          col.observe(e);
        }
      : (e: HarnessEvent) => col.observe(e);
    // P4.5：本 step 专属验证器（outputChecks 逐 task 结果断言；非 plan step 回落 base）。
    const stepVerify = buildStepVerifier(step);
    const ref = step.agentRef;
    const card: AgentCard | null =
      typeof ref === 'string' ? await getAgentRegistry().get(ref) : ref;
    if (!card) {
      throw new Error(`workflow step "${step.id}": unknown agentRef ${typeof ref === 'string' ? ref : '(inline card)'}`);
    }

    // P1-④：teamRef 优先 —— 通过 TeamManager 按协作模式派发
    const teamManager: TeamManager | null = step.teamRef ? getTeamManager() : null;
    if (teamManager && step.teamRef) {
      const team = teamManager.get(step.teamRef);
      if (!team) {
        throw new Error(`workflow step "${step.id}": unknown teamRef ${step.teamRef}`);
      }

      // 团队成员执行函数：对每个成员调用 assembleAgent + harness.run
      const dispatchAgentTask = async (card: AgentCard, task: string): Promise<string> => {
        const tenantCtx: TenantContext | null = ctx.tenantId ? { id: ctx.tenantId } : null;
        const isolationDenied = enforceTenantIsolation({ agentDomain: card.domain ?? null, tenant: tenantCtx });
        if (isolationDenied) {
          throw new Error(`workflow step "${step.id}": tenant isolation denied: ${isolationDenied.reason}`);
        }
        const subSessionKey = `wf:${ctx.workflowId}:${step.id}:${card.id}`;
        const assembled = await assembleAgent(
          mode,
          traceOnEvent,
          undefined,
          opts.model,
          task,
          subSessionKey,
          ctx.signal,
          PLAN_TASK_TIMEOUT_MS,
          undefined,
          undefined,
          stepVerify.verifier,
          stepVerify.retries,
          card,
          tenantCtx,
          ...tailArgs(opts)
        );
        col.setModel(assembled.accountModel); // P2.5 LLM 调用行带出本成员实际模型名
        return assembled.harness.run(task, opts.attachments);
      };

      const task = typeof input === 'string' ? input : JSON.stringify(input ?? '');
      let result: string | string[];
      try {
        result = await teamManager.executeTask(step.teamRef, task, dispatchAgentTask);
      } finally {
        ctx.trace = col.nodes(); // P2.5 链路附挂（成功/失败均落，失败路径排障价值最高）
      }
      return result;
    }

    const tenantCtx: TenantContext | null = ctx.tenantId ? { id: ctx.tenantId } : null;

    // P2 投产加固：与 /api/run、A2A 一致的跨行业隔离强制门禁（REQUIRE_TENANT=true 时生效）。
    // 工作流某个 step 命中行业 agent 但无 tenantCtx → 抛错中断该 step（DagEngine 记为失败并按需补偿）。
    const isolationDenied = enforceTenantIsolation({ agentDomain: card.domain ?? null, tenant: tenantCtx });
    if (isolationDenied) {
      throw new Error(`workflow step "${step.id}": tenant isolation denied: ${isolationDenied.reason}`);
    }

    const sessionKey = `wf:${ctx.workflowId}:${step.id}`;
    // plan 来源 step：input 是 { goal, taskMeta, upstream_* } 对象 → 经 formatStepInput
    // 装配成设计文档 §5 约定的可读 prompt；其它 workflow step（string / 任意对象）保持
    // 原行为不变（零回归）。补偿路径同用 helper，回滚指令前缀保留。
    const prompt = formatStepInput(input, ctx.compensate);

    const assembled = await assembleAgent(
      mode,
      traceOnEvent,
      undefined,
      opts.model,
      prompt,
      sessionKey,
      ctx.signal,
      PLAN_TASK_TIMEOUT_MS,
      undefined,
      undefined,
      stepVerify.verifier,
      stepVerify.retries,
      card,
      tenantCtx,
      ...tailArgs(opts)
    );
    let result: string;
    try {
      col.setModel(assembled.accountModel); // P2.5 LLM 调用行带出本 step 实际模型名
      result = await assembled.harness.run(prompt, opts.attachments);
    } finally {
      ctx.trace = col.nodes(); // P2.5 链路附挂（成功/失败均落，失败路径排障价值最高）
    }
    return result;
  };
}

/** 进程内共享的工作流存储（默认 Volatile；配置 WORKFLOW_STORE_DIR 时 File 持久化）。 */
export function workflowStore() {
  return getWorkflowStore();
}
