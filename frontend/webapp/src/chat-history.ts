/**
 * 聊天历史容错持久化（接口层）。
 *
 * ah_chat_history 已从 localStorage 迁出：本模块是前端唯一的「历史镜像」读写入口，
 * 全部存取经 /api/v1/history* 接口打到服务端 ChatHistoryStore（默认 SQLite 临时
 * 持久化，预留正式数据库扩展点），前端不再直接依赖 localStorage。
 *
 * 设计目标（与 chat.ts 的会话管理配合）：
 * 1）恢复失败不清数据：selectSession 拉取权威历史失败时，回退到本模块镜像，
 *    绝不把已有记录清空 / 覆盖；
 * 2）写读解耦：镜像写入发生在发送与 run 收尾处，独立于恢复流程的结果；
 * 3）可重试：恢复失败的会话由 chat.ts 打 restoreFailed 标记，下次进入自动重试；
 * 4）不一致防御：sanitizeMessages 做类型校验 / 字段收敛 / 连续重复去重 / 保序；
 *    mergeThreadHistories 以「最长尾首重叠」合并权威与镜像两个版本。
 *
 * 降级策略：服务端不可达时回退进程内缓存（页内读写仍可用，仅失去跨刷新持久化）；
 * 全部 API 吞掉内部异常并以可判定返回值表达结果，绝不向上抛错阻断 UI。
 */

import { client } from './api';

/** 单会话镜像保留的最大消息数（超出裁掉最旧的，控制单行体积）。 */
const MAX_MSGS = 200;
/** 单条消息内容在镜像中的字符上限。 */
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
  /** 计划模式：结构化执行计划原样透传（JSON 安全值），恢复时还原计划卡片。 */
  plan?: unknown;
  /** 计划模式：任务级执行进度镜像（服务端维护），恢复时还原卡片状态并支持续跑。 */
  planStatus?: {
    status: 'running' | 'done' | 'failed' | 'cancelled';
    currentTaskId?: string;
    failedTaskId?: string;
    done: string[];
  };
  /** 用户消息携带的附件（图片/文件预览）。随镜像落盘需在体积上限内（超大图不持久化）。 */
  attachments?: Array<{ name: string; type: string; url?: string; serverUrl?: string }>;
  error?: boolean;
  /** 本轮 run 期间是否触发过上下文压缩，随消息落盘以在恢复后于气泡下方还原「已压缩」标识。 */
  compressed?: boolean;
}

const clampStr = (v: unknown, cap = MAX_CONTENT): string =>
  typeof v === 'string' ? (v.length > cap ? v.slice(0, cap) : v) : '';

/** 计划进度镜像收敛：形状非法或缺 done 数组时丢弃（恢复时宁缺勿错）。 */
function sanitizePlanStatus(
  v: unknown
): Record<string, never> | { planStatus: NonNullable<MirroredMsg['planStatus']> } {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const status = o.status;
  if (
    (status !== 'running' && status !== 'done' && status !== 'failed' && status !== 'cancelled') ||
    !Array.isArray(o.done)
  ) {
    return {};
  }
  return {
    planStatus: {
      status,
      ...(typeof o.currentTaskId === 'string' ? { currentTaskId: o.currentTaskId } : {}),
      ...(typeof o.failedTaskId === 'string' ? { failedTaskId: o.failedTaskId } : {}),
      done: o.done.filter((x): x is string => typeof x === 'string')
    }
  };
}

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
    // 附件（图片/文件预览）：收敛字段并丢弃超大 dataUrl（避免历史被撑爆），
    // 仅当次会话内存仍保留完整预览，镜像/恢复仅保留体积受限内的数据。
    const attachments = Array.isArray(o.attachments)
      ? (o.attachments as unknown[])
          .filter(
            (a): a is Record<string, unknown> =>
              !!a &&
              typeof a === 'object' &&
              typeof (a as Record<string, unknown>).name === 'string' &&
              typeof (a as Record<string, unknown>).type === 'string'
          )
          .map((a) => {
            const url = typeof a.url === 'string' ? a.url : '';
            const serverUrl = typeof a.serverUrl === 'string' ? a.serverUrl : undefined;
            return {
              name: a.name as string,
              type: a.type as string,
              ...(url && url.length <= 5_000_000 ? { url } : {}),
              ...(serverUrl ? { serverUrl } : {})
            };
          })
          .filter((a) => a.url || a.serverUrl)
      : undefined;
    // 全空占位（如尚未流式完成的 assistant 空壳）不入镜。
    if (!content && !reasoning && !(tools && tools.length)) continue;
    // 连续完全相同的 (role+content) 视为重复写入，去重保序。
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === role &&
      prev.content === content &&
      !reasoning &&
      !tools &&
      // 仅当本条也无附件时才按重复跳过，避免把「带图消息」误判为重复占位丢弃。
      !(attachments && attachments.length)
    )
      continue;
    out.push({
      role,
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(tools && tools.length ? { tools } : {}),
      ...(attachments && attachments.length ? { attachments } : {}),
      ...(o.trace != null && typeof o.trace === 'object' ? { trace: o.trace } : {}),
      ...(o.plan != null && typeof o.plan === 'object' ? { plan: o.plan } : {}),
      ...sanitizePlanStatus(o.planStatus),
      ...(o.error === true ? { error: true } : {}),
      ...(o.compressed === true ? { compressed: true } : {})
    });
  }
  return out;
}

/**
 * 合并权威历史与本地（可能更新的）缓冲，处理「记录丢失 / 重复」两类不一致：
 * - 计算 server 尾部与 local 头部按 (role+content) 的最长重叠（镜像往往是权威的旧子集 +
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
      const sv = server[server.length - k + i];
      const lv = local[i];
      if (!sv || !lv || keyOf(sv) !== keyOf(lv)) {
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

/* --------------------- 会话镜像读写（接口层） --------------------- */

export interface MirrorMeta {
  title: string;
  updatedAt?: number;
  savedAt: number;
}

/** 进程内兜底缓存：服务端不可达时保持页内读写可用（跨刷新持久化由服务端负责）。 */
const memThreads = new Map<string, MirroredMsg[]>();
const memIndex = new Map<string, MirrorMeta>();

/** 镜像用量快照：会话级上下文用量（backendUsage）+ 本运行累计（runCumulative），
 * 随历史一并落盘，刷新/切换会话后回填上下文用量浮层，避免归零或回退粗估。 */
export interface MirroredUsage {
  backendUsage: {
    window: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 自上次用量上报以来是否发生过上下文压缩（历史淘汰）。 */
    compressed?: boolean;
    breakdown: {
      system: number;
      tools: number;
      messages: number;
      mcp: number;
      skills: number;
      completion: number;
    };
  } | null;
  runCumulative: { tokens: number; cost: number } | null;
}

/**
 * 把某会话的消息缓冲写入历史镜像（幂等 upsert）。
 * 先写穿进程内缓存（立即可读），再经接口落服务端；接口失败静默降级返回 false。
 * @param usage 会话级用量快照（可选）；不传则仅镜像消息。
 */
export async function saveThread(
  sid: string,
  meta: { title: string; updatedAt?: number },
  rawMsgs: unknown[],
  usage?: MirroredUsage | null
): Promise<boolean> {
  if (!sid) return false;
  const msgs = sanitizeMessages(rawMsgs).slice(-MAX_MSGS);
  if (!msgs.length) return false;
  const updatedAt = typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now();
  const savedAt = Date.now();
  memThreads.set(sid, msgs);
  memIndex.set(sid, { title: meta.title, updatedAt, savedAt });
  try {
    await withTimeout(
      client.putHistoryThread(sid, {
        title: meta.title,
        updatedAt,
        msgs: msgs as unknown[],
        ...(usage ? { usage } : {})
      }),
      6000,
      '保存历史镜像'
    );
    return true;
  } catch {
    // 服务端不可达 / 校验拒绝：内存兜底已写，不阻断 UI。
    return false;
  }
}

/**
 * 读取某会话的历史镜像；接口失败 / 无数据时回退进程内缓存，仍无则返回 null
 * （由调用方降级，绝不抛错）。
 * 返回结构含消息数组与用量快照（用量可能为空，调用方按需回退）。
 */
export async function loadThread(
  sid: string
): Promise<{ msgs: MirroredMsg[]; usage: MirroredUsage | null } | null> {
  try {
    const env = await withTimeout(client.getHistoryThread(sid), 6000, '读取历史镜像');
    const msgs = sanitizeMessages(env.msgs);
    const usage = (env.usage as MirroredUsage | null) ?? null;
    if (msgs.length) {
      memThreads.set(sid, msgs);
      return { msgs, usage };
    }
    return memThreads.get(sid) ? { msgs: memThreads.get(sid)!, usage } : null;
  } catch {
    const mem = memThreads.get(sid);
    return mem ? { msgs: mem, usage: null } : null;
  }
}

/** 删除会话时同步清理镜像（进程内缓存 + 服务端存储），与 deleteChatSession 配对调用。 */
export async function purgeSessionMirror(sid: string): Promise<void> {
  memThreads.delete(sid);
  memIndex.delete(sid);
  try {
    await client.deleteHistoryThread(sid);
  } catch {
    /* 服务端不可达：内存已清，忽略远端失败 */
  }
}

/** 读取历史索引（服务端权威 + 进程内兜底合并）；失败时降级为仅内存兜底。 */
export async function loadIndex(): Promise<Record<string, MirrorMeta>> {
  const out: Record<string, MirrorMeta> = {};
  for (const [sid, m] of memIndex) out[sid] = { ...m };
  try {
    const list = await withTimeout(client.listHistoryIndex(), 6000, '读取历史索引');
    for (const it of list) {
      out[it.sid] = { title: it.title, updatedAt: it.updatedAt, savedAt: it.savedAt };
    }
  } catch {
    /* 服务端不可达：返回内存兜底索引 */
  }
  return out;
}
