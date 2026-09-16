/**
 * chat-render-utils：聊天界面中可独立抽取的纯渲染 / 格式化工具。
 *
 * 从 AhChat 单体内抽离，降低耦合与体积。所有导出均为纯函数或仅依赖显式入参，
 * 不读取组件 this.* 状态，便于独立测试与跨渲染方法复用。
 */
import { html, nothing, type TemplateResult } from 'lit';
import { escapeHtml } from './utils/markdown';
import type { UploadedFile } from './agent-context';
import type { PlanExecMirror } from '@agent-harness/client';
import type { PlanExecState } from './chat-types';

/** 按文件类型返回展示图标（emoji）。 */
export function fileIcon(f: UploadedFile): string {
  if (f.type.startsWith('image/')) return '🖼';
  if (f.type.includes('pdf')) return '📄';
  if (
    f.type.includes('csv') ||
    f.type.includes('json') ||
    f.type.includes('text')
  )
    return '📝';
  return '📎';
}

/** 人类可读的文件大小（B / KB / MB）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 从线程消息里提取「计划进度镜像查找表」：按 plan.goal 对齐 PlanExecMirror。
 * 消息 id 在恢复时重新分配，不能按 id 对齐；goal 是计划卡片的稳定业务键。纯计算。
 */
export function buildPlanStatusLookup(
  msgs: Array<{ plan?: unknown; planStatus?: PlanExecMirror }>
): Map<string, PlanExecMirror> {
  const out = new Map<string, PlanExecMirror>();
  for (const m of msgs) {
    const plan = m.plan as { goal?: unknown } | undefined;
    if (!plan || typeof plan.goal !== 'string' || !m.planStatus) continue;
    if (!out.has(plan.goal)) out.set(plan.goal, m.planStatus);
  }
  return out;
}

/**
 * 计划任务派发消息的前缀：`【计划任务 tX】任务标题`。
 * 必须与 chat.ts confirmPlan 的派发格式、以及服务端 run:start 的进度镜像识别保持一致
 * （宽匹配任务 id：planner 生成的 id 并不总是 tN，见 derivePlanExecFromMessages 注释）。
 */
export const PLAN_TASK_DISPATCH_RE = /^【计划任务\s*([^】]+)】/;

/* ------------------------------------------------------------------ */
/* P3 多 agent DAG 计划执行：wf:* 事件 → 计划卡片状态（纯函数）        */
/* ------------------------------------------------------------------ */

/**
 * 计划卡片 DAG 路径消费的 wf:* 事件最小形态（只含状态机用到的字段；
 * 与 @agent-harness/client 的 WorkflowEvent 结构兼容，此处不 import 以避免
 * 状态机纯函数耦合 client 包，便于独立测试与复用）。
 */
export interface PlanWfEvent {
  type: string;
  /** wf:step:* 携带的 step id（= 计划 task id，planToWorkflowDef 按 task.id 建 step）。 */
  stepId?: string;
  workflowId?: string;
  /** wf:failed 时携带的完整 run（step 终态快照，用于定位失败 task）。 */
  run?: {
    state?: string;
    steps?: Record<string, { state?: string; id?: string }>;
  };
}

/**
 * 把一条 wf:* 事件叠加到计划卡片的执行状态上（P3 DAG 路径，纯函数，零副作用）。
 *
 * 只处理「本计划已知 task 的 step 事件」（stepId ∈ knownTaskIds），其它 step /
 * 无关事件原样返回 prev（同引用，便于调用方以 `next !== prev` 判重渲染）。
 *
 * 语义（对齐 design/plan-mode-multiagent.md §6 + R8 引擎 all-or-nothing 现状）：
 * - wf:step:start  → running + currentTaskId；
 * - wf:step:done   → done[stepId] = true（状态保持 running，直至 wf:done）；
 * - wf:step:failed → failed + failedTaskId（引擎该波次中止，独立分支可能被放弃）；
 * - wf:done        → 整体 done，清 current/failed；
 * - wf:failed      → 整体 failed；failedTaskId 取 run.steps 中首个 failed step；
 * - 其它（harness 嵌套事件 / wf:compensate:* / wf:start）→ 不变更（同引用返回）。
 */
export function applyPlanWfEvent(
  prev: PlanExecState,
  ev: PlanWfEvent,
  knownTaskIds: ReadonlySet<string>
): PlanExecState {
  if (!ev || typeof ev.type !== 'string') return prev;
  switch (ev.type) {
    case 'wf:step:start': {
      if (!ev.stepId || !knownTaskIds.has(ev.stepId)) return prev;
      return { ...prev, status: 'running', currentTaskId: ev.stepId };
    }
    case 'wf:step:done': {
      if (!ev.stepId || !knownTaskIds.has(ev.stepId)) return prev;
      return { ...prev, status: 'running', done: { ...prev.done, [ev.stepId]: true } };
    }
    case 'wf:step:failed': {
      if (!ev.stepId || !knownTaskIds.has(ev.stepId)) return prev;
      return {
        ...prev,
        status: 'failed',
        failedTaskId: ev.stepId,
        currentTaskId: ev.stepId
      };
    }
    case 'wf:done':
      return { ...prev, status: 'done', currentTaskId: undefined, failedTaskId: undefined };
    case 'wf:failed': {
      // R8：引擎 all-or-nothing，run 整体失败。失败 task 定位：
      // run.steps 中首个 state==='failed' 的 step（step id = task id）。
      const firstFailed = Object.values(ev.run?.steps ?? {}).find(
        (s) => s?.state === 'failed'
      );
      return {
        ...prev,
        status: 'failed',
        failedTaskId: firstFailed?.id ?? prev.failedTaskId,
        currentTaskId: undefined
      };
    }
    default:
      // wf:start / wf:compensate:* / 嵌套 harness 事件 / _wf_done / wf:error（SSE 终结帧）：
      // 卡片状态机不消费（wf:error 即请求级失败，由调用方 catch 兜底回退串行路径）。
      return prev;
  }
}

/** wf:done / wf:failed 携带的 run 快照最小形态（只含回挂摘要用到的字段）。 */
export interface PlanWfRunSnapshot {
  state?: string;
  steps?: Record<string, { state?: string; id?: string; output?: unknown }>;
}

/**
 * P3（多 agent DAG 计划执行）特性开关。
 * 开启后计划确认走服务端 DagEngine（拓扑波次并行 + 共享黑板），传输层失败自动回退已验证的
 * 串行路径兜底。**默认开**；localStorage 显式置 `ah_plan_dag='0'` 可关闭（回退串行）。
 * 回退链完整：unknown agent / 5xx / 断连 / wf:error → 串行路径，failed 态「从失败任务继续」
 * 亦走串行 resume（见 design/plan-mode-multiagent.md §9.3 / R8）。
 *
 * 可视化入口：「我的 → 设置 → 外观 → 对话」的开关（settings-center 读 isPlanDagEnabled 初始化，
 * 切换经 setPlanDagEnabled 写回同一 key）。chat.ts 的 confirmPlan 每次确认时实时读
 * isPlanDagEnabled()（不缓存），设置页改完即生效，无需跨组件事件总线。
 */
export const PLAN_DAG_STORAGE_KEY = 'ah_plan_dag';

export function isPlanDagEnabled(): boolean {
  try {
    // 默认开：仅当用户显式写入 '0' 时关闭。
    return localStorage.getItem(PLAN_DAG_STORAGE_KEY) !== '0';
  } catch {
    // localStorage 不可用（隐私模式 / 非浏览器 / 读取抛错）→ 取默认值「开」。
    return true;
  }
}

/**
 * 设置开关（设置中心 toggle 用）。on=true 时**移除** key（回到「默认开」语义，不留脏值）；
 * on=false 显式写 '0'。localStorage 不可用时静默忽略——此时 isPlanDagEnabled() 恒为默认「开」。
 */
export function setPlanDagEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PLAN_DAG_STORAGE_KEY);
    else localStorage.setItem(PLAN_DAG_STORAGE_KEY, '0');
  } catch {
    /* 隐私模式 / 非浏览器：开关回落到默认「开」，与 isPlanDagEnabled 的 catch 分支一致。 */
  }
}

/** derivePlanExecFromMessages 的只读消息形状（ChatMsg / MirroredMsg 均满足）。 */
export interface PlanDeriveMsg {
  role: 'user' | 'assistant' | string;
  content?: string;
  error?: boolean;
}

/**
 * 从线程消息中「反推」计划执行进度（持久化镜像缺失时的兜底）。
 *
 * 为什么需要：计划进度的权威来源有两处 —— 前端内存 `planExec`（刷新即失）与服务端
 * `planStatus` 镜像。当镜像缺失（旧数据未带该字段、镜像被前端整包覆盖、服务端重启后
 * 回落到不含该字段的镜像）时，卡片会退回默认的「待确认」，向用户重新暴露「确认执行 /
 * 取消」——与「计划已执行完成」的事实相反。此时唯一的证据就在线程本身：
 * confirmPlan 逐任务派发时会留下 user 消息 `【计划任务 tX】…`，其后的 assistant 回复
 * 即该任务的产出。
 *
 * 判定规则（保守，宁可不动也不误报「已完成」）：
 * - 计划任务 id 集合取自计划实体；派发消息里出现、但不属于本计划的 id（如用户手输的
 *   同形文本）一律忽略；
 * - 某任务记为已完成 ⟺ 其派发消息之后、下一条 user 消息之前存在一条非错误且正文非空的
 *   assistant 回复；
 * - 无任何派发痕迹 → 返回 null（信息不足，保持「待确认」）；
 * - 全部任务已完成 → done；否则 failed（首个未完成任务 = 失败/中断节点），
 *   与 applyPlanStatusLookup 对「running 视为上次执行被中断」的收敛语义一致，
 *   续跑仍需用户显式点击，绝不静默重放。
 */
export function derivePlanExecFromMessages(
  plan: { tasks?: Array<{ id?: unknown }> } | undefined,
  msgs: readonly PlanDeriveMsg[]
): PlanExecState | null {
  const ids = (plan?.tasks ?? [])
    .map((t) => (typeof t?.id === 'string' ? t.id.trim() : ''))
    .filter(Boolean);
  if (!ids.length) return null;

  const completed = new Set<string>();
  let dispatched = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const hit = PLAN_TASK_DISPATCH_RE.exec(m.content ?? '');
    if (!hit) continue;
    const id = (hit[1] ?? '').trim();
    if (!ids.includes(id)) continue;
    dispatched += 1;
    // 向后找该任务的产出：允许中间夹带非派发类 user 消息（如附件摘要），
    // 但以下一条「计划任务」派发消息为界，避免把后续任务的产出误记到本任务。
    for (let j = i + 1; j < msgs.length; j++) {
      const nxt = msgs[j];
      if (!nxt) continue;
      if (nxt.role === 'assistant') {
        if (!nxt.error && (nxt.content ?? '').trim()) completed.add(id);
        break;
      }
      if (nxt.role === 'user' && PLAN_TASK_DISPATCH_RE.test(nxt.content ?? ''))
        break;
    }
  }
  if (!dispatched) return null;

  const done: Record<string, boolean> = {};
  for (const id of ids) if (completed.has(id)) done[id] = true;
  if (ids.every((id) => completed.has(id))) return { status: 'done', done };
  return {
    status: 'failed',
    failedTaskId: ids.find((id) => !completed.has(id)),
    currentTaskId: undefined,
    done
  };
}

export interface RenderAttachmentsOpts {
  files: UploadedFile[];
  /** 点击图片缩略图时的预览回调（原组件内 this.openPreview）。 */
  onPreview: (f: UploadedFile) => void;
}

/**
 * 渲染图片附件：作为独立于气泡的附件卡片（调用方负责放在气泡上方，而非气泡内）。
 * - 单张图片：直接缩略图，点击预览。
 * - 多张图片：折叠态为**交错堆叠**（错位 + 旋转层叠）+「N 张」角标，点击展开为
 *   平铺网格；展开态提供「收起」按钮恢复堆叠；展开后单张点击预览。
 */
export function renderImageAttachments(
  opts: RenderAttachmentsOpts
): TemplateResult | typeof nothing {
  const { files, onPreview } = opts;
  const images = files.filter((f) => f.type.startsWith('image/'));
  const first = images[0];
  if (!first) return nothing;

  if (images.length === 1) {
    return html`
      <div
        class="attach-img is-previewable"
        title="点击预览"
        @click=${() => onPreview(first)}
      >
        <img src=${first.dataUrl} alt=${escapeHtml(first.name)} loading="lazy" />
      </div>
    `;
  }

  // 交错堆叠的居中系数：让 --i 围绕中点对称分布（层叠左右均衡）。
  const mid = (images.length - 1) / 2;
  const expand = (e: Event) => {
    const card = (e.currentTarget as HTMLElement).closest('.attach-card');
    if (card) card.classList.add('expanded');
  };
  const collapse = (e: Event) => {
    e.stopPropagation();
    const card = (e.currentTarget as HTMLElement).closest('.attach-card');
    if (card) card.classList.remove('expanded');
  };
  const onImgClick = (e: Event, f: UploadedFile) => {
    e.stopPropagation();
    onPreview(f);
  };

  return html`
    <div class="attach-card">
      <div class="attach-card-stack" title="点击展开全部图片" @click=${expand}>
        ${images.map(
          (f, i) =>
            html`<div class="attach-img" style="--i:${i};--mid:${mid}">
              <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
              ${i === images.length - 1
                ? html`<span class="attach-card-badge">${images.length} 张</span>`
                : nothing}
            </div>`
        )}
      </div>
      <div class="attach-card-expanded">
        <div class="attach-card-head">
          <span>${images.length} 张图片</span>
          <button
            type="button"
            class="attach-card-collapse"
            title="收起图片"
            @click=${collapse}
          >
            收起
          </button>
        </div>
        <div class="attach-card-grid">
          ${images.map(
            (f) =>
              html`<div
                class="attach-img is-previewable"
                title="点击预览"
                @click=${(e: Event) => onImgClick(e, f)}
              >
                <img src=${f.dataUrl} alt=${escapeHtml(f.name)} loading="lazy" />
              </div>`
          )}
        </div>
      </div>
    </div>
  `;
}

/**
 * 渲染非图片附件（PDF / 文本 / 表格等，走文字条目）。图片已由
 * renderImageAttachments 独立成卡片置于气泡外，此处不再处理图片。
 */
export function renderAttachments(
  opts: RenderAttachmentsOpts
): TemplateResult | typeof nothing {
  const { files } = opts;
  const others = files.filter((f) => !f.type.startsWith('image/'));
  if (others.length === 0) return nothing;
  return html`
    <div class="attachments">
      ${others.map(
        (f) =>
          html`<div class="attach-file">
            ${fileIcon(f)} ${escapeHtml(f.name)} (${formatSize(f.size)})
          </div>`
      )}
    </div>
  `;
}
