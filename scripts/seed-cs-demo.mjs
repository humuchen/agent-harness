/**
 * 客服插件演示数据 seed（与 store.ts 同一目录约定）。
 *
 * 写入位置优先级（与 plugins/customer-service/src/store.ts 完全一致）：
 *   1. CS_DATA_DIR                          （运维显式指定）
 *   2. MEMORY_DIR/plugins/customer-service  （复用 core 共享卷）
 *   3. ./data/cs                            （本地退化）
 *
 * 用法：
 *   node scripts/seed-cs-demo.mjs            # 写入默认目录（需与启动服务时的目录一致）
 *   CS_DATA_DIR=/abs/path node scripts/seed-cs-demo.mjs
 *
 * 注意：seed 不依赖任何运行时依赖（纯 fs），直接 node 跑即可。
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DATA_DIR =
  process.env.CS_DATA_DIR ??
  (process.env.MEMORY_DIR
    ? join(process.env.MEMORY_DIR, 'plugins', 'customer-service')
    : join(process.cwd(), 'data', 'cs'));

function safeFile(key) {
  const cleaned = String(key ?? 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return join(DATA_DIR, `${cleaned || 'anonymous'}.json`);
}

function write(key, obj) {
  mkdirSync(dirname(safeFile(key)), { recursive: true });
  const tmp = `${safeFile(key)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2)}`;
  writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
  renameSync(tmp, safeFile(key));
}

// 10 个会话记录：覆盖不同意图 / 转人工 / 满意度
const sessions = [
  { lastIntent: '退款', handedOff: false, satisfaction: 5 },
  { lastIntent: '物流查询', handedOff: false, satisfaction: 4 },
  { lastIntent: '发票', handedOff: false, satisfaction: 3 },
  { lastIntent: '退款', handedOff: true, satisfaction: 2 },
  { lastIntent: '账号问题', handedOff: false, satisfaction: 5 },
  { lastIntent: '物流查询', handedOff: false, satisfaction: 4 },
  { lastIntent: '投诉', handedOff: true, satisfaction: 1 },
  { lastIntent: '发票', handedOff: false, satisfaction: 3 },
  { lastIntent: '退款', handedOff: false, satisfaction: 4 },
  { lastIntent: '账号问题', handedOff: false, satisfaction: 5 },
];

const now = Date.now();
sessions.forEach((s, i) => {
  const id = `demo-${i + 1}`;
  write(id, {
    sessionId: id,
    kind: 'session',
    lastIntent: s.lastIntent,
    handedOff: s.handedOff,
    satisfaction: s.satisfaction,
    updatedAt: now - i * 3600_000,
  });
});

// 1 条 run 对话记录（事件桥接写入的形态）
write('run-demo', {
  sessionId: 'run-demo',
  kind: 'run',
  handedOff: false,
  transcript: [
    { role: 'user', text: '我要申请退款', t: now - 1000 },
    { role: 'assistant', text: '已为您登记退款，预计 3 个工作日到账', t: now - 800 },
  ],
  updatedAt: now - 800,
});

console.log(`seeded 11 demo records into: ${DATA_DIR}`);
