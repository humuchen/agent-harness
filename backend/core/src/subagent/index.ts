/**
 * SubAgent 子任务分发（P1-③）。
 *
 * 缺口：现有 A2A 协议(`a2a/*`) 实现 agent-to-agent 委托（跨主机 HTTP / 进程内 Local），
 * 但缺少在**当前 agent 运行循环内部**派生一个**带独立记忆窗口**的子 agent。
 *
 * 该模块补齐该缺口：提供 `SubAgentManager` 在 core 层管理子 agent 生命周期
 * （创建 / 跟踪 / 清理），并在 server 层注册 `delegate_task` 工具
 * （见 `access/server/src/subagent-tools.ts`）暴露给 LLM。
 *
 * 约定（遵循 project conventions）：
 * - 文件遵循 `backend/core/src/<module>/index.ts` + 单一职责拆分模式（如 `skills/index.ts`）。
 * - core 层不依赖 server 层：`SubAgentManager` 仅管理实例状态，实际的 harness 创建
 *   由 server 层的 `assembleAgent` 完成。
 * - sub agent 使用独立的 sessionKey（`{parent}:sub:{uuid8}`），复用进程内记忆缓存。
 */

import { randomUUID } from 'node:crypto';

/** 子 agent 的状态。 */
export type SubAgentStatus = 'idle' | 'running' | 'completed' | 'error';

/**
 * SubAgent 实例句柄。
 * - `sessionKey`：独立的记忆窗口 key。
 * - `status`：运行状态。
 */
export interface SubAgentInstance {
  id: string;
  sessionKey: string;
  parentSessionKey: string;
  status: SubAgentStatus;
  /** 子 agent 的最终输出（运行完成后可用）。 */
  final?: string;
  /** 错误信息（status='error' 时）。 */
  error?: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
}

/**
 * SubAgent 管理器：创建 / 跟踪 / 清理子 agent 实例。
 *
 * 该类仅管理实例生命周期（内存态），不直接创建 AgentHarness。
 * 子 agent 的 harness 创建由 server 层的 `delegate_task` 工具完成
 *（见 `access/server/src/subagent-tools.ts`）。
 */
export class SubAgentManager {
  /** id → 子 agent 实例。 */
  private instances = new Map<string, SubAgentInstance>();
  private maxConcurrent: number;

  constructor(opts?: { maxConcurrent?: number }) {
    this.maxConcurrent = opts?.maxConcurrent ?? 4;
  }

  /** 当前活跃（running）子 agent 数量。 */
  getActiveCount(parentSessionKey: string): number {
    let count = 0;
    for (const inst of this.instances.values()) {
      if (
        inst.parentSessionKey === parentSessionKey &&
        inst.status === 'running'
      ) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 创建子 agent 实例记录。
   * - 使用独立 sessionKey（parent:sub:uuid8）。
   * - server 层的 delegate_task 工具调用此方法记录实例，然后调用 assembleAgent + harness.run。
   */
  create(parentSessionKey: string): SubAgentInstance {
    const active = this.getActiveCount(parentSessionKey);
    if (active >= this.maxConcurrent) {
      throw new Error(
        `SubAgent 并发数已达上限（${this.maxConcurrent}）。请等待已有子 agent 完成或清理。`
      );
    }

    const id = randomUUID().slice(0, 8);
    const sessionKey = `${parentSessionKey}:sub:${id}`;
    const inst: SubAgentInstance = {
      id,
      sessionKey,
      parentSessionKey,
      status: 'idle',
      createdAt: Date.now(),
    };
    this.instances.set(id, inst);
    return inst;
  }

  /** 标记子 agent 状态为 running。 */
  markRunning(id: string): void {
    const inst = this.instances.get(id);
    if (inst) inst.status = 'running';
  }

  /** 标记子 agent 完成。 */
  complete(id: string, final: string): void {
    const inst = this.instances.get(id);
    if (inst) {
      inst.status = 'completed';
      inst.final = final;
      inst.error = undefined;
    }
  }

  /** 标记子 agent 错误。 */
  fail(id: string, error: string): void {
    const inst = this.instances.get(id);
    if (inst) {
      inst.status = 'error';
      inst.final = undefined;
      inst.error = error;
    }
  }

  /** 获取子 agent 实例。 */
  get(id: string): SubAgentInstance | undefined {
    return this.instances.get(id);
  }

  /** 列出当前 parent session 的子 agent。 */
  list(parentSessionKey: string): SubAgentInstance[] {
    return [...this.instances.values()].filter(
      (i) => i.parentSessionKey === parentSessionKey
    );
  }

  /** 清理已完成 / 错误的子 agent 实例。 */
  cleanup(id: string): void {
    const inst = this.instances.get(id);
    if (inst && (inst.status === 'completed' || inst.status === 'error')) {
      this.instances.delete(id);
    }
  }

  /** 清理某 parent session 的所有子 agent。 */
  cleanupAll(parentSessionKey: string): void {
    for (const [id, inst] of this.instances) {
      if (inst.parentSessionKey === parentSessionKey) {
        this.instances.delete(id);
      }
    }
  }

  /** 重置全部（仅供测试）。 */
  reset(): void {
    this.instances.clear();
  }
}

/**
 * 进程单例 SubAgentManager。
 * 由 server 层在 `initSubAgentManager` 中初始化。
 */
let _defaultManager: SubAgentManager | null = null;

/** 取得共享 SubAgentManager 单例（需先通过 initSubAgentManager 初始化）。 */
export function getSubAgentManager(): SubAgentManager | null {
  return _defaultManager;
}

/** 初始化共享 SubAgentManager（幂等）。 */
export function initSubAgentManager(opts?: {
  maxConcurrent?: number;
}): SubAgentManager {
  if (!_defaultManager) {
    _defaultManager = new SubAgentManager(opts);
  }
  return _defaultManager;
}

/** 仅供测试：重置单例。 */
export function _resetSubAgentManager(): void {
  _defaultManager = null;
}
