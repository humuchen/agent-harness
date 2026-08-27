'use strict';
const test = require('node:test');
const assert = require('node:assert');

// 多用户隔离回归测试：确保会话存储与历史镜像按 owner 严格隔离，跨用户不可互见。
// 设置内存版 history store，避免污染真实 SQLite 文件。
process.env.HISTORY_BACKEND = 'memory';

const cs = require('../dist/chat-sessions.js');
const hs = require('../dist/history-store.js');

test('chat-sessions: 不同 owner 的会话互不可见', () => {
  const a = cs.createChatSession('A 的会话', 'alice');
  const b = cs.createChatSession('B 的会话', 'bob');
  // 各自追加消息
  cs.appendChatMessage(a.id, { role: 'user', content: 'A 的秘密', ts: Date.now() }, 'alice');
  cs.appendChatMessage(b.id, { role: 'user', content: 'B 的秘密', ts: Date.now() }, 'bob');

  // list 过滤
  const aliceList = cs.listChatSessions('alice').map((s) => s.id);
  const bobList = cs.listChatSessions('bob').map((s) => s.id);
  assert.ok(aliceList.includes(a.id));
  assert.ok(!aliceList.includes(b.id));
  assert.ok(bobList.includes(b.id));
  assert.ok(!bobList.includes(a.id));

  // get 越权返回 null（不泄露存在性）
  assert.equal(cs.getChatSession(a.id, 'alice')?.id, a.id);
  assert.equal(cs.getChatSession(a.id, 'bob'), null);
  assert.equal(cs.getChatSession(b.id, 'alice'), null);

  // rename/delete 越权失败
  assert.equal(cs.renameChatSession(a.id, '黑客改名', 'bob'), null);
  assert.equal(cs.deleteChatSession(b.id, 'alice'), false);
  // 本人操作成功
  assert.equal(cs.renameChatSession(a.id, 'A 改名', 'alice')?.title, 'A 改名');
  assert.equal(cs.deleteChatSession(b.id, 'bob'), true);
});

test('chat-sessions: 越权写入他人会话被拒（append 归属校验）', () => {
  const s = cs.createChatSession('归属 alice', 'alice');
  // bob 尝试向 alice 的会话追加消息 -> 返回 null，消息不写入
  const r = cs.appendChatMessage(
    s.id,
    { role: 'user', content: '越权内容', ts: Date.now() },
    'bob'
  );
  assert.equal(r, null);
  const after = cs.getChatSession(s.id, 'alice');
  assert.equal(after?.messages.length, 0, '越权消息不应写入');
});

test('chat-sessions: 无 owner 旧数据归 legacy 桶，普通用户不可见', () => {
  // 以 legacy 桶创建（模拟升级前无 owner 的存档）
  const legacy = cs.createChatSession('旧存档', cs.LEGACY_OWNER);
  assert.equal(cs.listChatSessions('alice').includes(legacy), false);
  assert.equal(cs.getChatSession(legacy.id, 'alice'), null);
});

test('history-store: 不同 owner 的历史镜像互不可见', () => {
  hs.resetHistoryStoreForTest();
  const store = hs.getHistoryStore();
  const now = Date.now();
  store.upsert(
    { sid: 'h_a', title: 'A 历史', updatedAt: now, savedAt: now },
    JSON.stringify([{ role: 'user', content: 'A' }]),
    'alice'
  );
  store.upsert(
    { sid: 'h_b', title: 'B 历史', updatedAt: now, savedAt: now },
    JSON.stringify([{ role: 'user', content: 'B' }]),
    'bob'
  );

  // index 过滤
  const aIdx = store.index('alice').map((m) => m.sid);
  const bIdx = store.index('bob').map((m) => m.sid);
  assert.ok(aIdx.includes('h_a') && !aIdx.includes('h_b'));
  assert.ok(bIdx.includes('h_b') && !bIdx.includes('h_a'));

  // get 越权返回 null
  assert.equal(store.get('h_a', 'alice')?.meta.sid, 'h_a');
  assert.equal(store.get('h_a', 'bob'), null);
  assert.equal(store.get('h_b', 'alice'), null);

  // remove 越权失败
  assert.equal(store.remove('h_b', 'alice'), false);
  assert.equal(store.remove('h_a', 'alice'), true);
});

test('history-store: 同 sid 以最后写入 owner 归属，他人读取返回 null（防伪造归属）', () => {
  hs.resetHistoryStoreForTest();
  const store = hs.getHistoryStore();
  const now = Date.now();
  // alice 先写 sid
  store.upsert(
    { sid: 'shared_sid', title: 'alice 的', updatedAt: now, savedAt: now },
    '[]',
    'alice'
  );
  assert.equal(store.get('shared_sid', 'alice')?.meta.title, 'alice 的');
  // bob 用相同 sid 写入：归属转移为 bob（sid 为主键，覆盖旧记录）
  store.upsert(
    { sid: 'shared_sid', title: 'bob 的', updatedAt: now, savedAt: now },
    '[]',
    'bob'
  );
  // alice 再也读不到该 sid（已归 bob），bob 可读到自己的
  assert.equal(store.get('shared_sid', 'alice'), null);
  assert.equal(store.get('shared_sid', 'bob')?.meta.title, 'bob 的');
});
