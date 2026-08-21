/**
 * 环境平台（EnvPlatform）共享契约类型。
 *
 * 把「自助环境治理」与具体后端（Harness / Kubernetes / 本地）解耦：
 * Agent 只认 `EphemeralEnvInput` / `EnvHandle`，后端负责把"分支"变成"可访问的环境"。
 */

export interface EphemeralEnvInput {
  /** 由编排层（env-pipeline）分配的 envId，保证 create / destroy 一致性；后端可忽略自行生成。 */
  envId?: string;
  /** 环境类型，例如 'ephemeral' / 'preview'。 */
  envType: string;
  /** 要部署的 Git 分支。 */
  branch: string;
  /** N 小时后自动销毁（成本护栏）。 */
  ttlHours?: number;
  /** 可选云区域 / 可用区。 */
  region?: string;
  /** 可选所有者标签。 */
  owner?: string;
  /** 可选要部署的镜像（后端可忽略，使用自身默认镜像）。 */
  image?: string;
}

export interface EnvHandle {
  envId: string;
  envUrl: string;
  status: 'provisioning' | 'ready' | 'destroying' | 'destroyed' | 'failed';
  /** 后端相关的执行标识（Harness 的 executionId / K8s 的 namespace 等）。 */
  executionId?: string;
}
