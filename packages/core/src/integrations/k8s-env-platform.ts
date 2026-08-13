/**
 * Kubernetes 环境后端（KubernetesEnvPlatform）。
 *
 * 生产级"自助环境治理"后端：把一次 `create` 变成真实 K8s 资源——
 *   Deployment（镜像来自 K8S_IMAGE 或 input.image）+ Service + 可选 Ingress，
 * 轮询 Deployment 就绪后返回可访问 URL；`destroy` 删除这些资源释放配额。
 *
 * 依赖 `@kubernetes/client-node`（**可选依赖**，与 ioredis 同模式）：未安装或无可用的
 * kubeconfig 时，构造即抛出清晰错误，绝不静默降级。要启用：
 *   pnpm --filter @agent-harness/core add -D @kubernetes/client-node
 *   并配置 KUBECONFIG（或运行于集群内，自动用 in-cluster 配置）。
 *
 * 与核心 framework 零业务耦合：它只是 `EnvPlatform` 的一个实现，Agent/UI 通过
 * `createEnvPlatform('k8s')` 或 `ENV_PLATFORM=k8s` 选择，其余代码无需改动。
 */
import type { EphemeralEnvInput, EnvHandle } from './env-platform.types';
import type { EnvPlatform } from './env-platform';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** K8s 名称必须匹配 DNS-1123：小写字母数字与 '-'，长度 <= 63。 */
function k8sName(s: string): string {
  let v = s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  v = v.replace(/^-+|-+$/g, '');
  return v.slice(0, 63) || 'env';
}

export class KubernetesEnvPlatform implements EnvPlatform {
  readonly kind = 'k8s' as const;
  readonly dryRun = false;

  private k8s: any;
  private k8sCore: any;
  private k8sApps: any;
  private k8sNet: any;
  private namespace: string;
  private namePrefix: string;
  private image: string;
  private ingressHostTemplate?: string;
  private replicas: number;
  private containerPort: number;
  private cpuLimit?: string;
  private memLimit?: string;
  private pollIntervalMs: number;
  private maxPolls: number;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    let mod: any;
    try {
      // 动态 require：缺失依赖时抛出清晰错误，而非静默失效。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('@kubernetes/client-node');
    } catch (e: any) {
      throw new Error(
        'KubernetesEnvPlatform 需要可选依赖 @kubernetes/client-node（当前未安装或加载失败）：' +
          (e?.message ?? String(e)) +
          '。请先 `pnpm --filter @agent-harness/core add -D @kubernetes/client-node` 并配置 KUBECONFIG。'
      );
    }
    const kc = new mod.KubeConfig();
    try {
      kc.loadFromDefault();
    } catch (e: any) {
      throw new Error(
        'KubernetesEnvPlatform 无法加载 kubeconfig（也未运行于集群内）：' + (e?.message ?? String(e))
      );
    }
    this.k8s = mod;
    this.k8sCore = kc.makeApiClient(mod.CoreV1Api);
    this.k8sApps = kc.makeApiClient(mod.AppsV1Api);
    this.k8sNet = kc.makeApiClient(mod.NetworkingV1Api);

    this.namespace = process.env.K8S_NAMESPACE || 'default';
    this.namePrefix = process.env.K8S_NAME_PREFIX || 'agent-env-';
    this.image = process.env.K8S_IMAGE || 'nginx:alpine';
    this.ingressHostTemplate = process.env.K8S_INGRESS_HOST_TEMPLATE; // 例如 https://{envId}.env.my-company.com
    this.replicas = Number(process.env.K8S_REPLICAS ?? 1) || 1;
    this.containerPort = Number(process.env.K8S_CONTAINER_PORT ?? 80) || 80;
    this.cpuLimit = process.env.K8S_CPU_LIMIT || undefined;
    this.memLimit = process.env.K8S_MEM_LIMIT || undefined;
    this.pollIntervalMs = Number(process.env.K8S_POLL_INTERVAL_MS ?? 5000);
    this.maxPolls = Number(process.env.K8S_MAX_POLLS ?? 60);
  }

  private resName(envId: string): string {
    return `${this.namePrefix}${k8sName(envId)}`;
  }

  async createEphemeralEnvironment(input: EphemeralEnvInput): Promise<EnvHandle> {
    const envId = input.envId ?? `env-${Date.now()}`;
    const name = this.resName(envId);
    const image = input.image || this.image;
    const labels = { 'agent-harness/env': k8sName(envId), 'app.kubernetes.io/managed-by': 'agent-harness' };

    const deployment = {
      metadata: { name, namespace: this.namespace, labels },
      spec: {
        replicas: this.replicas,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: 'app',
                image,
                ports: [{ containerPort: this.containerPort }],
                env: [
                  { name: 'BRANCH', value: input.branch },
                  { name: 'OWNER', value: input.owner ?? '' },
                  { name: 'ENV_ID', value: envId },
                ],
                ...(this.cpuLimit || this.memLimit
                  ? {
                      resources: {
                        limits: {
                          ...(this.cpuLimit ? { cpu: this.cpuLimit } : {}),
                          ...(this.memLimit ? { memory: this.memLimit } : {}),
                        },
                      },
                    }
                  : {}),
              },
            ],
          },
        },
      },
    };
    const service = {
      metadata: { name, namespace: this.namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: this.containerPort, targetPort: this.containerPort }],
        type: 'ClusterIP',
      },
    };

    await this.k8sApps.createNamespacedDeployment(this.namespace, deployment);
    await this.k8sCore.createNamespacedService(this.namespace, service);

    let envUrl = `http://${name}.${this.namespace}.svc.cluster.local:${this.containerPort}`;
    if (this.ingressHostTemplate) {
      const host = this.ingressHostTemplate.replace(/\{envId\}/g, k8sName(envId));
      const ingress = {
        metadata: { name, namespace: this.namespace, labels },
        spec: {
          rules: [
            {
              host,
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: { service: { name, port: { number: this.containerPort } } },
                  },
                ],
              },
            },
          ],
        },
      };
      await this.k8sNet.createNamespacedIngress(this.namespace, ingress);
      envUrl = host.startsWith('http') ? host : `http://${host}`;
    }

    const status = await this.pollUntilReady(name);
    if (input.ttlHours && input.ttlHours > 0) {
      const t = setTimeout(() => {
        this.destroyEnvironment({ envId }).catch(() => {});
      }, input.ttlHours * 3600 * 1000);
      this.timers.set(envId, t);
    }
    return {
      envId,
      envUrl,
      status: status ? 'ready' : 'failed',
      executionId: `k8s:${this.namespace}/${name}`,
    };
  }

  async destroyEnvironment(input: { envId: string }): Promise<EnvHandle> {
    const name = this.resName(input.envId);
    const opts = { pretty: 'true' };
    if (this.ingressHostTemplate) {
      await this.k8sNet.deleteNamespacedIngress(name, this.namespace, opts).catch(() => {});
    }
    await this.k8sApps.deleteNamespacedDeployment(name, this.namespace, opts).catch(() => {});
    await this.k8sCore.deleteNamespacedService(name, this.namespace, opts).catch(() => {});
    const t = this.timers.get(input.envId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(input.envId);
    }
    return { envId: input.envId, envUrl: '', status: 'destroyed', executionId: `k8s:${this.namespace}/${name}` };
  }

  async createEphemeralEnvironmentWithEvents(
    input: EphemeralEnvInput,
    onStage: (status: string) => void
  ): Promise<EnvHandle> {
    onStage('PROVISIONING');
    try {
      // 提交资源（create 内部会轮询），轮询期间视为 RUNNING。
      const handleP = this.createEphemeralEnvironment(input);
      // 给一点点时间让 Deployment 进入调度阶段，UI 更顺滑。
      await sleep(800);
      onStage('RUNNING');
      const handle = await handleP;
      if (handle.status === 'ready') onStage('READY');
      else onStage('FAILED');
      return handle;
    } catch (e: any) {
      onStage('FAILED');
      throw e;
    }
  }

  async destroyEnvironmentWithEvents(
    input: { envId: string },
    onStage: (status: string) => void
  ): Promise<EnvHandle> {
    onStage('DESTROYING');
    const handle = await this.destroyEnvironment(input);
    onStage('DESTROYED');
    return handle;
  }

  async getStatus(envId: string): Promise<string | undefined> {
    const name = this.resName(envId);
    try {
      const dep = await this.k8sApps.readNamespacedDeployment(name, this.namespace);
      const avail = dep?.status?.availableReplicas ?? 0;
      return avail >= this.replicas ? 'ready' : 'provisioning';
    } catch {
      return undefined;
    }
  }

  private async pollUntilReady(name: string): Promise<boolean> {
    for (let i = 0; i < this.maxPolls; i++) {
      try {
        const dep = await this.k8sApps.readNamespacedDeployment(name, this.namespace);
        const avail = dep?.status?.availableReplicas ?? 0;
        if (avail >= this.replicas) return true;
      } catch {
        // 资源尚未可见，继续轮询
      }
      await sleep(this.pollIntervalMs);
    }
    return false;
  }
}
