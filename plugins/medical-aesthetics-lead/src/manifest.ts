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
  assembly: {
    systemPrompt: buildSystemPrompt(),
    // 硬允许集：列出的命名空间工具无条件进动态工具选择的 allowTools（topK 相关性裁剪裁不掉），
    // 保证系统提示词指挥的「必须调用 project_kb_search / lead_* / consultation_book」与模型
    // 实际拿到的函数定义严格一致（修复：裸名未注册 + 短问句 topK 路径把插件工具裁掉，
    // 导致模型误判「只有 builtin__use_skill 一个工具」而不检索知识库）。
    // delegate_task 由 server 层注册（subagent-tools.ts），原样透传进允许集。
    // 注意语义：此列表同时是内置工具白名单（registerBuiltinTools 收窄）——未列出的
    // 高-level 内置（calculator/datetime/web_fetch/filesystem/weather/data_transform）
    // 不再注册到主卡片；子 agent 各有自己的卡片声明所需工具，不受影响。
    tools: [
      'medical-aesthetics-lead__project_kb_search',
      'medical-aesthetics-lead__lead_qualify',
      'medical-aesthetics-lead__lead_capture',
      'medical-aesthetics-lead__consultation_book',
      'medical-aesthetics-lead__lead_handoff',
      'delegate_task',
    ],
    // 空数组 = 不启用任何通用技能（math / files / repo-verify 等开发向技能）。
    // 修复「多少钱」命中 math 触发词导致医美顾问误激活计算器技能的领域污染。
    // builtin__use_skill 元工具由 runner 层无条件注册，不受此约束。
    skills: [],
  },
};
