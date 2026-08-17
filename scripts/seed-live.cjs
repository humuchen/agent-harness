process.env.MEMORY_DIR = 'C:/Users/Administrator/Documents/WorkBuddy/App/agent-harness/.verify-data';
const store = require('C:/Users/Administrator/Documents/WorkBuddy/App/agent-harness/plugins/medical-aesthetics-lead/dist/store.js');
const { registerQualifyTool } = require('C:/Users/Administrator/Documents/WorkBuddy/App/agent-harness/plugins/medical-aesthetics-lead/dist/tools/qualify.js');
const { registerCaptureTool } = require('C:/Users/Administrator/Documents/WorkBuddy/App/agent-harness/plugins/medical-aesthetics-lead/dist/tools/capture.js');
const { registerBookTool } = require('C:/Users/Administrator/Documents/WorkBuddy/App/agent-harness/plugins/medical-aesthetics-lead/dist/tools/book.js');
const { registerHandoffTool } = require('C:/Users/Administrator/Documents/WorkBuddy/App/agent-harness/plugins/medical-aesthetics-lead/dist/tools/handoff.js');
class R { constructor() { this.t = {}; } register(n, d, s, handler) { this.t[n] = { n, d, s, handler }; } }
const r = new R();
registerQualifyTool(r); registerCaptureTool(r); registerBookTool(r); registerHandoffTool(r);
(async () => {
  store.clearLeads();
  const id = 'douyin_live_001';
  await r.t['lead_qualify'].handler({ leadId: id, channel: '抖音', project: '热玛吉', budget: '2-4万', city: '上海', intent: '抗衰紧致咨询', grade: 'A' });
  await r.t['lead_capture'].handler({ leadId: id, wechat: 'antiaging_sh', phone: '13900000000', name: 'Lily', consent: true });
  await r.t['consultation_book'].handler({ leadId: id, clinic: '上海静安院区', date: '2026-08-25', time: '10:00' });
  await r.t['lead_handoff'].handler({ leadId: id, reason: '高意向需面诊设计' });
  const s = store.fullStats();
  console.log('LIVE funnel:', JSON.stringify(s.funnel));
  console.log('arriveRate', s.arriveRate, 'dealRate', s.dealRate, 'handoffQueue', s.handoffQueue.length);
})();
