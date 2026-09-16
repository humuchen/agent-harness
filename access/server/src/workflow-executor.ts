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
import { getAgentRegistry, getWorkflowStore, enforceTenantIsolation, getTeamManager, type TeamManager, type AgentCard, type TenantContext } from '@agent-harness/core';
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
      for (const [k, v] of Object.entries(rec)) {
        if (!k.startsWith('upstream_')) continue;
        const dep = k.slice('upstream_'.length);
        lines.push(`上游 ${dep} 产出：${typeof v === 'string' ? v : JSON.stringify(v)}`);
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
  return async (step: any, input: any, ctx: RunContext) => {
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
          opts.onEvent,
          undefined,
          opts.model,
          task,
          subSessionKey,
          ctx.signal,
          PLAN_TASK_TIMEOUT_MS,
          undefined,
          undefined,
          undefined,
          undefined,
          card,
          tenantCtx,
          ...tailArgs(opts)
        );
        return assembled.harness.run(task, opts.attachments);
      };

      const task = typeof input === 'string' ? input : JSON.stringify(input ?? '');
      const result = await teamManager.executeTask(step.teamRef, task, dispatchAgentTask);
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
      opts.onEvent,
      undefined,
      opts.model,
      prompt,
      sessionKey,
      ctx.signal,
      PLAN_TASK_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      undefined,
      card,
      tenantCtx,
      ...tailArgs(opts)
    );
    return assembled.harness.run(prompt, opts.attachments);
  };
}

/** 进程内共享的工作流存储（默认 Volatile；配置 WORKFLOW_STORE_DIR 时 File 持久化）。 */
export function workflowStore() {
  return getWorkflowStore();
}
