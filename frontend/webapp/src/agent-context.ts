/**
 * agent-context：跨组件响应式共享状态容器（Lit 版「useAgentContext」）。
 *
 * SVG 架构图中「前端应用层 · useAgentContext 状态共享」在本项目（前端是 Lit 而非 React）
 * 的真实落地形态：一个进程级单例 `AgentContextStore`（EventTarget 驱动，零依赖）+
 * 面向 Lit 的 `AgentContextController`（ReactiveController）绑定。
 *
 * 用法：
 *   import { agentContext, useAgentContext } from './agent-context';
 *   // 在 Lit 组件构造函数中：
 *   this.ctx = useAgentContext(this);            // 订阅全部字段，变更自动 requestUpdate
 *   this.ctx = useAgentContext(this, ['running']); // 或只订阅感兴趣的字段
 *   // 任意组件读写共享状态：
 *   agentContext.set('running', true);
 *   const s = agentContext.getState();
 *
 * 特性：localStorage 持久化（隐私模式等不可用时自动降级为纯内存）、
 * 键白名单校验、订阅解绑、错误兜底——不引入任何外部依赖。
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';

/** 共享状态允许的键。新增状态先在此登记，未登记的键 set 会抛错（防拼写错误）。 */
export type AgentContextKey =
  | 'sessionId'
  | 'conversationId'
  | 'running'
  | 'theme'
  | 'token'
  | 'lastPrompt'
  | 'files';

/** 共享状态值类型。 */
export interface AgentContextState {
  /** 多租户隔离 / 显式会话 key。 */
  sessionId: string;
  /** 连续追问复用同一 Memory 窗口的会话 key。 */
  conversationId: string;
  /** 是否有 agent 正在运行。 */
  running: boolean;
  /** UI 主题：'light' | 'dark' | ''（未设置）。 */
  theme: string;
  /** 鉴权令牌（可选）。 */
  token: string;
  /** 上一次提交给 agent 的提示词。 */
  lastPrompt: string;
  /** 用户通过文件上传组件挂载的附件（dataUrl 形式，可序列化持久化）。 */
  files: UploadedFile[];
}

export interface UploadedFile {
  name: string;
  size: number;
  type: string;
  dataUrl: string;
}

const STORAGE_KEY = 'ah:agent-context';

const DEFAULTS: AgentContextState = {
  sessionId: '',
  conversationId: '',
  running: false,
  theme: '',
  token: '',
  lastPrompt: '',
  files: [],
};

/** 允许的键集合（白名单校验用）。 */
const KEYS = new Set<AgentContextKey>([
  'sessionId',
  'conversationId',
  'running',
  'theme',
  'token',
  'lastPrompt',
  'files',
]);

/** 键 → 值类型校验器。运行期早失败，避免脏数据扩散到各面板。 */
const VALIDATORS: Record<AgentContextKey, (v: unknown) => boolean> = {
  sessionId: (v) => typeof v === 'string',
  conversationId: (v) => typeof v === 'string',
  running: (v) => typeof v === 'boolean',
  theme: (v) => typeof v === 'string',
  token: (v) => typeof v === 'string',
  lastPrompt: (v) => typeof v === 'string',
  files: (v) => Array.isArray(v),
};

function safeLoad(): Partial<AgentContextState> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<AgentContextState>;
    // 逐键校验，非法键/类型直接丢弃，防止旧版本脏数据毒化状态。
    const out: Partial<AgentContextState> = {};
    for (const k of KEYS) {
      const v = parsed[k];
      if (v !== undefined && VALIDATORS[k](v)) {
        (out as Record<AgentContextKey, unknown>)[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

class AgentContextStore {
  private state: AgentContextState = { ...DEFAULTS, ...safeLoad() };
  private listeners = new Set<(s: AgentContextState) => void>();

  /** 读取当前状态的快照（每次返回新对象，避免外部直接篡改内部引用）。 */
  getState(): AgentContextState {
    return { ...this.state };
  }

  /**
   * 更新某个共享字段。白名单外键、类型不符会立即抛错（开发期快速暴露）。
   * 变更后同步持久化（localStorage 不可用时静默降级）并通知所有订阅者。
   */
  set<K extends AgentContextKey>(key: K, value: AgentContextState[K]): void {
    if (!KEYS.has(key)) {
      throw new Error(`agentContext: 未知状态键 "${String(key)}"`);
    }
    if (!VALIDATORS[key](value)) {
      throw new Error(`agentContext: 键 "${key}" 的值类型不合法`);
    }
    if (this.state[key] === value) return; // 值未变化不触发通知
    this.state = { ...this.state, [key]: value };
    this.persist();
    for (const fn of this.listeners) {
      try {
        fn(this.getState());
      } catch {
        /* 订阅者异常不影响其它订阅者 */
      }
    }
  }

  /** 订阅状态变更；返回解绑函数。 */
  subscribe(fn: (s: AgentContextState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 一次性批量更新多个字段（原子化，仅触发一次通知）。 */
  patch(partial: Partial<AgentContextState>): void {
    let changed = false;
    const next = { ...this.state };
    for (const k of KEYS) {
      const key = k as AgentContextKey;
      const v = (partial as Record<AgentContextKey, unknown>)[key];
      if (v === undefined) continue;
      if (!VALIDATORS[key](v)) {
        throw new Error(`agentContext: 键 "${key}" 的值类型不合法`);
      }
      if (next[key] !== v) {
        (next as Record<AgentContextKey, unknown>)[key] = v;
        changed = true;
      }
    }
    if (!changed) return;
    this.state = next;
    this.persist();
    for (const fn of this.listeners) {
      try {
        fn(this.getState());
      } catch {
        /* 忽略订阅者异常 */
      }
    }
  }

  /** 恢复默认状态并清除持久化。 */
  reset(): void {
    this.state = { ...DEFAULTS };
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
    for (const fn of this.listeners) {
      try {
        fn(this.getState());
      } catch {
        /* 忽略 */
      }
    }
  }

  private persist(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      }
    } catch {
      /* 隐私模式 / 配额满：静默降级为纯内存 */
    }
  }
}

/** 进程级单例：所有 ah-* 组件共享同一份状态。 */
export const agentContext = new AgentContextStore();

/**
 * 把 Lit 组件宿主绑定到共享状态：状态变更时自动触发宿主重新渲染。
 * 可用 `keys` 收窄订阅范围（默认全部）。返回 controller，需在组件构造函数里持有。
 */
export class AgentContextController implements ReactiveController {
  private host: ReactiveControllerHost;
  private keys: ReadonlySet<AgentContextKey> | null;
  private unsubscribe: (() => void) | null = null;

  constructor(host: ReactiveControllerHost, keys?: AgentContextKey[]) {
    this.host = host;
    this.keys = keys && keys.length ? new Set(keys) : null;
  }

  hostConnected(): void {
    this.unsubscribe = agentContext.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * 便捷工厂：等价于在组件构造函数里 `new AgentContextController(this, keys)`。
 * 命名对齐 SVG 架构图里的 useAgentContext，语义即「让组件响应式订阅共享上下文」。
 */
export function useAgentContext(
  host: ReactiveControllerHost,
  keys?: AgentContextKey[]
): AgentContextController {
  return new AgentContextController(host, keys);
}
