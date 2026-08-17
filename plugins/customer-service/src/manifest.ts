import type { PluginManifest, AgentCapability } from '@agent-harness/core';
import { buildSystemPrompt } from './prompts';

/**
 * 智能客服插件清单（与 manifest.json 保持一致；代码形态便于类型校验与版本化）。
 * 仅声明能力，不写任何实现——实现分布在 tools/ / workflows/ / server/ / web/ 子模块。
 */
export const customerServiceManifest: PluginManifest = {
  id: 'customer-service',
  version: '0.1.0',
  name: '智能客服',
  description:
    '多轮对话 / FAQ 检索 / 意图识别(退款·查单·技术支持) / 转人工 / 会话持久化 / 满意度统计',
  domain: 'generic',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [
    { id: 'chat' },
    { id: 'faq' },
    { id: 'support' },
    { id: 'ticket' },
    { id: 'handoff' },
  ] as AgentCapability[],
  // 装配配方：注入客服系统提示词，使本插件 agent 走「领域 harness」而非万能 harness。
  assembly: { systemPrompt: buildSystemPrompt() },
};
