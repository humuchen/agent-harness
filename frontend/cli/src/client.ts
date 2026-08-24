/**
 * 根据全局参数构造 AgentClient。token 可经 --token 或 AH_TOKEN 环境变量传入。
 */
import { AgentClient } from '@agent-harness/client';

export function makeClient(base: string, token?: string): AgentClient {
  const url = base.replace(/\/+$/, '') || 'http://localhost:4173';
  return new AgentClient({ baseUrl: url, token });
}
