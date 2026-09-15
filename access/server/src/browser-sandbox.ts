/**
 * 浏览器沙箱会话管理器（浏览器沙箱生命周期 / P 级功能）。
 *
 * 背景：「浏览器沙箱」是 Agent 在执行网页类任务时可用的受控浏览器会话。
 * 本模块只建模「会话生命周期 + 元数据」——即创建 / 查询 / 列举 / 销毁，
 * 真无头浏览器由集成 / 运维层拉起。这里刻意保留清晰扩展点：
 *   当环境变量 `SANDBOX_DOCKER_IMAGE` 被设置时，仅追加一条
 *   `[simulated] would launch container <image>` 的模拟日志（no-op / simulated），
 *   绝不真正 spawn 容器；后续接入真实调度（k8s / docker / 沙箱网关）时，
 *   只需在该扩展点替换为实际拉起逻辑，业务层（路由 + 前端）零改动。
 *
 * 设计：与本项目一贯的「接口 + 默认实现 + 组合工厂」一致——
 * - `SandboxManager` 是契约（CRUD 会话）；
 * - 默认实现 `LocalSandboxManager` 用进程内存 `Map` 保存会话，便于单测与演示；
 * - 后续可新增 `DockerSandboxManager` / `K8sSandboxManager` 实现同一接口。
 */

import { randomUUID } from 'node:crypto';

/** 会话状态机。creating→ready（→error）/ ready→destroyed。 */
export type SandboxStatus = 'creating' | 'ready' | 'destroyed' | 'error';

/** 一个受控浏览器会话的不可变元数据。 */
export interface SandboxSession {
  id: string;
  status: SandboxStatus;
  /** 会话目标 URL（缺省为 about:blank）。 */
  targetUrl?: string;
  /** ISO-8601 创建时间。 */
  createdAt: string;
  owner: string;
  /** 生命周期日志（创建 / 销毁 / 模拟启动容器等）。 */
  logs: string[];
}

export interface CreateSessionInput {
  targetUrl?: string;
  owner: string;
}

export interface SandboxManager {
  create(input: CreateSessionInput): Promise<SandboxSession>;
  get(id: string): SandboxSession | undefined;
  list(): SandboxSession[];
  destroy(id: string): boolean;
}

/** 进程内存版实现：单实例、演示 / 单测友好，重启即丢失。 */
export class LocalSandboxManager implements SandboxManager {
  private readonly sessions = new Map<string, SandboxSession>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async create(input: CreateSessionInput): Promise<SandboxSession> {
    const id = randomUUID();
    const targetUrl = input.targetUrl;
    const session: SandboxSession = {
      id,
      status: 'ready',
      targetUrl,
      createdAt: new Date().toISOString(),
      owner: input.owner,
      logs: [`Session ${id} ready for ${targetUrl || 'about:blank'}`]
    };
    // 扩展点：此处仅模拟，不真正启动容器。
    if (this.env.SANDBOX_DOCKER_IMAGE) {
      session.logs.push(`[simulated] would launch container ${this.env.SANDBOX_DOCKER_IMAGE}`);
    }
    this.sessions.set(id, session);
    return cloneSession(session);
  }

  get(id: string): SandboxSession | undefined {
    const s = this.sessions.get(id);
    return s ? cloneSession(s) : undefined;
  }

  list(): SandboxSession[] {
    const out: SandboxSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.status !== 'destroyed') out.push(cloneSession(s));
    }
    return out;
  }

  destroy(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.status = 'destroyed';
    this.sessions.delete(id);
    return true;
  }
}

/** 防御性浅拷贝：返回会话副本（深拷贝 logs 数组），避免调用方改到内部状态。 */
function cloneSession(s: SandboxSession): SandboxSession {
  return { ...s, logs: [...s.logs] };
}

let managerSingleton: SandboxManager | null = null;

/** 组合工厂：默认返回进程内存版管理器。 */
export function getSandboxManager(env?: NodeJS.ProcessEnv): SandboxManager {
  if (!managerSingleton) {
    managerSingleton = new LocalSandboxManager(env ?? process.env);
  }
  return managerSingleton;
}

/** 供测试注入自定义管理器（传 null 复位单例）。 */
export function setSandboxManager(m: SandboxManager | null): void {
  managerSingleton = m;
}
