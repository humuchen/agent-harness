/**
 * Team 持久化存储（评审 R5：teams 注册表此前纯内存——多实例下各副本独立、
 * 重启即丢，与 agents 注册表曾经的缺口同构）。
 *
 * 范式与 agents/store.ts 完全同构：
 * - core 不 import 任何 redis 库——注入式最小客户端契约（TeamStoreRedis），
 *   真实实现为 ioredis（原生支持这些方法），测试用 FakeRedis 注入；
 * - MemoryTeamStore 缺省（进程内），RedisTeamStore 可选（多副本共享 + 重启不丢）；
 * - createTeamStoreFromEnv 按 TEAM_STORE 环境变量选择（缺省跟随 AGENT_STORE，
 *   多副本部署零配置即正确）。
 *
 * 序列化取舍：Team 的生命周期钩子（onMemberJoin / onMemberLeave / onTaskAssign）
 * 是函数属性，不可 JSON 序列化——持久化层只保存数据字段，**经 Redis 恢复的团队
 * 不携带钩子**（钩子属注册时的运行时行为；恢复后需要钩子的调用方应重新挂载）。
 */
import type { Team } from './index';

/**
 * Redis 客户端最小契约（Hash + INCR）。与 agents 的 AgentStoreRedis 字段子集
 * 一致并多一个 incr——同一个 ioredis 实例可同时喂给 agent store / 队列 / 本 store。
 */
export interface TeamStoreRedis {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  /** 返回该 hash 全部 field→value；空 hash 返回 {}（与 ioredis 行为一致）。 */
  hgetall(key: string): Promise<Record<string, string>>;
  /** 原子自增并返回新值（round-robin 轮次计数器，多实例共享轮转次序）。 */
  incr(key: string): Promise<number>;
}

export interface TeamStore {
  readonly kind: 'memory' | 'redis';
  save(team: Team): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<Team | null>;
  list(): Promise<Team[]>;
  /**
   * 原子自增团队轮次计数器并返回新值。首个返回 1；round-robin 下标用
   * `(n - 1) % members.length`——与旧内存实现「idx 从 0 起」的轮转次序完全一致。
   */
  incrCounter(teamId: string): Promise<number>;
}

/** 内存实现（缺省；单实例 / 测试）。 */
export class MemoryTeamStore implements TeamStore {
  readonly kind = 'memory' as const;
  private teams = new Map<string, Team>();
  private counters = new Map<string, number>();
  async save(team: Team): Promise<void> {
    this.teams.set(team.id, team);
  }
  async remove(id: string): Promise<void> {
    this.teams.delete(id);
    this.counters.delete(id);
  }
  async get(id: string): Promise<Team | null> {
    return this.teams.get(id) ?? null;
  }
  async list(): Promise<Team[]> {
    return [...this.teams.values()];
  }
  async incrCounter(teamId: string): Promise<number> {
    const n = (this.counters.get(teamId) ?? 0) + 1;
    this.counters.set(teamId, n);
    return n;
  }
}

/** 持久化载体：Team 去掉函数钩子后的数据字段（JSON 可序列化）。 */
export type PersistedTeam = Omit<
  Team,
  'onMemberJoin' | 'onMemberLeave' | 'onTaskAssign'
>;

function toPersisted(team: Team): PersistedTeam {
  const {
    onMemberJoin: _j,
    onMemberLeave: _l,
    onTaskAssign: _a,
    ...rest
  } = team;
  void _j;
  void _l;
  void _a;
  return rest;
}

/**
 * Redis 实现：单 Hash（默认 `agent-harness:teams`）映射 teamId → Team(JSON)；
 * 轮次计数器用独立 String key 的 INCR（原子操作，多实例共享轮转次序——
 * 这是「计数器与团队数据同后端」的关键：放 Hash 里做 read-modify-write 会引入竞态）。
 */
export class RedisTeamStore implements TeamStore {
  readonly kind = 'redis' as const;
  private client: TeamStoreRedis;
  private hashKey: string;
  private counterKey: string;

  constructor(opts: { client: TeamStoreRedis; keyPrefix?: string }) {
    this.client = opts.client;
    this.hashKey = `${opts.keyPrefix ?? 'agent-harness'}:teams`;
    this.counterKey = `${opts.keyPrefix ?? 'agent-harness'}:teams:rr`;
  }

  async save(team: Team): Promise<void> {
    await this.client.hset(
      this.hashKey,
      team.id,
      JSON.stringify(toPersisted(team))
    );
  }
  async remove(id: string): Promise<void> {
    await this.client.hdel(this.hashKey, id);
  }
  async get(id: string): Promise<Team | null> {
    const raw = await this.client.hget(this.hashKey, id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Team;
    } catch {
      // 单条损坏不拖垮整表：视为不存在（与 store-safety 坏行语义一致）。
      return null;
    }
  }
  async list(): Promise<Team[]> {
    const all = await this.client.hgetall(this.hashKey);
    const out: Team[] = [];
    for (const raw of Object.values(all)) {
      try {
        out.push(JSON.parse(raw) as Team);
      } catch {
        /* 跳过损坏条目 */
      }
    }
    return out;
  }
  async incrCounter(teamId: string): Promise<number> {
    return this.client.incr(`${this.counterKey}:${teamId}`);
  }
}

/**
 * 按环境变量选择 TeamStore 后端（与 createAgentStoreFromEnv 同范式）。
 *
 * - `TEAM_STORE=redis` → 需调用方经 `redis` 注入 client（core 不 import ioredis）；
 *   未注入则回退内存（调用方负责告警）。
 * - `TEAM_STORE=memory` → 显式内存。
 * - 缺省 → **跟随 `AGENT_STORE`**：AGENT_STORE=redis 且注入了 client 时自动用
 *   redis（既有多副本部署零配置即正确），否则内存。
 */
export function createTeamStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  redis?: TeamStoreRedis | null
): TeamStore {
  const requested = (env.TEAM_STORE || '').toLowerCase();
  const agentStore = (env.AGENT_STORE || '').toLowerCase();
  const wantRedis =
    requested === 'redis' || (!requested && agentStore === 'redis');
  if (wantRedis && redis) return new RedisTeamStore({ client: redis });
  return new MemoryTeamStore();
}
