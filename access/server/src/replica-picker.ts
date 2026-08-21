/**
 * replica-picker：接入层多副本负载均衡选择器（Access Layer Load Balancing）。
 *
 * SVG 架构图中「接入层 · 负载均衡」的纯逻辑落地：在有多个后端副本（replica）时，
 * 决定「本次请求转发给哪个副本」。零依赖、可单测、可被任意路由/代理层复用。
 *
 * 三种策略：
 *  - round-robin  ：轮询，天然均匀；配合健康过滤。
 *  - least-load   ：选当前负载（并发数/队列长度等，越小越优）最低的健康副本。
 *  - sticky-hash  ：按会话/租户 key 哈希到固定副本（保证同一会话打到同一后端），
 *                   副本增减时尽量保持稳定（一致性哈希的简化实现）。
 *
 * 约定：`healthy === false` 的副本一律跳过；没有任何健康副本时返回 null，
 * 由调用方决定降级（如返回 503 或回退默认副本）。
 */
export type PickStrategy = 'round-robin' | 'least-load' | 'sticky-hash';

export interface Replica {
  /** 副本唯一 ID（如 "replica-1" / "ap-southeast-1:4173"）。 */
  id: string;
  /** 副本基地址（http(s)://host:port）。 */
  baseUrl: string;
  /** 健康状态；false 的副本永不参与选择。默认 true。 */
  healthy?: boolean;
  /** 当前负载指标（并发请求数等），越小越优先；仅 least-load 使用。默认 0。 */
  load?: number;
  /** 权重，仅 round-robin 的加权轮询使用。默认 1，须为正整数。 */
  weight?: number;
}

export interface ReplicaPickerOptions {
  /** 初始副本列表。 */
  replicas?: Replica[];
  /** 选择策略。默认 'round-robin'。 */
  strategy?: PickStrategy;
}

const STRATEGIES: PickStrategy[] = ['round-robin', 'least-load', 'sticky-hash'];

/** 简易字符串哈希（FNV-1a 32 位），零依赖。 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 一致性哈希每个副本的虚拟节点数（越多越均匀，代价是内存/排序开销）。 */
const VIRTUAL_NODES = 64;

/** 加权轮询的「当前指针」，按副本 id 索引。 */
export class ReplicaPicker {
  private replicas: Replica[] = [];
  private strategy: PickStrategy;
  private rrIndex = 0;

  constructor(options: ReplicaPickerOptions = {}) {
    this.strategy = options.strategy ?? 'round-robin';
    if (!STRATEGIES.includes(this.strategy)) {
      throw new Error(`replica-picker: 未知策略 "${this.strategy}"（可选 ${STRATEGIES.join('/')}）`);
    }
    if (options.replicas) this.setReplicas(options.replicas);
  }

  /** 全量替换副本列表；校验 id 唯一、baseUrl 合法、weight 为正整数，否则抛错。 */
  setReplicas(replicas: Replica[]): void {
    if (!Array.isArray(replicas)) {
      throw new Error('replica-picker: replicas 必须是数组');
    }
    const seen = new Set<string>();
    for (const r of replicas) {
      if (!r || typeof r !== 'object') {
        throw new Error('replica-picker: 副本项必须是对象');
      }
      const id = typeof r.id === 'string' ? r.id.trim() : '';
      if (!id) throw new Error('replica-picker: 副本缺少 id');
      if (seen.has(id)) throw new Error(`replica-picker: 副本 id 重复 "${id}"`);
      seen.add(id);
      const url = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
      if (!/^https?:\/\/.+/i.test(url)) {
        throw new Error(`replica-picker: 副本 "${id}" 的 baseUrl 非法（须以 http(s):// 开头）`);
      }
      const weight = r.weight ?? 1;
      if (!Number.isInteger(weight) || weight <= 0) {
        throw new Error(`replica-picker: 副本 "${id}" 的 weight 必须是正整数`);
      }
    }
    this.replicas = [...replicas];
    this.rrIndex = 0; // 重置轮询指针，避免换列表后从旧位置继续
  }

  /** 追加/替换单个副本（同 id 覆盖）。 */
  upsert(replica: Replica): void {
    const idx = this.replicas.findIndex((r) => r.id === replica.id);
    const next = idx >= 0 ? [...this.replicas] : [...this.replicas, replica];
    if (idx >= 0) next[idx] = replica;
    this.setReplicas(next);
  }

  /** 按当前策略选出一个健康副本；无健康副本返回 null。 */
  pick(key?: string): Replica | null {
    const healthy = this.replicas.filter((r) => r.healthy !== false);
    if (healthy.length === 0) return null;
    if (healthy.length === 1) return healthy[0];
    switch (this.strategy) {
      case 'least-load':
        return this.pickLeastLoad(healthy);
      case 'sticky-hash':
        return this.pickSticky(healthy, key);
      case 'round-robin':
      default:
        return this.pickRoundRobin(healthy);
    }
  }

  /** 健康副本数量。 */
  healthyCount(): number {
    return this.replicas.filter((r) => r.healthy !== false).length;
  }

  /** 副本总数。 */
  size(): number {
    return this.replicas.length;
  }

  /** 当前快照（供可观测 / 调试）。 */
  snapshot(): { strategy: PickStrategy; replicas: Replica[] } {
    return { strategy: this.strategy, replicas: this.replicas.map((r) => ({ ...r })) };
  }

  /** 加权轮询：按 weight 展平为多槽位后取模；单槽副本不占权重。 */
  private pickRoundRobin(healthy: Replica[]): Replica {
    const slots: Replica[] = [];
    for (const r of healthy) {
      const w = r.weight ?? 1;
      for (let i = 0; i < w; i++) slots.push(r);
    }
    const idx = this.rrIndex % slots.length;
    this.rrIndex = (this.rrIndex + 1) % slots.length;
    return slots[idx];
  }

  /** 最少负载：选 load 最小的；并列时按稳定顺序（id 排序）取首个，避免抖动。 */
  private pickLeastLoad(healthy: Replica[]): Replica {
    let best: Replica = healthy[0];
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const r of healthy) {
      const load = typeof r.load === 'number' && Number.isFinite(r.load) ? r.load : 0;
      if (load < bestLoad) {
        best = r;
        bestLoad = load;
      } else if (load === bestLoad && r.id < best.id) {
        best = r;
      }
    }
    return best;
  }

/**
 * 一致性哈希：每个副本生成 VIRTUAL_NODES 个虚拟节点摊平哈希环，
 * 避免「短 id 哈希偏低、长 key 哈希偏高」导致 key 全部落到环首的聚簇问题。
 * key 缺失时退化为轮询。
 */
private pickSticky(healthy: Replica[], key?: string): Replica {
  if (!key || !key.trim()) return this.pickRoundRobin(healthy);
  const ring: Array<{ id: string; h: number }> = [];
  for (const r of healthy) {
    for (let v = 0; v < VIRTUAL_NODES; v++) {
      ring.push({ id: r.id, h: fnv1a(`${r.id}#${v}`) });
    }
  }
  ring.sort((a, b) => a.h - b.h);
  const h = fnv1a(key.trim());
  // 顺时针找第一个哈希 >= h 的虚拟节点，否则绕回环首。
  for (const entry of ring) {
    if (entry.h >= h) {
      const hit = healthy.find((r) => r.id === entry.id);
      if (hit) return hit;
    }
  }
  return healthy[0];
}
}
