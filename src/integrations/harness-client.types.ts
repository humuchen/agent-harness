export interface EphemeralEnvInput {
  envType: string; // 例如 'ephemeral' / 'preview'
  branch: string; // 要部署的 Git 分支
  ttlHours?: number; // N 小时后自动销毁
  region?: string;
  owner?: string;
}

export interface EnvHandle {
  envId: string;
  envUrl: string;
  status: 'provisioning' | 'ready' | 'destroying' | 'destroyed' | 'failed';
  executionId?: string;
}
