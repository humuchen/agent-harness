/**
 * 真实模型行为评测：预约失败（booking-failed）场景下，转人工队列必须有客资。
 *
 * 背景（真实 bug）：用户在线上预约系统不可用时被告知「会把需求提交给客服人员」，
 * 但转人工队列为空——agent 只口头承诺、没调 lead_handoff，客资没进队列。
 *
 * 本评测验证两层防线的合成效果：
 *   1) 硬兜底：consultation_book 失败（非 INVALID_ARGUMENT，本场景为 NOT_FOUND——
 *      临时库无任何院区）→ 工具层自动触发 lead_handoff 落库（即便模型不听话也会兜住）；
 *   2) 提示词纪律：模型应据 autoHandoff/工具结果如实告知「已转交咨询师」，
 *      不得编造未配置的跟进方式（短信/电话回访）。
 *
 * 运行（需要 OPENROUTER_API_KEY）：
 *   OPENROUTER_API_KEY=sk-xxx node plugins/medical-aesthetics-lead/scripts/booking-fail-eval.cjs
 * 脚本使用临时 MA_DATA_DIR，不污染真实客资库。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-eval-'));
process.env.MA_DATA_DIR = DATA_DIR;
process.env.MA_TENANT_ID = 'default';
process.env.MA_OUTBOX_ENABLED = 'false';
// 隔离：确保不继承外部 CRM/HIS/RAG，避免 booking 意外成功或同步出网
delete process.env.MA_CRM_BASE_URL;
delete process.env.MA_HIS_BASE_URL;
delete process.env.MA_RAG_BASE_URL;
delete process.env.MA_RAG_TOKEN;

const { AgentHarness, ToolRegistry, createOpenRouterLLM } = require('@agent-harness/core');

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[eval] 需要 OPENROUTER_API_KEY（见 .env.example）');
    process.exit(2);
  }

  // 与插件 setup 相同的工具集（不含 web/server 副作用，聚焦工具链路）
  const tools = new ToolRegistry();
  require(path.join(P, 'dist/tools/qualify')).registerQualifyTool(tools);
  require(path.join(P, 'dist/tools/capture')).registerCaptureTool(tools);
  require(path.join(P, 'dist/tools/book')).registerBookTool(tools);
  require(path.join(P, 'dist/tools/handoff')).registerHandoffTool(tools);
  require(path.join(P, 'dist/tools/kb')).registerKbTool(tools);
  console.log('[eval] 已注册工具:', tools.schemas().map((s) => s.name).join(', '));

  const agent = new AgentHarness({
    llm: createOpenRouterLLM(),
    tools,
    systemPrompt: require(path.join(P, 'dist/prompts')).buildSystemPrompt(),
  });

  // 场景：用户给全了渠道/项目/预算/城市/院区/日期/时段，但本环境无任何院区 → booking 必失败
  const question = '我是抖音来的，想做皮肤管理，预算 1000 以内，人在青岛。帮我预约青岛市南院 8月23日 10:00 面诊。';
  console.log('\n[1/3] user:', question);
  const answer = await agent.run(question);
  console.log('\n[2/3] 最终回复:\n' + answer);

  // 断言：临时库必须有 handed_off=1 的线索（硬兜底或提示词纪律任一防线生效）
  const dbFile = path.join(DATA_DIR, 'ma-lead.db');
  const Database = require('node:sqlite').DatabaseSync;
  const db = new Database(dbFile, { readOnly: true });
  const all = db.prepare('SELECT lead_id, stage, handed_off, channel, project FROM ma_lead').all();
  const handed = db.prepare('SELECT lead_id, stage, handoff_reason FROM ma_lead WHERE handed_off = 1').all();
  db.close();
  console.log('\n[3/3] 临时库线索:', all.length, '| 转人工(handed_off=1):', handed.length);
  for (const r of handed) console.log('   ', JSON.stringify(r));

  const hasHandoff = handed.length >= 1;
  const saysTransferred = /转交|转接|咨询师|人工/.test(answer);
  const hallucinatedChannel = /(今天内|稍后|稍候).{0,12}(短信|电话|微信)|(短信|电话|微信).{0,8}(回访|联系您)/.test(answer);

  console.log('\n断言:');
  console.log('  [A] 转人工队列非空（handed_off=1 ≥ 1）:', hasHandoff ? 'PASS' : 'FAIL');
  console.log('  [B] 回复如实提及已转交咨询师:', saysTransferred ? 'PASS' : 'WARN（可能未说明去向）');
  console.log('  [C] 未编造未配置跟进方式（短信/电话回访）:', hallucinatedChannel ? 'FAIL' : 'PASS');

  const ok = hasHandoff;
  console.log(ok ? '\nEVAL_PASS' : '\nEVAL_FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('eval failed:', e);
  process.exit(1);
});
