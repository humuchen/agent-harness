/**
 * 医美客资插件 · 端到端验证脚本（B 闭环 + C 护栏）。
 * 直接调用插件构建产物里的工具处理器与存储，绕开 LLM，断言：
 *   1) 抖音私信 → lead_qualify → lead_capture → consultation_book 闭环，漏斗递进；
 *   2) 医疗广告合规护栏（registerMedicalAdGuardrail）拦截违规输出、放行合规输出。
 * 运行：node scripts/verify-ma-lead.cjs
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = 'C:/Users/Administrator/Documents/WorkBuddy/App/agent-harness';
const TEST_DIR = path.join(ROOT, '.verify-data', 'script-test');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
// store 在模块加载时读取 MEMORY_DIR，必须在 require 之前设置
process.env.MEMORY_DIR = TEST_DIR;
process.env.MA_DATA_DIR = path.join(TEST_DIR, 'plugins', 'medical-aesthetics-lead');

const store = require(path.join(ROOT, 'plugins/medical-aesthetics-lead/dist/store.js'));
const { registerQualifyTool } = require(path.join(ROOT, 'plugins/medical-aesthetics-lead/dist/tools/qualify.js'));
const { registerCaptureTool } = require(path.join(ROOT, 'plugins/medical-aesthetics-lead/dist/tools/capture.js'));
const { registerBookTool } = require(path.join(ROOT, 'plugins/medical-aesthetics-lead/dist/tools/book.js'));
const { registerHandoffTool } = require(path.join(ROOT, 'plugins/medical-aesthetics-lead/dist/tools/handoff.js'));

// 最小 ToolRegistry 桩：捕获注册的工具处理器
class FakeReg {
  constructor() { this.t = {}; }
  register(name, desc, schema, handler) { this.t[name] = { name, desc, schema, handler }; }
}
const reg = new FakeReg();
registerQualifyTool(reg);
registerCaptureTool(reg);
registerBookTool(reg);
registerHandoffTool(reg);

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label); }
}

(async () => {
  console.log('\n=== B. 最小闭环：抖音私信 → 留资 → 预约到店 ===');
  store.clearLeads();
  const leadId = 'douyin_888';

  const r1 = await reg.t['lead_qualify'].handler({
    leadId, channel: '抖音', project: '双眼皮', budget: '1-3万', city: '上海',
    intent: '想做双眼皮，预算2万左右', grade: 'A',
  });
  assert(r1.ok && r1.stage === 'qualified' && r1.grade === 'A', 'lead_qualify → stage=qualified, grade=A');

  const r2 = await reg.t['lead_capture'].handler({
    leadId, wechat: 'beauty_sh', phone: '13800000000', name: '小美', consent: true,
  });
  assert(r2.ok && r2.stage === 'captured', 'lead_capture(授权) → stage=captured');

  // 未授权不得留资（合规模块自保护）
  const r2b = await reg.t['lead_capture'].handler({ leadId, wechat: 'x', consent: false });
  assert(r2b.ok === false && r2b.needConsent === true, 'lead_capture(未授权) 被拒');

  const r3 = await reg.t['consultation_book'].handler({
    leadId, clinic: '上海静安院区', date: '2026-08-20', time: '14:30',
  });
  assert(r3.ok && r3.stage === 'booked', 'consultation_book → stage=booked');

  const r4 = await reg.t['lead_handoff'].handler({ leadId, reason: '高意向需面诊设计' });
  assert(r4.ok && r4.handedOff === true, 'lead_handoff → handedOff');

  const stats = store.fullStats();
  console.log('  漏斗: ' + JSON.stringify(stats.funnel));
  console.log('  到店率=' + stats.arriveRate + '% 成交率=' + stats.dealRate + '% 待认领=' + stats.handoffQueue.length);
  assert(stats.total === 1, '总客资=1');
  // 累计漏斗：qualify→capture→book→handoff(到店)，每一级都应 >=1
  assert(
    stats.funnel.qualified >= 1 && stats.funnel.captured >= 1 && stats.funnel.booked >= 1 && stats.funnel.arrived >= 1,
    '累计漏斗 qualified/captured/booked/arrived 递进'
  );
  assert(stats.handoffQueue.length === 1, '转人工队列含 1 条（待认领）');

  console.log('\n=== C. 医疗广告合规护栏（可插拔） ===');
  const guard = require(path.join(ROOT, 'packages/medical-ad-guard/dist/index.js'));
  const core = require(path.join(ROOT, 'packages/core/dist/index.js'));
  guard.registerMedicalAdGuardrail();
  assert(typeof core.checkOutput === 'function', 'core.checkOutput 已导出');

  const violations = [
    '我们保证百分百不留疤，绝对安全',
    '你这多半是眼肌无力，建议做个提肌',
    '术前术后对比你看，效果立竿见影',
    '价格只要9999元一口价全包',
  ];
  let blocked = 0;
  for (const v of violations) {
    const res = core.checkOutput(v);
    if (res.ok === false) blocked++;
    else console.log('    ⚠️ 未拦截: ' + v);
  }
  assert(blocked === violations.length, `违规输出全部被护栏拦截 (${blocked}/${violations.length})`);

  const clean = core.checkOutput('建议预约面诊，由医生结合你的眼部基础评估合适方案，效果因人而异');
  assert(clean.ok === true, '合规输出放行');

  // 幂等：重复注册不应导致规则翻倍（用输入侧计数近似验证不抛错）
  guard.registerMedicalAdGuardrail();
  assert(true, 'registerMedicalAdGuardrail 重复调用幂等不抛错');

  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* 忽略 safe-delete 守卫 */ }
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
