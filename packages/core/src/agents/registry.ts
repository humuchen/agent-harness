import type { AgentCard, AgentHealth, IndustryDomain } from './types';
import { makeDefaultAgentCard, DEFAULT_AGENT_ID } from './types';
import {
  VolatileAgentStore,
  type AgentStore,
} from './store';

/**
 * 智能体注册表（P0.1 核心）。
 *
 * 包裹 `AgentStore`，在持久层之上维护：
 * - capability → agentId 的内存倒排索引（O(1) 按能力发现，无需每次全表扫）；
 * - 启动期 / 调用期 sweep 掉心跳超时的 agent（标记为 down，供路由层降权/剔除）；
 * - seed 一个 default 通用 agent，保证「无注册表配置」时退化为今天的万能 harness。
 *
 * 全部方法可 JSON 序列化、零外部依赖，进程内运行；多实例共享需换用分布式的 AgentStore
 * （如 Redis 后端，本文件预留接口）。
 */
export class AgentRegistry {
  private store: AgentStore;
  /** capabilityId → 拥有该能力的 agentId 集合（倒排索引，加速 query）。 */
  private capIndex = new Map<string, Set<string>>();
  /** agentId → 当前缓存的 card（避免每次 get 都落盘读）。写穿式：register/heartbeat 同步更新。 */
  private cache = new Map<string, AgentCard>();

  constructor(store?: AgentStore) {
    this.store = store ?? new VolatileAgentStore();
  }

  /** 重建倒排索引（store 被外部替换 / 初始加载时调用）。 */
  private rebuildIndex(): void {
    this.capIndex.clear();
    for (const card of this.cache.values()) {
      for (const cap of card.capabilities) {
        let set = this.capIndex.get(cap.id);
        if (!set) {
          set = new Set();
          this.capIndex.set(cap.id, set);
        }
        set.add(card.id);
      }
    }
  }

  /** 注册 / 更新一个 agent（本地或远端 A2A 自注册均走此口）。 */
  async register(card: AgentCard): Promise<void> {
    await this.store.register(card);
    this.cache.set(card.id, card);
    for (const cap of card.capabilities) {
      let set = this.capIndex.get(cap.id);
      if (!set) {
        set = new Set();
        this.capIndex.set(cap.id, set);
      }
      set.add(card.id);
    }
  }

  /** 上报心跳（部分字段即可），刷新 lastHeartbeat，并把 agent 从 down 复活为给定状态。 */
  async heartbeat(id: string, health: Partial<AgentHealth>): Promise<void> {
    await this.store.heartbeat(id, health);
    const c = this.cache.get(id);
    if (c) {
      c.health = { ...c.health, ...health, lastHeartbeat: Date.now() };
    }
  }

  /** 注销一个 agent。 */
  async deregister(id: string): Promise<void> {
    await this.store.deregister(id);
    this.cache.delete(id);
    for (const set of this.capIndex.values()) set.delete(id);
  }

  /** 取出一个 agent 的卡片（含最新健康度）。 */
  async get(id: string): Promise<AgentCard | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const card = await this.store.get(id);
    if (card) this.cache.set(id, card);
    return card;
  }

  /** 列出全部已注册 agent。 */
  async list(): Promise<AgentCard[]> {
    const all = await this.store.list();
    for (const c of all) this.cache.set(c.id, c);
    return all;
  }

  /**
   * 按 domain / capability 发现 agent。
   * capability 命中倒排索引（集合求交），domain 走缓存过滤，整体 O(匹配数) 而非全表。
   */
  async query(filter: { domain?: IndustryDomain; capability?: string }): Promise<AgentCard[]> {
    let ids: Set<string> | null = null;
    if (filter.capability) {
      ids = this.capIndex.get(filter.capability) ?? new Set();
    }
    const out: AgentCard[] = [];
    const all = ids ? [...ids].map((i) => this.cache.get(i)).filter(Boolean) : await this.list();
    for (const c of all as AgentCard[]) {
      if (filter.domain && c.domain !== filter.domain) continue;
      out.push(c);
    }
    return out;
  }

  /**
   * 扫掉心跳超时的 agent：lastHeartbeat 距现在超过 `timeoutMs` 的标记为 `down`
   * （保留在注册表，便于运维查看，但路由层应降权/跳过）。
   * @returns 被标记为 down 的 agent id 列表。
   */
  async sweepStale(timeoutMs = 30_000): Promise<string[]> {
    const now = Date.now();
    const downed: string[] = [];
    for (const c of this.cache.values()) {
      if (now - c.health.lastHeartbeat > timeoutMs && c.health.status !== 'down') {
        c.health = { ...c.health, status: 'down' };
        await this.store.heartbeat(c.id, { status: 'down' }).catch(() => {});
        downed.push(c.id);
      }
    }
    return downed;
  }
}

/** 进程内共享的默认注册表单例：首次访问时自动 seed default 通用 agent。 */
let _defaultRegistry: AgentRegistry | null = null;

/**
 * 取得（或创建）共享的 AgentRegistry 单例。
 * - 首次调用自动 seed `default` 通用 agent（无 assembly → 退化为今天的万能 harness），
 *   保证现有 UI / CLI / 测试零改动可用。
 * - server 的 /api/agents 端点与各 run 都引用同一实例，self-registration 立即可见。
 */
export function getAgentRegistry(): AgentRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new AgentRegistry();
    _defaultRegistry.register(makeDefaultAgentCard()).catch(() => {});
  }
  return _defaultRegistry;
}

export { DEFAULT_AGENT_ID };
