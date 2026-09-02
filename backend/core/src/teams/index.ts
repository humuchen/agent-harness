/**
 * Agent Teams 多 Agent 团队（P1-④）。
 *
 * 缺口：现有 `AgentRegistry` + `AgentSelector` + `DagEngine` + `WorkflowExecutor`
 * 实现**静态 DAG 编排** —— 每个 step 固定分配一个 agent。
 * 但缺少**动态团队**：无法在运行时定义「Team A 包含 3 个分析 agent + 1 个写作者 agent」，
 * 也不支持「团队成员轮流 work」。
 *
 * 该模块补齐该缺口：`Team` 实体定义团队成员 + 协作模式；`TeamManager` 提供 CRUD +
 * 协作调度；通过 `AgentRegistry.executeTeamTask()` 接入 workflow engine。
 *
 * 约定（遵循 project conventions）：
 * - `backend/core/src/teams/index.ts` 统一导出，mirrors `agents/index.ts` 结构。
 * - `Team` 实体遵循 `AgentCard` 模式（可 JSON 序列化，零外部依赖）。
 * - `TeamManager` 操作委托给 `AgentRegistry`（成员查询 / dispatch），避免重复 state。
 */

import type { AgentCard, AgentRegistry, IndustryDomain } from '../agents';

/** 团队协作模式。 */
export type TeamMode =
  | 'sequential'
  | 'parallel'
  | 'round-robin'
  | 'competitive';

/**
 * Agent Team 实体。
 * - members: agent id 列表（引用 AgentRegistry）。
 * - mode: 协作模式。
 * - leader: 团队领导 agent id（用于 round-robin 起始 / vote 决策）。
 */
export interface Team {
  id: string;
  name: string;
  /** 团队成员 agent id 列表。 */
  members: string[];
  /** 协作模式。 */
  mode: TeamMode;
  /** 团队领导 agent id（可选）。 */
  leader?: string;
  /** 团队关联的行业领域。 */
  domain?: IndustryDomain;
  /** 团队描述。 */
  description?: string;
  /** 竞赛模式下各成员权重（用于 vote）。 */
  weights?: Record<string, number>;
  /** 生命周期钩子。 */
  onMemberJoin?(agentId: string): void;
  onMemberLeave?(agentId: string): void;
  onTaskAssign?(agentId: string, task: string): void;
}

/**
 * TeamManager：管理 Team 的 CRUD + 协作调度。
 *
 * 持久化：使用内存态 Map 作为默认后端（进程内），生产可替换为分布式 store。
 * 团队成员查询 / agent dispatch 委托给传入的 AgentRegistry。
 */
export class TeamManager {
  private teams = new Map<string, Team>();
  private registry: AgentRegistry;

  constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  /** 注册 / 更新一个团队。 */
  async register(team: Team): Promise<void> {
    // 校验成员存在
    for (const mid of team.members) {
      const card = await this.registry.get(mid);
      if (!card) {
        throw new Error(`TeamMemberNotFound: agent ${mid} not registered`);
      }
    }
    // 触发 onMemberJoin 回调
    for (const mid of team.members) {
      team.onMemberJoin?.(mid);
    }
    this.teams.set(team.id, team);
  }

  /** 注销一个团队。 */
  async deregister(id: string): Promise<void> {
    const team = this.teams.get(id);
    if (!team) return;
    for (const mid of team.members) {
      team.onMemberLeave?.(mid);
    }
    this.teams.delete(id);
  }

  /** 获取团队。 */
  get(id: string): Team | undefined {
    return this.teams.get(id);
  }

  /** 列出全部团队。 */
  list(): Team[] {
    return [...this.teams.values()];
  }

  /**
   * 按团队协作模式分发任务。
   * 返回各成员的执行结果（格式因 mode 而异）：
   * - sequential/round-robin: 单字符串（最后完成者的结果）
   * - parallel: 字符串数组
   * - competitive: 获胜 agent 的结果字符串
   */
  async executeTask(
    teamId: string,
    input: string,
    dispatchAgentTask: (
      card: AgentCard,
      input: string
    ) => Promise<string>
  ): Promise<string | string[]> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`TeamNotFound: ${teamId}`);

    // 获取成员 AgentCard
    const members: AgentCard[] = [];
    for (const mid of team.members) {
      const card = await this.registry.get(mid);
      if (card) members.push(card);
    }
    if (members.length === 0) {
      throw new Error(`Team ${teamId} has no active members`);
    }

    switch (team.mode) {
      case 'round-robin': {
        const idx = this.teamRoundRobin.get(teamId) ?? 0;
        const member = members[idx % members.length]!;
        this.teamRoundRobin.set(teamId, idx + 1);
        team.onTaskAssign?.(member.id, input);
        return dispatchAgentTask(member, input);
      }

      case 'sequential': {
        // 顺序执行：每个成员收到前一个成员的结果
        let result = input;
        for (const m of members) {
          team.onTaskAssign?.(m.id, result);
          result = await dispatchAgentTask(m, result);
        }
        return result;
      }

      case 'parallel': {
        // 所有成员并行
        return Promise.all(
          members.map((m) => {
            team.onTaskAssign?.(m.id, input);
            return dispatchAgentTask(m, input);
          })
        );
      }

      case 'competitive': {
        // 所有成员执行，按权重 vote
        const votes = await Promise.all(
          members.map(async (m, i) => {
            const score = team.weights?.[m.id] ?? 1;
            const result = await dispatchAgentTask(m, input);
            // 简单打分：按结果长度 × 权重
            const effectiveness = result.length * score;
            return { result, score: effectiveness };
          })
        );
        const winner = votes.reduce((best, v) =>
          v.score > best.score ? v : best
        );
        return winner.result;
      }

      default: {
        if (!members[0]) throw new Error(`Team ${teamId} has no active members`);
        return dispatchAgentTask(members[0], input);
      }
    }
  }

  /** 轮次计数器：teamId → 下一次执行的成员 index。 */
  private teamRoundRobin = new Map<string, number>();
}

/**
 * 全局 TeamManager 单例（进程内）。
 * 依赖 AgentRegistry 单例 —— server 层在启动时通过 `initTeamManager()` 初始化。
 */
let _defaultManager: TeamManager | null = null;

/** 取得共享 TeamManager 单例。 */
export function getTeamManager(): TeamManager | null {
  return _defaultManager;
}

/** 初始化共享 TeamManager（幂等）。 */
export async function initTeamManager(registry: AgentRegistry): Promise<TeamManager> {
  if (!_defaultManager) {
    _defaultManager = new TeamManager(registry);
  }
  return _defaultManager;
}

/** 仅供测试：重置单例。 */
export function _resetTeamManager(): void {
  _defaultManager = null;
}
