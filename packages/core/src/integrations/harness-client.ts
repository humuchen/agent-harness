import type { EphemeralEnvInput, EnvHandle } from './harness-client.types';
import type { EnvPlatform } from './env-platform';

export interface HarnessClientConfig {
  apiKey?: string;
  accountId?: string;
  orgId?: string;
  projectId?: string;
  apiBase?: string; // 默认 https://app.harness.io
  provisionPipelineId?: string; // 默认 'provision-environment'
  destroyPipelineId?: string; // 默认 'destroy-ephemeral'
  // 生成环境访问地址的模板。支持 {envId} 占位符，可扩展 {region}/{owner} 等。
  // 默认 'https://{envId}.preview.internal'。真实接入时改为你的入口域名模板，
  // 例如 'https://{envId}.env.my-company.com'。
  envUrlTemplate?: string;
  // 干跑模式模拟调用（不发起真实 HTTP），无需 Harness 账户即可演示闭环。
  // 未提供 apiKey 时自动启用。
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  // --- 状态轮询（请根据你的真实 Harness 实例调整） ---
  pollIntervalMs?: number;
  maxPolls?: number;
  // 指向执行状态 JSON 中状态字符串所在位置的点路径。
  // Harness NG v2 通常为："pipelineExecution.summary.status"。
  // 部分自托管/旧实例使用 "status" 或 "pipelineExecution.status"。
  statusPath?: string;
  // 表示"已完成"和"成功"的状态值。若你的实例使用不同的枚举大小写，请调整。
  doneStatuses?: string[];
  successStatuses?: string[];
  // 为 true 时打印原始触发/轮询响应，方便你粘贴回来后微调字段映射。默认关闭。
  debug?: boolean;
}

/**
 * 围绕 Harness NG Pipeline API 的轻量级客户端。
 *
 * 将 Agent 的"我需要环境"/"销毁环境"意图映射到我们在
 * `harness-env-platform/` 中定义的 `provision-environment` 与 `destroy-ephemeral`
 * Pipeline（Pipeline 标识符可配置）。
 *
 * 在 dryRun 模式下（未设置 HARNESS_API_KEY 时默认启用），它会打印将要发起的
 * 精确 API 调用并返回一个假句柄 —— 因此闭环可以在零凭证的情况下端到端运行。
 *
 * 指向真实 Harness 实例时，它的行为如下：
 *   1. 触发 Pipeline 并捕获真实的 `executionId`
 *   2. 轮询执行状态端点直到进入终态
 *   3. 返回 `status` 反映成功/失败的 EnvHandle
 *
 * 字段映射可通过 `statusPath` / `doneStatuses` 配置，以适配你的 Harness
 * 实际返回结构（详见 `debug`）。
 */
export class HarnessClient implements EnvPlatform {
  readonly kind = 'harness' as const;
  private apiKey?: string;
  private accountId?: string;
  private orgId?: string;
  private projectId?: string;
  private apiBase: string;
  private provisionPipelineId: string;
  private destroyPipelineId: string;
  private envUrlTemplate: string;
  readonly dryRun: boolean;
  private fetchImpl: typeof fetch;
  private pollIntervalMs: number;
  private maxPolls: number;
  private statusPath: string;
  private doneStatuses: string[];
  private successStatuses: string[];
  private debug: boolean;

  constructor(config: HarnessClientConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.HARNESS_API_KEY;
    this.accountId = config.accountId ?? process.env.HARNESS_ACCOUNT_ID;
    this.orgId = config.orgId ?? process.env.HARNESS_ORG_ID;
    this.projectId = config.projectId ?? process.env.HARNESS_PROJECT_ID;
    this.apiBase =
      config.apiBase ?? process.env.HARNESS_API_BASE ?? 'https://app.harness.io';
    this.provisionPipelineId =
      config.provisionPipelineId ??
      process.env.HARNESS_PROVISION_PIPELINE_ID ??
      'provision-environment';
    this.destroyPipelineId =
      config.destroyPipelineId ??
      process.env.HARNESS_DESTROY_PIPELINE_ID ??
      'destroy-ephemeral';
    this.envUrlTemplate =
      config.envUrlTemplate ??
      process.env.HARNESS_ENV_URL_TEMPLATE ??
      'https://{envId}.preview.internal';
    this.dryRun = config.dryRun ?? !this.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.maxPolls = config.maxPolls ?? 60;
    this.statusPath = config.statusPath ?? 'pipelineExecution.summary.status';
    this.doneStatuses = config.doneStatuses ?? [
      'SUCCESS',
      'FAILED',
      'ABORTED',
      'ERRORED',
    ];
    this.successStatuses = config.successStatuses ?? ['SUCCESS'];
    this.debug = config.debug ?? process.env.HARNESS_DEBUG === '1';
  }

  async createEphemeralEnvironment(input: EphemeralEnvInput): Promise<EnvHandle> {
    const envId = input.envId ?? `env-${Date.now()}`;
    const vars: Record<string, string | number> = {
      env_type: input.envType,
      branch: input.branch,
      ttl_hours: input.ttlHours ?? 8,
    };
    if (input.region) vars.region = input.region;
    if (input.owner) vars.owner = input.owner;

    const yaml = buildRuntimeYaml(this.provisionPipelineId, vars);

    if (this.dryRun) {
      console.log(
        `[harness:dry-run] POST ${this.apiBase}/pipeline/api/pipelines/v2/execute/${this.provisionPipelineId}\n` +
          `  body.runtimeInputYaml =\n${indent(yaml)}`
      );
      return {
        envId,
        envUrl: this.renderEnvUrl(envId),
        status: 'ready',
        executionId: 'dryrun',
      };
    }

    const executionId = await this.triggerPipeline(this.provisionPipelineId, yaml);
    const status = await this.pollUntilDone(executionId);
    return {
      envId,
      envUrl: this.renderEnvUrl(envId),
      status: this.successStatuses.includes(status) ? 'ready' : 'failed',
      executionId,
    };
  }

  async destroyEnvironment(input: { envId: string }): Promise<EnvHandle> {
    const vars: Record<string, string | number> = { env_id: input.envId };
    const yaml = buildRuntimeYaml(this.destroyPipelineId, vars);

    if (this.dryRun) {
      console.log(
        `[harness:dry-run] POST ${this.apiBase}/pipeline/api/pipelines/v2/execute/${this.destroyPipelineId}\n` +
          `  body.runtimeInputYaml =\n${indent(yaml)}`
      );
      return { envId: input.envId, envUrl: '', status: 'destroyed', executionId: 'dryrun' };
    }

    const executionId = await this.triggerPipeline(this.destroyPipelineId, yaml);
    const status = await this.pollUntilDone(executionId);
    return {
      envId: input.envId,
      envUrl: '',
      status: this.successStatuses.includes(status) ? 'destroyed' : 'failed',
      executionId,
    };
  }

  /** 根据模板渲染环境访问地址（替换 {envId} 等占位符）。 */
  private renderEnvUrl(envId: string): string {
    return this.envUrlTemplate.replace(/\{envId\}/g, envId);
  }

  /** 获取某次执行的当前状态字符串（便于调试）。 */
  async getStatus(executionId: string): Promise<string | undefined> {
    const data = await this.fetchExecution(executionId);
    return deepGet(data, this.statusPath) as string | undefined;
  }

  /**
   * 触发 Pipeline 并流式返回执行状态。
   * `onStage` 在每次轮询得到新状态时回调（例如 'RUNNING' / 'SUCCESS' / 'FAILED'），
   * 供可视化环境流水线使用。dry-run 模式下模拟 PENDING→RUNNING→READY 过程。
   */
  async createEphemeralEnvironmentWithEvents(
    input: EphemeralEnvInput,
    onStage: (status: string) => void
  ): Promise<EnvHandle> {
    const envId = input.envId ?? `env-${Date.now()}`;
    const vars: Record<string, string | number> = {
      env_type: input.envType,
      branch: input.branch,
      ttl_hours: input.ttlHours ?? 8,
    };
    if (input.region) vars.region = input.region;
    if (input.owner) vars.owner = input.owner;
    const yaml = buildRuntimeYaml(this.provisionPipelineId, vars);

    if (this.dryRun) {
      onStage('PROVISIONING');
      await sleep(700);
      onStage('RUNNING');
      await sleep(900);
      onStage('READY');
      return {
        envId,
        envUrl: this.renderEnvUrl(envId),
        status: 'ready',
        executionId: 'dryrun',
      };
    }

    const executionId = await this.trigger(this.provisionPipelineId, yaml);
    onStage('RUNNING');
    const status = await this.pollUntilDone(executionId, onStage);
    return {
      envId,
      envUrl: this.renderEnvUrl(envId),
      status: this.successStatuses.includes(status) ? 'ready' : 'failed',
      executionId,
    };
  }

  /** 与上面对称：销毁 Pipeline 的流式版本。 */
  async destroyEnvironmentWithEvents(
    input: { envId: string },
    onStage: (status: string) => void
  ): Promise<EnvHandle> {
    const vars: Record<string, string | number> = { env_id: input.envId };
    const yaml = buildRuntimeYaml(this.destroyPipelineId, vars);

    if (this.dryRun) {
      onStage('DESTROYING');
      await sleep(800);
      onStage('DESTROYED');
      return { envId: input.envId, envUrl: '', status: 'destroyed', executionId: 'dryrun' };
    }

    const executionId = await this.trigger(this.destroyPipelineId, yaml);
    onStage('DESTROYING');
    const status = await this.pollUntilDone(executionId, onStage);
    return {
      envId: input.envId,
      envUrl: '',
      status: this.successStatuses.includes(status) ? 'destroyed' : 'failed',
      executionId,
    };
  }

  // --- 内部 HTTP 辅助方法 ------------------------------------------------

  /** 触发 Pipeline，返回真实 executionId。 */
  async trigger(pipelineId: string, runtimeYaml: string): Promise<string> {
    return this.triggerPipeline(pipelineId, runtimeYaml);
  }

  private async triggerPipeline(pipelineId: string, runtimeYaml: string): Promise<string> {
    const url = `${this.apiBase}/pipeline/api/pipelines/v2/execute/${pipelineId}`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey ?? '',
        'Harness-Account': this.accountId ?? '',
      },
      body: JSON.stringify({
        orgIdentifier: this.orgId,
        projectIdentifier: this.projectId,
        executionInput: { runtimeInputYaml: runtimeYaml },
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Harness trigger failed ${resp.status}: ${text}`);
    }
    const data: any = await resp.json();
    if (this.debug) console.log('[harness:debug] trigger response =\n' + JSON.stringify(data, null, 2));
    return (
      data?.pipelineExecutionId ??
      data?.executionId ??
      data?.id ??
      data?.data?.executionId ??
      data?.data?.pipelineExecutionId ??
      data?.data?.id
    );
  }

  private async fetchExecution(executionId: string): Promise<any> {
    const q = new URLSearchParams();
    if (this.accountId) q.set('accountIdentifier', this.accountId);
    if (this.orgId) q.set('orgIdentifier', this.orgId);
    if (this.projectId) q.set('projectIdentifier', this.projectId);
    const url =
      `${this.apiBase}/pipeline/api/pipelines/v2/executions/${executionId}?${q.toString()}`;
    const resp = await this.fetchImpl(url, {
      headers: { 'x-api-key': this.apiKey ?? '', 'Harness-Account': this.accountId ?? '' },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Harness status fetch failed ${resp.status}: ${text}`);
    }
    const data: any = await resp.json();
    if (this.debug) console.log('[harness:debug] status response =\n' + JSON.stringify(data, null, 2));
    return data;
  }

  private async pollUntilDone(
    executionId: string,
    onPoll?: (status: string) => void
  ): Promise<string> {
    let lastStatus = '';
    for (let i = 0; i < this.maxPolls; i++) {
      try {
        const data = await this.fetchExecution(executionId);
        const status = deepGet(data, this.statusPath) as string | undefined;
        if (status && status !== lastStatus) {
          lastStatus = status;
          onPoll?.(status.toUpperCase());
        }
        if (status && this.doneStatuses.includes(status.toUpperCase())) {
          return status.toUpperCase();
        }
      } catch (e) {
        if (this.debug) console.log(`[harness:debug] poll ${i} error: ${(e as Error).message}`);
      }
      await sleep(this.pollIntervalMs);
    }
    return 'UNKNOWN';
  }
}

// 点路径取值器；当某段缺失时安全地返回空操作。
function deepGet(obj: any, path: string): unknown {
  return path
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function buildRuntimeYaml(pipelineId: string, vars: Record<string, string | number>): string {
  const lines = ['pipeline:', `  identifier: ${pipelineId}`, '  variables:'];
  for (const [k, v] of Object.entries(vars)) {
    lines.push(`    - name: ${k}`);
    lines.push(`      value: "${v}"`);
  }
  return lines.join('\n');
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
