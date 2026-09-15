// manifest 工具面一致性回归测试：锁住「系统提示词指挥的工具名 == AgentCard.assembly.tools 硬允许集」。
//
// 修复的真实 bug：主卡片此前只声明 assembly.systemPrompt、未声明 tools → 插件工具
// （medical-aesthetics-lead__project_kb_search 等）不在硬允许集，短问句走动态选择
// topK 路径时被相关性裁剪裁掉 → 模型自我判定「只有 builtin__use_skill 一个工具」，
// 该调 project_kb_search 没调、误激活通用 math 技能。本测试防止该退化静默回归。
const test = require('node:test');
const assert = require('node:assert/strict');
const { leadManifest } = require('../dist/manifest');
const {
  buildSystemPrompt,
  buildBookingAgentPrompt,
  buildProjectAdvisorPrompt,
  buildPricingAgentPrompt,
  buildCaptureAgentPrompt
} = require('../dist/prompts');

const NS = `${leadManifest.id}__`;

test('主卡片声明 tools 硬允许集（防 topK 裁剪裁掉插件工具）', () => {
  const tools = leadManifest.assembly?.tools ?? [];
  assert.ok(tools.length > 0, 'assembly.tools 应非空（硬允许集）');
  // 每个条目必须是命名空间全名（<pluginId>__*）或 server 层注册的 delegate_task。
  for (const t of tools) {
    assert.ok(
      t.startsWith(`${NS}`) || t === 'delegate_task',
      `工具 ${t} 应为命名空间名 ${NS}* 或 delegate_task`,
    );
  }
  assert.ok(
    tools.some((t) => t === `${NS}project_kb_search`),
    '硬允许集必须包含知识库检索工具 project_kb_search',
  );
});

test('skills 显式置空（防 math/files 等通用技能污染领域 agent）', () => {
  assert.deepStrictEqual(
    leadManifest.assembly?.skills,
    [],
    '空数组 = 一个通用技能都不启用（runner 语义）；undefined 会误开全部',
  );
});

test('主提示词引用的工具名与 assembly.tools 一致（命名空间全名）', () => {
  const prompt = buildSystemPrompt();
  for (const t of leadManifest.assembly.tools.filter((x) => x !== 'delegate_task')) {
    assert.ok(prompt.includes(t), `主提示词应引用实际注册名 ${t}`);
  }
  assert.ok(prompt.includes('delegate_task'), '子 Agent 派发指令应引用 delegate_task 注册名');
});

test('子 Agent 提示词工具名与其卡片 allow 集一致（booking/capture/advisor/pricing）', () => {
  // 与 index.ts 各子 Agent 卡片 assembly.tools 的命名空间名对齐，防止提示词指挥裸名
  assert.ok(
    buildProjectAdvisorPrompt().includes(`${NS}project_kb_search`),
    'project-advisor 提示词应引用命名空间名',
  );
  assert.ok(
    buildPricingAgentPrompt().includes(`${NS}project_kb_search`),
    'pricing-agent 提示词应引用命名空间名',
  );
  assert.ok(
    buildBookingAgentPrompt().includes(`${NS}consultation_book`) &&
      buildBookingAgentPrompt().includes(`${NS}lead_handoff`) &&
      buildBookingAgentPrompt().includes(`${NS}lead_qualify`),
    'booking-agent 提示词指挥的 consultation_book/lead_handoff/lead_qualify 均为命名空间名',
  );
  assert.ok(
    buildCaptureAgentPrompt().includes(`${NS}lead_capture`) &&
      buildCaptureAgentPrompt().includes(`${NS}lead_qualify`),
    'capture-agent 提示词应引用命名空间名',
  );
});
