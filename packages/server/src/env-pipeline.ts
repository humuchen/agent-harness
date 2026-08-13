import { createEnvPlatform, type EnvPlatform } from '@agent-harness/core';
import { loadEnv } from '@agent-harness/core';

loadEnv();

export type EnvStatus =
  | 'PENDING'
  | 'PROVISIONING'
  | 'RUNNING'
  | 'READY'
  | 'DESTROYING'
  | 'DESTROYED'
  | 'FAILED';

export interface EnvStage {
  name: string;
  status: EnvStatus;
  ts: number;
}

export interface EnvState {
  envId: string;
  envType: string;
  branch: string;
  ttlHours?: number;
  region?: string;
  owner?: string;
  status: EnvStatus;
  url?: string;
  executionId?: string;
  createdAt: number;
  updatedAt: number;
  stages: EnvStage[];
}

export type EnvEventListener = (env: EnvState) => void;

/**
 * 临时环境生命周期的状态机 + 事件源。
 *
 * 将 HarnessClient 的「触发 → 轮询 → 终态」封装成可视化友好的状态序列
 * （PENDING → PROVISIONING → RUNNING → READY / FAILED），每次状态变化
 * 通过回调向外推送，供 UI 实时渲染流水线进度。
 *
 * 无 HARNESS_API_KEY 时自动 dry-run：仍会模拟完整的状态流转，
 * 并把 HarnessClient 打印的真实 API 调用作为凭证，因此无需密钥即可演示闭环。
 */
class EnvPipeline {
  private client: EnvPlatform;
  private envs: EnvState[] = [];
  private listeners = new Set<EnvEventListener>();

  constructor() {
    this.client = createEnvPlatform(); // 按 ENV_PLATFORM 选择后端（默认 harness，无 key 时 dry-run）
  }

  /** 订阅环境状态变化（用于 SSE 推送）。 */
  subscribe(fn: EnvEventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(env: EnvState): void {
    for (const fn of this.listeners) fn(env);
  }

  list(): EnvState[] {
    return this.envs;
  }

  get(envId: string): EnvState | undefined {
    return this.envs.find((e) => e.envId === envId);
  }

  /** 拉起一个临时环境，并在状态变化时推送事件。 */
  async create(
    input: { envType: string; branch: string; ttlHours?: number; region?: string; owner?: string },
    onEvent?: EnvEventListener
  ): Promise<EnvState> {
    const envId = `env-${Date.now()}`;
    const now = Date.now();
    const env: EnvState = {
      envId,
      envType: input.envType,
      branch: input.branch,
      ttlHours: input.ttlHours,
      region: input.region,
      owner: input.owner,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      stages: [{ name: '提交创建请求', status: 'PENDING', ts: now }],
    };
    this.envs.unshift(env);
    this.emit(env);
    onEvent?.(env);

    const push = (status: EnvStatus, name: string) => {
      env.status = status;
      env.updatedAt = Date.now();
      env.stages.push({ name, status, ts: Date.now() });
      this.emit(env);
      onEvent?.(env);
    };

    try {
      const handle = await this.client.createEphemeralEnvironmentWithEvents(input, (harnessStatus) => {
        // 将 Harness 原始状态映射到可视化状态机。
        if (harnessStatus === 'PROVISIONING') push('PROVISIONING', 'Harness 接收请求');
        else if (harnessStatus === 'RUNNING') push('RUNNING', 'Pipeline 执行中');
        else if (harnessStatus === 'READY' || harnessStatus === 'SUCCESS') push('READY', '环境就绪');
        else if (['FAILED', 'ABORTED', 'ERRORED'].includes(harnessStatus)) push('FAILED', '执行失败');
        else push('RUNNING', `状态: ${harnessStatus}`);
      });
      env.url = handle.envUrl;
      env.executionId = handle.executionId;
      if (handle.status === 'failed') push('FAILED', '执行失败');
      else if (env.status !== 'READY') push('READY', '环境就绪');
    } catch (e: any) {
      push('FAILED', `错误: ${e?.message ?? String(e)}`);
    }
    return env;
  }

  /** 销毁一个已存在的环境，并在状态变化时推送事件。 */
  async destroy(envId: string, onEvent?: EnvEventListener): Promise<EnvState | undefined> {
    const env = this.get(envId);
    if (!env) return undefined;
    const push = (status: EnvStatus, name: string) => {
      env.status = status;
      env.updatedAt = Date.now();
      env.stages.push({ name, status, ts: Date.now() });
      this.emit(env);
      onEvent?.(env);
    };
    try {
      const handle = await this.client.destroyEnvironmentWithEvents({ envId }, (harnessStatus) => {
        if (harnessStatus === 'DESTROYING') push('DESTROYING', 'Harness 接收销毁请求');
        else if (harnessStatus === 'DESTROYED' || harnessStatus === 'SUCCESS') push('DESTROYED', '环境已销毁');
        else if (['FAILED', 'ABORTED', 'ERRORED'].includes(harnessStatus)) push('FAILED', '销毁失败');
        else push('DESTROYING', `状态: ${harnessStatus}`);
      });
      if (handle.status === 'failed') push('FAILED', '销毁失败');
      else if (env.status !== 'DESTROYED') push('DESTROYED', '环境已销毁');
    } catch (e: any) {
      push('FAILED', `错误: ${e?.message ?? String(e)}`);
    }
    return env;
  }
}

export const envPipeline = new EnvPipeline();
