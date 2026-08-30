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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getHistoryStore } from './history-store';

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
  status: 'running' | 'done' | 'failed' | 'cancelled';
  currentTaskId?: string;
  failedTaskId?: string;
  done: string[];
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

function persist(): void {
  if (!FILE) return;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify([...sessions.values()], null, 2), 'utf-8');
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
export function createChatSession(title?: string, owner = LEGACY_OWNER): ChatSession {
  load();
  const now = Date.now();
  const session: ChatSession = {
    id: genId(),
    title: title?.trim() || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    owner,
  };
  sessions.set(session.id, session);
  persist();
  return session;
}

/**
 * 重命名会话（标题用于左侧栏展示）；owner 不符或不存在返回 null。
 * 内存 Map 未命中时回退到聊天历史镜像（SQLite）：服务端重启后内存态清空、但镜像仍在，
 * 此时从镜像恢复会话（含消息）并写回内存态，保证重命名对「仅存于镜像」的会话也生效。
 */
export async function renameChatSession(
  id: string,
  title: string,
  owner?: string
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
  s.updatedAt = Date.now();
  persist();
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
  owner = LEGACY_OWNER
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
  s.messages.push(msg);
  s.updatedAt = Date.now();
  if (msg.role === 'user') {
    const userCount = s.messages.filter((m) => m.role === 'user').length;
    if (userCount === 1 && msg.content.trim()) {
      s.title = msg.content.trim().slice(0, 40);
    }
  }
  persist();
  return s;
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
    if (m.role === 'assistant' && m.plan) {
      const prev: PlanExecMirror = m.planStatus ?? {
        status: 'running',
        done: []
      };
      m.planStatus = mutate({ ...prev, done: [...prev.done] });
      persist();
      return;
    }
  }
}
