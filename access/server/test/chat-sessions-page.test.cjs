'use strict';
/**
 * 会话列表分页（左侧历史列表「滚动加载」）的服务端契约测试。
 *
 * 背景：改造前 `GET /api/chat/sessions` 一次性返回全量会话（每项还带全部消息记录），
 * 会话一多首屏就明显变慢。前端改为「每页 SESSION_PAGE_SIZE 条 + 滚到底续拉」后，
 * 分页切片的正确性与 hasMore 的判定就成了必须锁住的契约 —— 它们一旦错位，
 * 表现为「历史会话凭空少了一条」或「列表里同一会话出现两次」，且极难在人工点测中复现。
 *
 * 覆盖点：
 * 1. 逐页拼接 == 全量切片（顺序一致、无重复、无遗漏）；
 * 2. total 不随分页变化，hasMore 在「已到末尾」时为 false；
 * 3. 缺省 limit/total 保持「全量」旧契约（向后兼容老客户端）；
 * 4. limit 钳制到 CHAT_SESSION_MAX_PAGE、offset 越界返回空页；
 * 5. parseSessionPageQuery 对非法/缺省输入一律回落，绝不抛错。
 *
 * 运行前需 `tsc -p access/server/tsconfig.json` 产 dist。
 */
const test = require('node:test');
const assert = require('node:assert');

// 内存版 history store，避免污染真实 SQLite 文件。
process.env.HISTORY_BACKEND = 'memory';

const cs = require('../dist/chat-sessions.js');

const OWNER = 'pager_user';
const OTHER = 'pager_other';

/** 以指定 owner 批量建会话，返回 id 列表。 */
function seed(n, owner) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(cs.createChatSession(`${owner}-${i}`, owner).id);
  }
  return ids;
}

test('分页切片 == 全量切片，total 恒定、hasMore 在末尾转 false', () => {
  seed(7, OWNER);
  // 以全量为基准（同一进程同一时刻，排序稳定，故切片结果可比对）。
  const all = cs.listChatSessions(OWNER).map((s) => s.id);
  assert.equal(all.length, 7);

  const p1 = cs.listChatSessionsPage(OWNER, { limit: 3, offset: 0 });
  assert.deepEqual(p1.sessions.map((s) => s.id), all.slice(0, 3));
  assert.equal(p1.total, 7, 'total 应为过滤后全量条数');
  assert.equal(p1.hasMore, true);

  const p2 = cs.listChatSessionsPage(OWNER, { limit: 3, offset: 3 });
  assert.deepEqual(p2.sessions.map((s) => s.id), all.slice(3, 6));
  assert.equal(p2.total, 7);
  assert.equal(p2.hasMore, true);

  // 末页不足一页：必须 hasMore=false，否则前端会一直续拉空页。
  const p3 = cs.listChatSessionsPage(OWNER, { limit: 3, offset: 6 });
  assert.deepEqual(p3.sessions.map((s) => s.id), all.slice(6));
  assert.equal(p3.sessions.length, 1);
  assert.equal(p3.hasMore, false, '取到最后一页时 hasMore 必须为 false');
});

test('逐页拼接：无重复、无遗漏、顺序与全量一致', () => {
  const all = cs.listChatSessions(OWNER).map((s) => s.id);
  const seen = [];
  let offset = 0;
  let hasMore = true;
  for (let round = 0; round < 50 && hasMore; round++) {
    const p = cs.listChatSessionsPage(OWNER, { limit: 2, offset });
    seen.push(...p.sessions.map((s) => s.id));
    offset += p.sessions.length;
    hasMore = p.hasMore;
    if (hasMore) {
      assert.equal(p.sessions.length, 2, 'hasMore=true 时单页应为满页');
    }
  }
  assert.equal(hasMore, false, '分页未在 50 轮内收敛：hasMore 判定有误');
  assert.equal(new Set(seen).size, seen.length, '分页拼接不得出现重复会话');
  assert.deepEqual(seen, all, '分页拼接应逐条覆盖全量且顺序一致');
});

test('缺省 limit 保持「全量」旧契约（向后兼容老客户端）', () => {
  const all = cs.listChatSessions(OWNER).map((s) => s.id);

  const full = cs.listChatSessionsPage(OWNER);
  assert.deepEqual(full.sessions.map((s) => s.id), all, '不传 limit 应返回全量');
  assert.equal(full.hasMore, false, '全量返回时不可能还有下一页');
  assert.equal(full.total, all.length);

  // 只给 offset、不给 limit：从 offset 到末尾的全部剩余条目。
  const tail = cs.listChatSessionsPage(OWNER, { offset: 2 });
  assert.deepEqual(tail.sessions.map((s) => s.id), all.slice(2));
  assert.equal(tail.hasMore, false);
});

test('offset 越界返回空页且 hasMore=false', () => {
  const p = cs.listChatSessionsPage(OWNER, { limit: 5, offset: 9999 });
  assert.equal(p.sessions.length, 0);
  assert.equal(p.hasMore, false, '越界必须显式告知「没有下一页」，否则前端会空转');
  assert.equal(p.total, cs.listChatSessions(OWNER).length, 'total 不受 offset 影响');
});

test('limit 钳制到 CHAT_SESSION_MAX_PAGE（防一次拉走整表）', () => {
  const bulkOwner = 'pager_bulk';
  const N = cs.CHAT_SESSION_MAX_PAGE + 10;
  seed(N, bulkOwner);

  const first = cs.listChatSessionsPage(bulkOwner, { limit: 99999, offset: 0 });
  assert.equal(
    first.sessions.length,
    cs.CHAT_SESSION_MAX_PAGE,
    '超大 limit 应被钳制到上限'
  );
  assert.equal(first.total, N);
  assert.equal(first.hasMore, true);

  const rest = cs.listChatSessionsPage(bulkOwner, {
    limit: 99999,
    offset: cs.CHAT_SESSION_MAX_PAGE
  });
  assert.equal(rest.sessions.length, 10, '剩余条目应能被下一轮取完');
  assert.equal(rest.hasMore, false);
});

test('分页按 owner 隔离：不串入他人会话，total 也只算自己的', () => {
  seed(3, OTHER);
  const mine = cs.listChatSessionsPage(OWNER, { limit: 100, offset: 0 });
  const otherIds = new Set(cs.listChatSessions(OTHER).map((s) => s.id));
  assert.equal(mine.total, cs.listChatSessions(OWNER).length);
  for (const s of mine.sessions) {
    assert.ok(!otherIds.has(s.id), `分页结果串入了他人会话 ${s.id}`);
  }
});

test('parseSessionPageQuery：非法/缺省输入一律回落，绝不抛错', () => {
  // 未传 / null / 空串 → 缺省语义（limit 缺省=全量由调用方处理，此处为 undefined）
  assert.deepEqual(cs.parseSessionPageQuery({}), {
    limit: undefined,
    offset: 0
  });
  assert.deepEqual(cs.parseSessionPageQuery({ limit: null, offset: null }), {
    limit: undefined,
    offset: 0
  });
  assert.deepEqual(cs.parseSessionPageQuery({ limit: '', offset: '' }), {
    limit: undefined,
    offset: 0
  });
  // 非法字符串 / 负数 → 回落
  assert.deepEqual(cs.parseSessionPageQuery({ limit: 'abc', offset: 'xyz' }), {
    limit: undefined,
    offset: 0
  });
  assert.deepEqual(cs.parseSessionPageQuery({ limit: '-5', offset: '-1' }), {
    limit: undefined,
    offset: 0
  });
  // 合法值：小数向下取整
  assert.deepEqual(cs.parseSessionPageQuery({ limit: '20', offset: '40' }), {
    limit: 20,
    offset: 40
  });
  assert.deepEqual(cs.parseSessionPageQuery({ limit: '20.9', offset: '40.9' }), {
    limit: 20,
    offset: 40
  });
  // 超大 limit 钳制
  assert.equal(
    cs.parseSessionPageQuery({ limit: '99999' }).limit,
    cs.CHAT_SESSION_MAX_PAGE
  );
});
