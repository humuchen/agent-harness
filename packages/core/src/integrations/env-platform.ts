/**
 * 环境平台（EnvPlatform）可插拔契约 + 工厂。
 *
 * 设计目标（延续本项目"接口 + 默认实现 + 组合工厂"原则）：
 * - 把"自助环境治理闭环"与具体后端解耦。Agent / UI 只依赖 `EnvPlatform` 接口，
 *   不感知背后是 Harness Pipeline、Kubernetes，还是本地零依赖后端。
 * - `HarnessClient` 是默认实现（未配 `HARNESS_API_KEY` 时 dry-run），保证零凭据仍可演示。
 * - `LocalEnvPlatform` 零依赖、真正起一个本地预览服务，无需任何外部平台即可跑通闭环
 *   （适合本地验证 / 内部小团队 / 演示）。
 * - `KubernetesEnvPlatform` 生产级后端（可选依赖 `@kubernetes/client-node`），把分支部署成
 *   真实 K8s 命名空间下的 Deployment/Service/Ingress，适合企业落地。
 *
 * 切换后端只需设 `ENV_PLATFORM=harness|k8s|local`（见 `createEnvPlatform`）。
 */
import type { EphemeralEnvInput, EnvHandle } from './env-platform.types';
import { HarnessClient } from './harness-client';
import { LocalEnvPlatform } from './local-env-platform';
import { KubernetesEnvPlatform } from './k8s-env-platform';

export type EnvPlatformKind = 'harness' | 'k8s' | 'local';

export interface EnvPlatform {
  /** 后端类型标识。 */
  readonly kind: EnvPlatformKind;
  /** 是否干跑（不真正创建外部资源）。UI 据此在面板标注。 */
  readonly dryRun: boolean;
  /** 拉起一个临时/预览环境。 */
  createEphemeralEnvironment(input: EphemeralEnvInput): Promise<EnvHandle>;
  /** 销毁环境并释放资源。 */
  destroyEnvironment(input: { envId: string }): Promise<EnvHandle>;
  /**
   * 拉起环境并在状态变化时回调（供 UI 流水线可视化）。
   * 回调状态为 Harness 风格的 'PROVISIONING' | 'RUNNING' | 'READY' | 'DESTROYING' | 'DESTROYED' | 'FAILED'。
   */
  createEphemeralEnvironmentWithEvents(
    input: EphemeralEnvInput,
    onStage: (status: string) => void
  ): Promise<EnvHandle>;
  /** 与上面对称：销毁环境的流式版本。 */
  destroyEnvironmentWithEvents(
    input: { envId: string },
    onStage: (status: string) => void
  ): Promise<EnvHandle>;
  /** 可选：查询某环境当前状态字符串。 */
  getStatus?(envId: string): Promise<string | undefined>;
}

/**
 * 组合工厂：按 `ENV_PLATFORM` 选择后端（默认 harness，保持历史零凭据 dry-run 行为）。
 * - `harness`（默认）：Harness NG Pipeline 客户端；无 `HARNESS_API_KEY` 时自动 dry-run。
 * - `local`：零依赖本地预览后端，开箱即真实可跑。
 * - `k8s`：Kubernetes 后端（需 `@kubernetes/client-node` + 可用 kubeconfig，缺失则构造即报错）。
 */
export function createEnvPlatform(kind?: EnvPlatformKind): EnvPlatform {
  const raw = (kind ?? process.env.ENV_PLATFORM ?? 'harness').toString().toLowerCase();
  const k: EnvPlatformKind =
    raw === 'k8s' || raw === 'kubernetes'
      ? 'k8s'
      : raw === 'local'
      ? 'local'
      : 'harness';
  switch (k) {
    case 'k8s':
      return new KubernetesEnvPlatform();
    case 'local':
      return new LocalEnvPlatform();
    case 'harness':
    default:
      return new HarnessClient();
  }
}
