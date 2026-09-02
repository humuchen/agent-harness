import { ToolRegistry, objectParams } from '../tools';
import type { EnvPlatform } from './env-platform';

/**
 * 将环境自助服务工具注册到 Agent 的 ToolRegistry。
 * 这些工具使 Agent 能够与任意 EnvPlatform 后端（Harness / Kubernetes / 本地）完成闭环：
 * 创建临时环境、使用环境、销毁环境。后端通过 `client: EnvPlatform` 注入，主循环零改动。
 */
export function registerHarnessTools(
  registry: ToolRegistry,
  client: EnvPlatform
): void {
  registry.register(
    'create_ephemeral_environment',
    'Provision an ephemeral/preview environment via the Harness pipeline. ' +
      'Returns an env id and URL that subsequent steps can target.',
    objectParams(
      {
        env_type: { type: 'string', description: "Environment type, e.g. 'ephemeral' or 'preview'" },
        branch: { type: 'string', description: 'Git branch to deploy into the environment' },
        ttl_hours: { type: 'number', description: 'Auto-destroy after N hours (cost guard)' },
        region: { type: 'string', description: 'Optional cloud region' },
        owner: { type: 'string', description: 'Optional owner tag' },
      },
      ['env_type', 'branch']
    ),
    async (args) =>
      client.createEphemeralEnvironment({
        envType: String(args.env_type),
        branch: String(args.branch),
        ttlHours: args.ttl_hours != null ? Number(args.ttl_hours) : undefined,
        region: args.region != null ? String(args.region) : undefined,
        owner: args.owner != null ? String(args.owner) : undefined,
      })
  );

  registry.register(
    'destroy_environment',
    'Destroy a previously provisioned environment via the Harness destroy pipeline. ' +
      'Always call this when the environment is no longer needed (cost guard).',
    objectParams(
      {
        env_id: {
          type: 'string',
          description: 'Environment id returned by create_ephemeral_environment',
        },
      },
      ['env_id']
    ),
    async (args) => client.destroyEnvironment({ envId: String(args.env_id) })
  );
}
