/**
 * 向「医美客资」插件存储灌入一条完整闭环 + 两条对照线索，用于 Web 端客资看板演示。
 *
 * 必须在 require 客资 store 之前设置 MA_DATA_DIR（store 在加载时按 env 决定数据目录）。
 * 用法：
 *   MA_DATA_DIR=... node scripts/seed-closed-loop.cjs
 *
 * 数据目录与服务端保持一致即可：服务端启动时的 MA_DATA_DIR / MEMORY_DIR 与这里相同，
 * 看板（/api/plugins/medical-aesthetics-lead/stats）就能立刻读到。
 */
'use strict';
const path = require('path');

// 兜底：若未通过环境变量指定，默认落到项目内 .webdemo/ma-lead（与启动脚本约定一致）。
if (!process.env.MA_DATA_DIR && !process.env.MEMORY_DIR) {
  process.env.MA_DATA_DIR = path.resolve(__dirname, '..', '.webdemo', 'ma-lead');
}

const store = require(path.resolve(
  __dirname,
  '..',
  'plugins',
  'medical-aesthetics-lead',
  'dist',
  'store.js'
));

// 1) 完整闭环：抖音 / 双眼皮 / A 级 / 留资 / 预约 / 转人工（到店）
store.upsertLead('douyin_demo_001', {
  channel: '抖音',
  project: '双眼皮',
  budget: '2万',
  city: '杭州',
  intent: 'high',
  grade: 'A',
  stage: 'qualified'
});
store.captureLead('douyin_demo_001', { wechat: 'beauty_2026', name: '小美' });
store.bookLead('douyin_demo_001', { clinic: '杭州总院', date: '2026-08-20', time: '14:00' });
store.handoffLead('douyin_demo_001', '到店面诊');

// 2) 中段线索：小红书 / 玻尿酸 / B 级 / 已留资未预约
store.upsertLead('xhs_demo_002', {
  channel: '小红书',
  project: '玻尿酸',
  budget: '8千',
  city: '上海',
  intent: 'mid',
  grade: 'B',
  stage: 'qualified'
});
store.captureLead('xhs_demo_002', { wechat: 'xhs_lily', name: '莉莉' });

// 3) 流失线索：抖音 / 隆鼻 / C 级 / lost（进入待唤醒队列）
store.upsertLead('douyin_demo_003', {
  channel: '抖音',
  project: '隆鼻',
  budget: '3万',
  city: '杭州',
  intent: 'low',
  grade: 'C',
  stage: 'lost'
});

const stats = store.fullStats();
console.log('[seed-closed-loop] 已写入 3 条线索，看板统计：');
console.log(JSON.stringify(stats, null, 2));
