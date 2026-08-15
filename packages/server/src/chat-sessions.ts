/**
 * 聊天会话存储（多会话 Chat App 的「会话管理」层）。
 *
 * 与 agent 运行期的 Memory（会话窗口）解耦：Memory 负责模型上下文，本存储负责
 * 「用户侧可见的会话列表 + 消息记录」持久化，供前端左侧栏渲染与跨刷新恢复。
 *
 * 进程内 Map 为权威态；若设置了 CHAT_SESSIONS_FILE 则额外落盘（JSON），
 * 进程重启后可恢复会话列表与历史。无文件配置时仅驻留内存（单实例够用）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 工具调用记录（存储态：参数/结果均已序列化为字符串，便于 JSON 持久化与跨端还原）。 */
export interface StoredTool {
  name: string;
  /** 入参：调用方已序列化为 JSON 字符串。 */
  args?: string;
  result?: string;
  errored?: boolean;
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
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

const FILE = process.env.CHAT_SESSIONS_FILE || '';
const sessions = new Map<string, ChatSession>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  if (FILE && existsSync(FILE)) {
    try {
      const arr = JSON.parse(readFileSync(FILE, 'utf-8')) as ChatSession[];
      for (const s of arr) sessions.set(s.id, s);
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

/** 列出全部会话（按最近更新倒序）。 */
export function listChatSessions(): ChatSession[] {
  load();
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 取单个会话（含消息记录）；不存在返回 null。 */
export function getChatSession(id: string): ChatSession | null {
  load();
  return sessions.get(id) ?? null;
}

/** 新建会话（可指定初始标题，留空则默认「新对话」）。 */
export function createChatSession(title?: string): ChatSession {
  load();
  const now = Date.now();
  const session: ChatSession = {
    id: genId(),
    title: title?.trim() || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  sessions.set(session.id, session);
  persist();
  return session;
}

/** 重命名会话（标题用于左侧栏展示）。 */
export function renameChatSession(id: string, title: string): ChatSession | null {
  load();
  const s = sessions.get(id);
  if (!s) return null;
  s.title = title?.trim() || s.title;
  s.updatedAt = Date.now();
  persist();
  return s;
}

/** 删除会话及其消息记录。 */
export function deleteChatSession(id: string): boolean {
  load();
  const ok = sessions.delete(id);
  if (ok) persist();
  return ok;
}

/**
 * 向会话追加一条消息并自动更新时间戳。
 * 首条用户消息会自动作为会话标题（取前 40 字），复刻 DeepSeek 的「首句作标题」体验。
 */
export function appendChatMessage(id: string, msg: ChatMessage): ChatSession | null {
  load();
  let s = sessions.get(id);
  if (!s) {
    const now = Date.now();
    s = { id, title: '新对话', createdAt: now, updatedAt: now, messages: [] };
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
