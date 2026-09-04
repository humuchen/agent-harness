import type { PluginManifest, AgentCapability } from '@agent-harness/core';
import { buildSystemPrompt } from './prompts';

/**
 * 医美客资插件清单。仅声明能力，实现分布在 tools/ / server/ / web/ 子模块。
 * pluginId === agentId === AgentCard.id = 'medical-aesthetics-lead'。
 */
export const leadManifest: PluginManifest = {
  id: 'medical-aesthetics-lead',
  version: '0.1.0',
  name: '医美客资顾问',
  description:
    '多渠道获客 / 需求初筛 / 项目咨询 / 留资 / 预约到店 / 转人工咨询师，含医疗广告合规护栏',
  domain: 'medical-aesthetics',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [
    { id: 'chat' },
    { id: 'lead' },
    { id: 'consult' },
    { id: 'book' },
    { id: 'handoff' },
    { id: 'analytics' },
  ] as AgentCapability[],
  // 装配配方：注入客资系统提示词（含合规红线），使本插件 agent 走「领域 harness」。
  assembly: { systemPrompt: buildSystemPrompt() },
};
