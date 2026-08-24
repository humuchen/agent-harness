/**
 * 聊天历史容错持久化（localStorage 本地镜像层）。
 *
 * 设计目标（与 chat.ts 的会话管理配合）：
 * 1）恢复失败不清数据：selectSession 拉取服务端历史失败时，回退到本模块的镜像，
 *    绝不把本地已有记录清空 / 覆盖；
 * 2）写读解耦：镜像写入发生在发送与 run 收尾处，独立于恢复流程的结果——
 *    无论之前是否发生过恢复失败，消息都会被可靠保存；
 * 3）可重试：恢复失败的会话被打上标记（restoreFailed），下次进入自动重试，
 *    而不是把空数组当成「已加载」永久缓存；
 * 4）不一致防御：sanitizeMessages 做类型校验 / 字段收敛 / 连续重复去重 / 保序；
 *    mergeThreadHistories 以「最长尾首重叠」合并服务端与本地两个版本，避免丢消息或重复。
 *
 * 全部 API 吞掉内部异常并以可判定的返回值表达结果（降级策略），绝不向上抛错阻断 UI。
 */

const KEY_PREFIX = 'ah_chat_history_'; // 单会话镜像 key：ah_chat_history_<sid>
const KEY_INDEX = 'ah_chat_index_v1'; // 会话元信息索引：{ [sid]: { title, updatedAt, savedAt } }
const ENVELOPE_VERSION = 1;
/** 单会话镜像保留的最大消息数（超出裁掉最旧的，防配额膨胀）。 */
const MAX_MSGS = 200;
/** 单条消息内容在镜像中的字符上限（超大单条同样会撑爆 5MB 配额）。 */
const MAX_CONTENT = 100_000;

/* ----------------------------- 工具 ----------------------------- */

/** 给任意 Promise 加超时（恢复流程要求能处理「加载超时」场景）。 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, val: string): boolean {
  try {
    localStorage.setItem(key, val);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- 数据消毒 --------------------------- */

export interface MirroredTool {
  name: string;
  args: string;
  result?: string;
  errored?: boolean;
}

export interface MirroredMsg {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  tools?: MirroredTool[];
  /** 结构化追踪树原样透传（JSON 安全值），恢复时还原深度思考区。 */
  trace?: unknown;
  error?: boolean;
}

const clampStr = (v: unknown, cap = MAX_CONTENT): string =>
  typeof v === 'string' ? (v.length > cap ? v.slice(0, cap) : v) : '';

/**
 * 把任意来源（服务端响应 / 镜像读取 / 内存缓冲）的消息列表收敛成可信形状：
 * - 过滤非法条目（非对象、role 缺失、content/reasoning/tools 全空的占位）；
 * - 字段逐一收敛为安全类型并截断超长内容；
 * - 去除「连续同 role 同 content」的重复条目（防御双重 append / 重放乱序注入）；
 * - 保持原始顺序（服务端顺序即权威顺序，不做重排）。
 */
export function sanitizeMessages(raw: unknown): MirroredMsg[] {
  if (!Array.isArray(raw)) return [];
  const out: MirroredMsg[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const role: 'user' | 'assistant' = o.role === 'user' ? 'user' : 'assistant';
    const content = clampStr(o.content);
    const reasoning = clampStr(o.reasoning);
    const tools = Array.isArray(o.tools)
      ? o.tools
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t) => ({
            name: clampStr(t.name, 500),
            args: clampStr(t.args),
            result: typeof t.result === 'string' ? clampStr(t.result) : undefined,
            errored: t.errored === true
          }))
          .filter((t) => t.name)
      : undefined;
    // 全空占位（如尚未流式完成的 assistant 空壳）不入镜。
    if (!content && !reasoning && !(tools && tools.length)) continue;
    // 连续完全相同的 (role+content) 视为重复写入，去重保序。
    const prev = out[out.length - 1];
    if (prev && prev.role === role && prev.content === content && !reasoning && !tools) continue;
    out.push({
      role,
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(tools && tools.length ? { tools } : {}),
      ...(o.trace != null && typeof o.trace === 'object' ? { trace: o.trace } : {}),
      ...(o.error === true ? { error: true } : {})
    });
  }
  return out;
}

/**
 * 合并服务端权威历史与本地（可能更新的）缓冲，处理「记录丢失 / 重复」两类不一致：
 * - 计算 server 尾部与 local 头部按 (role+content) 的最长重叠（本地镜像往往是服务端的旧子集 +
 *   若干新消息），重叠部分以 server 为准只保留一份；
 * - 结果 = server 未重叠前缀 + local 全部，既不丢本地新消息也不引入重复。
 */
export function mergeThreadHistories(server: MirroredMsg[], local: MirroredMsg[]): MirroredMsg[] {
  if (!server.length) return local;
  if (!local.length) return server;
  const keyOf = (m: MirroredMsg) => `${m.role}\u0000${m.content}`;
  const maxOverlap = Math.min(server.length, local.length);
  let overlap = 0;
  for (let k = maxOverlap; k > 0; k--) {
    let matched = true;
    for (let i = 0; i < k; i++) {
      if (keyOf(server[server.length - k + i]) !== keyOf(local[i])) {
        matched = false;
        break;
      }
    }
    if (matched) {
      overlap = k;
      break;
    }
  }
  return [...server.slice(0, server.length - overlap), ...local];
}

/* ------------------------- 会话镜像读写 ------------------------- */

interface Envelope {
  v: number;
  sid: string;
  savedAt: number;
  msgs: MirroredMsg[];
}

/** 把某会话的消息缓冲镜像进 localStorage。成功返回 true；配额不足等失败按阶梯降级重试。 */
export function saveThread(
  sid: string,
  meta: { title: string; updatedAt?: number | string },
  rawMsgs: unknown[]
): boolean {
  if (!sid) return false;
  const msgs = sanitizeMessages(rawMsgs).slice(-MAX_MSGS);
  const env = (list: MirroredMsg[]): Envelope => ({
    v: ENVELOPE_VERSION,
    sid,
    savedAt: Date.now(),
    msgs: list
  });
  // 降级阶梯：完整 → 去 trace → 裁半 → 再裁半，逐级瘦身直到写入成功或放弃（静默，不抛错）。
  let list = msgs;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (safeSet(KEY_PREFIX + sid, JSON.stringify(env(list)))) {
      upsertIndex(sid, meta);
      return true;
    }
    if (attempt === 0) list = msgs.map(({ trace, ...rest }) => rest);
    else list = list.slice(-Math.max(1, Math.floor(list.length / 2)));
  }
  return false;
}

/** 读取某会话的本地镜像；信封损坏 / 版本不符 / 内容非法一律返回 null（由调用方降级）。 */
export function loadThread(sid: string): MirroredMsg[] | null {
  const text = safeGet(KEY_PREFIX + sid);
  if (!text) return null;
  try {
    const env = JSON.parse(text) as Envelope;
    if (!env || env.v !== ENVELOPE_VERSION || env.sid !== sid || !Array.isArray(env.msgs)) {
      return null;
    }
    const msgs = sanitizeMessages(env.msgs);
    return msgs.length ? msgs : null;
  } catch {
    return null;
  }
}

export function deleteThread(sid: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + sid);
  } catch {
    /* ignore */
  }
}

/* --------------------------- 会话索引 --------------------------- */

export interface MirrorMeta {
  title: string;
  updatedAt?: number | string;
  savedAt: number;
}

/** 读取会话索引；损坏则返回空表（降级为「无离线会话」而非报错）。 */
export function loadIndex(): Record<string, MirrorMeta> {
  const text = safeGet(KEY_INDEX);
  if (!text) return {};
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, MirrorMeta> = {};
    for (const [sid, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const m = v as Record<string, unknown>;
      if (typeof m.title !== 'string' || !m.title) continue;
      out[sid] = {
        title: m.title,
        updatedAt: typeof m.updatedAt === 'number' || typeof m.updatedAt === 'string'
          ? (m.updatedAt as number | string)
          : undefined,
        savedAt: typeof m.savedAt === 'number' ? m.savedAt : 0
      };
    }
    return out;
  } catch {
    return {};
  }
}

function upsertIndex(sid: string, meta: { title: string; updatedAt?: number | string }): void {
  const idx = loadIndex();
  idx[sid] = { title: meta.title, updatedAt: meta.updatedAt, savedAt: Date.now() };
  safeSet(KEY_INDEX, JSON.stringify(idx));
}

function removeIndex(sid: string): void {
  const idx = loadIndex();
  delete idx[sid];
  safeSet(KEY_INDEX, JSON.stringify(idx));
}

/** 删除会话时同步清理镜像与索引（与 deleteChatSession 配对调用）。 */
export function purgeSessionMirror(sid: string): void {
  deleteThread(sid);
  removeIndex(sid);
}
