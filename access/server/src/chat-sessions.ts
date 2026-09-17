/**
 * 聊天会话存储（多会话 Chat App 的「会话管理」层）。
 *
 * 与 agent 运行期的 Memory（会话窗口）解耦：Memory 负责模型上下文，本存储负责
 * 「用户侧可见的会话列表 + 消息记录」持久化，供前端左侧栏渲染与跨刷新恢复。
 *
 * 进程内 Map 为权威态；若设置了 CHAT_SESSIONS_FILE 则额外落盘（JSON），
 * 进程重启后可恢复会话列表与历史。无文件配置时仅驻留内存（单实例够用）。
 *
 * 多用户隔离（P多用户）：每个会话归属一个 owner（= 登录用户名 ctx.sub）。
 * 所有读写函数均接收 owner 并校验归属，跨用户不可互见；旧存档无 owner 的会话
 * 归 'legacy' 桶，普通用户 list/get 均不可见（仅服务端保留，不泄露存在性）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { getHistoryStore } from './history-store';
import { publishChatEvent } from './chat-bus';

/** 无归属旧数据的兜底桶（仅服务端保留，普通用户不可见）。 */
export const LEGACY_OWNER = 'legacy';

/** 工具调用记录（存储态：参数/结果均已序列化为字符串，便于 JSON 持久化与跨端还原）。 */
export interface StoredTool {
  name: string;
  /** 入参：调用方已序列化为 JSON 字符串。 */
  args?: string;
  result?: string;
  errored?: boolean;
}

/** 计划执行进度镜像（与 @agent-harness/client 的 PlanExecMirror 形状一致，本地镜像避免包耦合）。 */
export interface PlanExecMirror {
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'awaiting';
  currentTaskId?: string;
  failedTaskId?: string;
  done: string[];
  /** P3：当前等待人工审批的任务 id 列表（status==='awaiting' 时有效）。 */
  awaiting?: string[];
  /** P2.6：紧凑 run 快照（前端落盘，服务端随信封透传，不做形状校验）。 */
  wfSnapshot?: unknown;
}

/** 调用链路追踪节点（结构与 @agent-harness/client 的 TraceNode 一致，本地镜像避免包耦合）。 */
export interface TraceNode {
  id: string;
  kind:
    | 'run'
    | 'step'
    | 'llm'
    | 'tool'
    | 'retrieval'
    | 'reasoning'
    | 'cost'
    | 'verify'
    | 'guardrail'
    | 'budget'
    | 'tokencache'
    | 'error';
  label: string;
  status: 'ok' | 'error' | 'pending';
  detail?: string;
  result?: string;
  meta?: Record<string, string>;
  /** LLM 调用时携带的「截至此次调用的会话消息上下文」（来自 getChatSession 的会话消息快照）。
   *  点击 LLM 节点时就地展开这 N 条消息（role + content）供回看。 */
  messages?: Array<{ role: string; content: string; ts: number; reasoning?: string }>;
  children: TraceNode[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 毫秒时间戳，用于排序与显示。 */
  ts: number;
  /** 推理过程（深度思考折叠块），仅推理模型会产出。 */
  reasoning?: string;
  /** 本轮处理中调用的工具列表，用于回看时还原工具卡片。 */
  tools?: StoredTool[];
  /** 调用链路追踪树，记录 LLM↔工具↔检索 的每一步，供深度思考界面可视化与复盘。 */
  trace?: TraceNode[];
  /** 计划模式（P0）：本条消息携带的结构化执行计划（plan:proposed 时随消息落盘，刷新/切回可还原计划卡片）。 */
  plan?: import('@agent-harness/core').ExecutionPlan;
  /** 计划模式：任务级执行进度镜像（服务端随任务派发/完成/失败事件维护），供前端恢复计划卡片状态。 */
  planStatus?: PlanExecMirror;
  /** 用户消息携带的附件（图片/文件预览）。url 兼容本地 dataUrl 或服务端上传地址，
   *  随会话历史持久化，供刷新 / 切回后还原气泡内图片。 */
  attachments?: Array<{ name: string; type: string; url?: string; serverUrl?: string }>;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** 归属用户（= 登录用户名 ctx.sub）。无归属旧数据记为 'legacy'。 */
  owner: string;
  /** 交互模式（问答/计划），按会话持久化，供跨设备对齐。 */
  interactionMode?: 'qa' | 'plan';
  /** 选中的模型标识，按会话持久化，供跨设备对齐。 */
  model?: string;
  /** 定向业务 agent id（空=默认通用 Agent），按会话持久化，供跨设备对齐。 */
  agentId?: string;
  /**
   * 归属工作空间 id（参考图能力链路 User → Workspace → …）。
   * 可选：旧数据 / 未指定时视为「未归类」，由前端归入默认空间展示。
   */
  workspaceId?: string;
}

const FILE = process.env.CHAT_SESSIONS_FILE || '';
const sessions = new Map<string, ChatSession>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  if (FILE && existsSync(FILE)) {
    try {
      const arr = JSON.parse(readFileSync(FILE, 'utf-8')) as Array<
        ChatSession & { owner?: string }
      >;
      for (const s of arr) {
        // 旧存档无 owner 字段：归 legacy 桶，普通用户不可见、不泄露存在性。
        sessions.set(s.id, { ...s, owner: s.owner ?? LEGACY_OWNER });
      }
    } catch {
      // 损坏的存档不致命：从空态继续。
    }
  }
}

/** 持久化到 JSON（原子写：tmp → rename，防崩溃产生半截文件）。 */
function persist(): void {
  if (!FILE) return;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmpPath = FILE + '.tmp';
    writeFileSync(tmpPath, JSON.stringify([...sessions.values()], null, 2), 'utf-8');
    renameSync(tmpPath, FILE);
  } catch {
    // 持久化失败不影响内存态运行，仅记录。
  }
}

function genId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 列出会话（按最近更新倒序）。
 * @param owner 指定时只返回该用户的会话；传 undefined 返回全部（运维/管理用，调用方需自行鉴权）。
 */
export function listChatSessions(owner?: string): ChatSession[] {
  load();
  const all = [...sessions.values()];
  const filtered = owner ? all.filter((s) => s.owner === owner) : all;
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 单页条数上限：与 memo / registry 等既有列表接口一致地做钳制，
 * 防止客户端传超大 limit 把整个会话表（含消息）一次拉走。
 */
export const CHAT_SESSION_MAX_PAGE = 200;

/**
 * 解析列表查询参数（原始字符串来源，容错）。
 * 非法值（NaN / 负数 / 空串）一律回落到缺省语义：limit 缺省 = 全量、offset 缺省 = 0。
 * 独立导出以便单测覆盖边界。
 */
export function parseSessionPageQuery(q: {
  limit?: string | null;
  offset?: string | null;
}): { limit?: number; offset: number } {
  const limitRaw = Number(q.limit);
  // 注意 Number(null) === 0、Number('') === 0，故「未传/空串」自然落入缺省分支。
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(CHAT_SESSION_MAX_PAGE, Math.floor(limitRaw))
      : undefined;
  const offsetRaw = Number(q.offset);
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  return { limit, offset };
}

/**
 * 分页列出会话（按最近更新倒序）——「历史列表滚动加载」的服务端入口。
 *
 * - 不传 limit 时返回自 offset 起的全部条目，保持既有「全量」契约向后兼容
 *   （老客户端不传分页参数时行为与改造前一致）。
 * - 返回 total / hasMore：total 为过滤后的全量条数（不受分页影响），
 *   hasMore 由「已取到的末尾是否已到全量末尾」推导，前端据此决定是否继续取下一页。
 *
 * 排序键是会变动的 updatedAt，故 offset 分页在「翻页间隙有会话被更新/新建」时
 * 可能出现个别条目重复或跳过；前端按 id 去重（见 chat-session-page.ts）已覆盖前者。
 */
export function listChatSessionsPage(
  owner?: string,
  opts: { limit?: number; offset?: number } = {}
): { sessions: ChatSession[]; total: number; hasMore: boolean } {
  const sorted = listChatSessions(owner);
  const total = sorted.length;
  const rawOffset = Math.floor(opts.offset ?? 0);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  // 缺省 limit = 「从 offset 到末尾」的全部剩余条目。
  const limit =
    opts.limit === undefined
      ? Math.max(0, total - offset)
      : Math.max(1, Math.min(CHAT_SESSION_MAX_PAGE, Math.floor(opts.limit) || 0));
  const page = sorted.slice(offset, offset + limit);
  return { sessions: page, total, hasMore: offset + page.length < total };
}

/**
 * 取单个会话（含消息记录）；不存在或 owner 不符时返回 null（不泄露存在性）。
 * @param owner 指定时做归属校验，不符返回 null。
 */
/**
 * 取单个会话（含消息记录）；不存在或 owner 不符时返回 null（不泄露存在性）。
 * 内存 Map 未命中时回退到聊天历史镜像（SQLite）：服务端重启后内存态清空、但镜像仍在，
 * 此时从镜像恢复会话并写回内存态。
 */
export async function getChatSession(
  id: string,
  owner?: string
): Promise<ChatSession | null> {
  load();
  let s = sessions.get(id);
  if (!s) {
    const row = await getHistoryStore().get(id, owner);
    if (row) {
      let msgs: ChatMessage[] = [];
      try {
        const env = JSON.parse(row.data) as { msgs?: ChatMessage[] };
        msgs = Array.isArray(env.msgs) ? env.msgs : [];
      } catch {
        /* 损坏信封忽略，按空消息恢复 */
      }
      s = {
        id,
        title: row.meta.title,
        createdAt: row.meta.updatedAt,
        updatedAt: row.meta.updatedAt,
        messages: msgs,
        owner: owner ?? LEGACY_OWNER
      };
      sessions.set(id, s);
    }
  }
  if (!s) return null;
  if (owner && s.owner !== owner) return null;
  return s;
}

/**
 * 同步读取（仅查内存 Map，不回退镜像）：供运行期 trace 重建等热路径使用，
 * 这些路径在调用前已通过 appendChatMessage 把会话写入内存态。需要镜像回退的
 * 接口层请改用异步 getChatSession。
 */
export function peekChatSession(id: string, owner?: string): ChatSession | null {
  load();
  const s = sessions.get(id);
  if (!s) return null;
  if (owner && s.owner !== owner) return null;
  return s;
}

/** 新建会话（归属 owner；可指定初始标题，留空则默认「新对话」）。 */
export function createChatSession(
  title?: string,
  owner = LEGACY_OWNER,
  meta?: ChatSessionMeta
): ChatSession {
  load();
  const now = Date.now();
  const session: ChatSession = {
    id: genId(),
    title: title?.trim() || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    owner,
    ...(meta?.interactionMode ? { interactionMode: meta.interactionMode } : {}),
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.agentId ? { agentId: meta.agentId } : {}),
    ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {})
  };
  sessions.set(session.id, session);
  persist();
  // 跨设备广播：其它端实时看到新会话（左侧栏即时出现）。
  if (owner && owner !== LEGACY_OWNER) {
    publishChatEvent(owner, { type: 'session:list' });
  }
  return session;
}

/**
 * 更新会话元数据（标题 + 可选的交互模式/模型/agent，按会话持久化，供跨设备对齐）。
 * owner 不符或不存在返回 null。内存 Map 未命中时回退到聊天历史镜像（SQLite）。
 */
export interface ChatSessionMeta {
  interactionMode?: 'qa' | 'plan';
  model?: string;
  agentId?: string;
  /** 归属工作空间 id（可选，见 ChatSession.workspaceId）。 */
  workspaceId?: string;
}

export async function renameChatSession(
  id: string,
  title: string,
  owner?: string,
  meta?: ChatSessionMeta
): Promise<ChatSession | null> {
  load();
  let s = sessions.get(id);
  if (!s) {
    // 回退：从聊天历史镜像恢复（owner 由服务端鉴权层传入，与镜像 owner 一致）。
    const row = await getHistoryStore().get(id, owner);
    if (row) {
      let msgs: ChatMessage[] = [];
      try {
        const env = JSON.parse(row.data) as { msgs?: ChatMessage[] };
        msgs = Array.isArray(env.msgs) ? env.msgs : [];
      } catch {
        /* 损坏信封忽略，按空消息恢复 */
      }
      s = {
        id,
        title: row.meta.title,
        createdAt: row.meta.updatedAt,
        updatedAt: row.meta.updatedAt,
        messages: msgs,
        owner: owner ?? LEGACY_OWNER
      };
      sessions.set(id, s);
    }
  }
  if (!s) return null;
  if (owner && s.owner !== owner) return null;
  s.title = title?.trim() || s.title;
  // 合并按会话持久化的设置（仅当调用方显式传入才覆盖，未传入保留原值）。
  if (meta) {
    if (meta.interactionMode !== undefined) s.interactionMode = meta.interactionMode;
    if (meta.model !== undefined) s.model = meta.model;
    if (meta.agentId !== undefined) s.agentId = meta.agentId;
    if (meta.workspaceId !== undefined) s.workspaceId = meta.workspaceId;
  }
  s.updatedAt = Date.now();
  persist();
  // 跨设备广播：其它端标题/时间/设置实时同步（不重发全量消息）。
  if (owner && owner !== LEGACY_OWNER) {
    publishChatEvent(owner, {
      type: 'session:meta',
      session: id,
      title: s.title,
      updatedAt: s.updatedAt,
      ...(s.interactionMode ? { interactionMode: s.interactionMode } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.agentId ? { agentId: s.agentId } : {})
    });
  }
  // 同步写回历史镜像（SQLite），保证镜像中的标题也更新（镜像为主持久化层）。
  try {
    const store = getHistoryStore();
    const existing = await store.get(id, owner);
    const data = existing?.data ?? JSON.stringify({ msgs: s.messages });
    await store.upsert(
      {
        sid: id,
        title: s.title,
        updatedAt: s.updatedAt,
        savedAt: s.updatedAt
      },
      data,
      owner ?? s.owner
    );
  } catch {
    /* 镜像写回失败不致命：内存态已更新 */
  }
  return s;
}

/** 删除会话及其消息记录；owner 不符或不存在返回 false。
 *  同时清理内存 Map 与历史镜像（SQLite），保证两个存储一致。 */
export async function deleteChatSession(
  id: string,
  owner?: string
): Promise<boolean> {
  load();
  const s = sessions.get(id);
  if (s && owner && s.owner !== owner) return false;
  const ok = sessions.delete(id);
  if (ok) persist();
  // 跨设备广播：其它端列表实时移除该会话。
  if (owner && owner !== LEGACY_OWNER) {
    publishChatEvent(owner, { type: 'session:remove', session: id });
  }
  // 同步清理历史镜像（镜像为主持久化层）；Map 未命中也尝试删镜像。
  let mirrorOk = false;
  try {
    mirrorOk = await getHistoryStore().remove(id, owner);
  } catch {
    /* 镜像清理失败不致命 */
  }
  return ok || mirrorOk;
}

/**
 * 向会话追加一条消息并自动更新时间戳。
 * 首条用户消息会自动作为会话标题（取前 40 字），复刻 DeepSeek 的「首句作标题」体验。
 *
 * 归属校验：若会话已存在且 owner 与传入 owner 不符，返回 null（越权写入被拒），
 * 调用方应据此向前端报 404/403。自动新建的会话归属传入 owner。
 */
export function appendChatMessage(
  id: string,
  msg: ChatMessage,
  owner = LEGACY_OWNER,
  origin = ''
): ChatSession | null {
  load();
  let s = sessions.get(id);
  if (s) {
    // 会话已存在：校验归属，禁止越权写入他人会话。
    if (s.owner !== owner) return null;
  } else {
    const now = Date.now();
    s = { id, title: '新对话', createdAt: now, updatedAt: now, messages: [], owner };
    sessions.set(id, s);
  }
  // 源头去重：紧邻上一条消息同 role+同内容则跳过（编辑重发/断连重连重放等场景
  // 会把同一 user 内容二次写入，若在此放任落库，刷新与跨设备恢复后重复永远跟着走）。
  // 只比对「紧邻上一条」：隔了 assistant 回复再发相同文本属合法重问，必须保留。
  const lastMsg = s.messages[s.messages.length - 1];
  if (
    lastMsg &&
    lastMsg.role === msg.role &&
    (lastMsg.content ?? '') === (msg.content ?? '') &&
    (msg.content ?? '').length > 0
  ) {
    s.updatedAt = Date.now();
    persist();
    return s;
  }
  s.messages.push(msg);
  s.updatedAt = Date.now();
  let titleChanged = false;
  if (msg.role === 'user') {
    const userCount = s.messages.filter((m) => m.role === 'user').length;
    if (userCount === 1 && msg.content.trim()) {
      // 首次用户输入作标题：去首尾/内部多余空白与换行，过长截断并加省略号（保存进库）。
      const raw = msg.content.trim().replace(/\s+/g, ' ');
      const TITLE_MAX = 40;
      const newTitle = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX - 1) + '…' : raw;
      if (newTitle !== s.title) {
        s.title = newTitle;
        titleChanged = true;
      }
    }
  }
  persist();
  // 跨设备广播：首次用户输入改标题时，实时把新标题推给其它端（否则列表项标题空白、
  // 需手动刷新才从列表接口拉到）。仅标题真正变化时才发，避免无谓广播。
  if (titleChanged && owner && owner !== LEGACY_OWNER) {
    publishChatEvent(owner, {
      type: 'session:meta',
      session: id,
      title: s.title,
      updatedAt: s.updatedAt
    });
  }
  // 跨设备广播：其它端实时收到增量消息（本端本地已乐观插入，按 origin 去重回声）。
  if (owner && owner !== LEGACY_OWNER) {
    publishChatEvent(owner, {
      type: 'message:append',
      session: id,
      message: msg,
      origin
    });
  }
  return s;
}

/**
 * 计划任务派发消息前缀：`【计划任务 <id>】标题`，由 webapp `confirmPlan` 生成。
 * 两侧格式必须保持一致；此处对 id 宽匹配（`t1` / `1` / `task-1` 均可）——
 * planner 提示词只「建议」用 tN 命名，旧实现只认 `t\d+`，会把其它命名的计划
 * 任务全部漏记，镜像恒空 → 刷新后计划卡片回落为「待确认」。
 */
const PLAN_TASK_DISPATCH_RE = /^【计划任务\s*([^】]+)】/;

/** 从 run:start 的 input 提取计划任务 id；非「计划任务派发」返回 null。 */
export function extractPlanTaskId(input: unknown): string | null {
  const m = PLAN_TASK_DISPATCH_RE.exec(typeof input === 'string' ? input : '');
  const id = m?.[1]?.trim();
  return id ? id : null;
}

/**
 * 计划模式（P0）：更新会话内携带计划的最新一条 assistant 消息的执行进度镜像。
 * 服务端在任务派发/完成/失败事件时调用，把任务级状态随消息持久化 ——
 * 前端刷新 / 切回 / 服务重启后据此还原计划卡片并支持「从失败任务继续」。
 * 无可挂载的 plan 消息时不做任何事（普通问答不受影响）。owner 不符则静默跳过。
 */
export function updatePlanStatus(
  id: string,
  mutate: (prev: PlanExecMirror) => PlanExecMirror,
  owner?: string
): void {
  load();
  const s = sessions.get(id);
  if (!s) return;
  if (owner && s.owner !== owner) return;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (!m) continue;
    if (m.role === 'assistant' && m.plan) {
      const prev: PlanExecMirror = m.planStatus ?? {
        status: 'running',
        done: []
      };
      m.planStatus = finalizePlanStatus(
        mutate({ ...prev, done: [...prev.done] }),
        (m.plan.tasks ?? []).map((t) => t.id)
      );
      persist();
      return;
    }
  }
}

/**
 * 计划状态收敛：全部任务均已完成后固化 `done`。
 *
 * 为什么必须由服务端补这一步：任务派发 / 完成事件只携带「当前任务」，服务端据此推出
 * 的 done 集合已足以判定整体完成 —— 但此前恒返回 `running`，镜像永远表达不出「已完成」。
 * 后果是刷新 / 换设备恢复时前端只能把 running 收敛为 failed（视为执行中断），
 * 已成功的计划被显示成「执行失败」。
 *
 * 仅当计划任务 id 全部落在 done 内才固化；任一状态为 failed 时保持 failed（不掩盖错误）。
 */
export function finalizePlanStatus(
  st: PlanExecMirror,
  taskIds: readonly string[]
): PlanExecMirror {
  if (st.status === 'failed' || st.status === 'cancelled') return st;
  const ids = taskIds.filter((t): t is string => typeof t === 'string' && !!t);
  if (!ids.length) return st;
  if (!ids.every((tid) => st.done.includes(tid))) return st;
  return {
    status: 'done',
    done: [...st.done],
    currentTaskId: undefined,
    failedTaskId: undefined,
    // P2.6：紧凑 run 快照由前端随镜像写入（DAG 路径），服务端固化时保留透传。
    ...(st.wfSnapshot ? { wfSnapshot: st.wfSnapshot } : {})
  };
}

/**
 * DAG 终态事件的最小形态（本地镜像，避免为此引入 core 的 WorkflowEvent 全量类型；
 * core 的 wf:done / wf:failed 事件结构上兼容本形状，多余字段透传无碍）。
 */
export interface PlanWfTerminalEvent {
  type: 'wf:done' | 'wf:failed';
  run?: { steps?: Record<string, { state?: string; id?: string; output?: unknown }> };
}

/**
 * P2.7（修复）：把 DAG 计划执行的终态写入会话权威源（planStatus 固化 + 执行摘要追加）。
 *
 * 根因背景：DAG 路径（/api/workflows from-plan → DagEngine）此前只同步「计划」Tab 看板
 * （PlanStore 旁路视图），从不调用 updatePlanStatus / appendChatMessage —— 会话权威源
 * （内存 Map / CHAT_SESSIONS_FILE）里永远只有「计划提案」消息，既无 planStatus 也无执行
 * 摘要。前端刷新走 getChatSession 内存命中（不回退镜像）→ 卡片退回「待确认」、执行结果
 * 看似「消失」；数据实际在前端历史镜像里，故服务端重启后（镜像回退分支命中）又能恢复 ——
 * 刷新 / 重新登录结果不对称的直接来源。
 *
 * 调用点：server.ts createPlanTaskSync 的 wf:done / wf:failed 终态帧（首跑 / 续跑 / 审批
 * 放行三个端点共用）。旁路纪律：失败仅告警，绝不阻断 DAG 执行（由调用方 catch）。
 * 幂等：appendChatMessage 的紧邻同 role 同内容去重保证终态帧重放（resume）不产生重复摘要。
 * 摘要文本与前端 appendPlanDagSummary 逐字节一致（同一 run 快照同格式），跨源对账 /
 * 跨设备回声去重均可按内容匹配。
 */
export async function applyPlanWfTerminal(
  id: string,
  e: PlanWfTerminalEvent,
  owner?: string
): Promise<void> {
  // 内存未命中时回退镜像（服务端刚重启的会话）；owner 不符 / 不存在时 getChatSession 返回 null。
  const sess = await getChatSession(id, owner);
  if (!sess) return;
  const ownerName = sess.owner;
  let planMsg: ChatMessage | undefined;
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m && m.role === 'assistant' && m.plan) {
      planMsg = m;
      break;
    }
  }
  if (!planMsg?.plan) return;
  const plan = planMsg.plan;
  const tasks = plan.tasks ?? [];
  const taskIds = tasks.map((t) => t.id).filter((t): t is string => typeof t === 'string' && !!t);
  if (!taskIds.length) return;
  const failed = e.type === 'wf:failed';
  const steps = e.run?.steps ?? {};
  const stepStateOf = (tid: string): string | undefined => steps[tid]?.state;
  // 已完成任务（done/skipped/compensated 均算「已走完」；与前端 applyPlanWfEvent 的
  // 卡片终态语义一致 —— failed 时保留已完成集合，卡片出现「从失败任务继续」）。
  const doneIds = taskIds.filter((tid) => {
    const st = stepStateOf(tid);
    return st === 'done' || st === 'skipped' || st === 'compensated';
  });
  let failedTaskId: string | undefined;
  if (failed) {
    // 首个 failed step；无则首个未完成 task（与前端 wf:failed 的 failedTaskId 定位一致）。
    failedTaskId =
      taskIds.find((tid) => stepStateOf(tid) === 'failed') ??
      taskIds.find((tid) => !doneIds.includes(tid));
  }
  updatePlanStatus(
    id,
    (prev) => ({
      ...prev,
      status: failed ? 'failed' : 'done',
      ...(failed ? { failedTaskId } : { failedTaskId: undefined }),
      currentTaskId: undefined,
      done: Array.from(new Set([...prev.done, ...doneIds]))
    }),
    ownerName
  );
  // 执行摘要：与前端 appendPlanDagSummary 逐字节一致（行格式 / ✅❌⏭ / 输出 300 字截断）。
  const lines: string[] = [`📋 计划执行摘要：${plan.goal}（共 ${tasks.length} 个任务）`];
  for (const t of tasks) {
    if (typeof t.id !== 'string') continue;
    const state = stepStateOf(t.id) ?? 'pending';
    const mark = state === 'done' ? '✅' : state === 'failed' ? '❌' : '⏭';
    lines.push(`${mark} ${t.id} ${t.title}（${state}）`);
    const out = steps[t.id]?.output;
    if (out != null && typeof out === 'string' && out.trim()) {
      lines.push(`   ${out.length > 300 ? out.slice(0, 300) + '…' : out}`);
    }
  }
  appendChatMessage(
    id,
    { role: 'assistant', content: lines.join('\n'), ts: Date.now() },
    ownerName,
    'plan-wf-terminal'
  );
  // 镜像写回（与 renameChatSession 同款纪律）：权威源（内存 Map）在服务端重启后
  // 由镜像回退恢复（getChatSession fallback）——若终态固化只写内存，重启后权威源
  // 永远缺 planStatus/摘要（刷新丢结果的根因在重启态复现）。此处把当前会话消息整体
  // 写回历史镜像（幂等 upsert），重启态恢复路径与热运行态一致。
  // 信封 usage 保留既有值（服务端无会话用量快照；覆盖写 null 会抹掉前端落盘的用量快照，
  // 恢复后上下文用量浮层归零）：读现有镜像的 usage 原样带回。
  try {
    const existing = await getHistoryStore().get(id, ownerName);
    let usage: unknown = null;
    if (existing) {
      try {
        usage = (JSON.parse(existing.data) as { usage?: unknown }).usage ?? null;
      } catch {
        usage = null;
      }
    }
    await getHistoryStore().upsert(
      { sid: id, title: sess.title, updatedAt: sess.updatedAt, savedAt: Date.now() },
      JSON.stringify({ msgs: sess.messages, usage }),
      ownerName
    );
  } catch {
    /* 镜像写回失败不致命：内存态已更新，下次前端 saveHistory 会重新对齐 */
  }
}
