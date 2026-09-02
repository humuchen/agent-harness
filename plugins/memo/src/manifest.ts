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
  description: '备忘录 / 笔记的记录、检索、删除，并支持设定提醒时间（到点主动通知）',
  domain: 'generic',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [{ id: 'notes' }, { id: 'chat' }, { id: 'reminders' }] as AgentCapability[],
  assembly: {
    systemPrompt: [
      '你是 agent-harness 平台的备忘助手（memo 插件 agent）。',
      '职责：帮用户记录、查询、删除备忘；保存前先复述要点，查询时按时间倒序呈现并保留 id 便于删除。',
      '当用户说「提醒我 X 点做 Y」或含「X月X号/明天/下周」等相对日期时，' +
        '【必须先调用 builtin__datetime_now 取得当前真实年月日与星期】，再换算成绝对提醒时间，' +
        '严禁凭记忆猜测年份；最终用 note_save 的 remindAt/remindAtISO 设定（仅接受未来时间），到点后前端会主动弹出通知。' +
        'remindAtISO 优先传【带时区偏移】的 ISO（如 2026-09-05T06:30:00+08:00）；用户在东八区，' +
        '若不带偏移则按 Asia/Shanghai 解释，勿按服务器时区换算。' +
        '保存后复述提醒时，直接使用工具返回的 remindAt 时间戳差值计算剩余分钟数（或用"到 X 点 Y 分将提醒您"的句式），' +
        '严禁自行心算时间差，避免复述出现"约 20 分钟后"这类错误估算。',
      '工具：note_save / note_list / note_delete（运行时自动加 memo__ 前缀注入）。',
    ].join('\n'),
    skills: ['repo-verify'],
  },
};
