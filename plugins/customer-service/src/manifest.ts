import type { PluginManifest, AgentCapability } from '@agent-harness/core';
import { buildSystemPrompt } from './prompts';

/**
 * 智能客服插件清单。仅声明能力，实现分布在 tools/ / server/ / web/ 子模块。
 * pluginId === agentId === AgentCard.id = 'customer-service'。
 */
export const csManifest: PluginManifest = {
  id: 'customer-service',
  version: '0.1.0',
  name: '智能客服',
  description:
    '会话接待 / 知识库问答 / 工单 / 订单售后查询 / 转人工',
  domain: 'customer-service',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [
    { id: 'chat' },
    { id: 'intent' },
    { id: 'ticket' },
    { id: 'kb' },
    { id: 'handoff' },
  ] as AgentCapability[],
  // 装配配方：注入客服系统提示词，使本插件 agent 走「领域 harness」。
  assembly: { systemPrompt: buildSystemPrompt() },
};
