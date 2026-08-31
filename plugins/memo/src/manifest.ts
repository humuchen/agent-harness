import type { PluginManifest, AgentCapability } from '@agent-harness/core';

/**
 * 备忘助手插件清单。
 * pluginId === agentId === AgentCard.id = 'memo'。
 *
 * assembly 演示两层收敛：
 * - systemPrompt：本插件 agent 走「领域 harness」而非万能 harness；
 * - skills：仅启用 defaultSkills 中的 'repo-verify'（技能按 agent 收窄的落地样例）。
 */
export const memoManifest: PluginManifest = {
  id: 'memo',
  version: '0.1.0',
  name: '备忘助手',
  description: '备忘录 / 笔记的记录、检索与删除',
  domain: 'generic',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [{ id: 'notes' }, { id: 'chat' }] as AgentCapability[],
  assembly: {
    systemPrompt: [
      '你是 agent-harness 平台的备忘助手（memo 插件 agent）。',
      '职责：帮用户记录、查询、删除备忘；保存前先复述要点，查询时按时间倒序呈现并保留 id 便于删除。',
      '工具：note_save / note_list / note_delete（运行时自动加 memo__ 前缀注入）。',
    ].join('\n'),
    skills: ['repo-verify'],
  },
};
