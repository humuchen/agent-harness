/**
 * memo 插件单元测试（零依赖，node --test，require 编译产物 dist）。
 * 覆盖：manifest 形状 / 工具读写闭环 / 触发词命中 repo-verify / 路由扩展形状 /
 *       SQLite 落库 owner 绑定与隔离 / 旧 JSON 迁移 / 提醒调度。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const core = require('../../../backend/core/dist/index.js');
const plugin = require('../dist/index.js');

/** 每个用例独立的临时数据目录（MEMO_DATA_DIR 由 store 惰性读取 → 独立 memo.db）。 */
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-'));
  process.env.MEMO_DATA_DIR = dir;
  return dir;
}

const alice = { sub: 'alice' };
const bob = { sub: 'bob' };

test('manifest 形状：id/capabilities/assembly.skills 收窄', () => {
  const m = plugin.memoPlugin.manifest;
  assert.equal(m.id, 'memo');
  assert.ok(Array.isArray(m.capabilities) && m.capabilities.length > 0, 'capabilities 非空');
  assert.ok(m.assembly, 'assembly 存在');
  assert.ok(
    Array.isArray(m.assembly.skills) && m.assembly.skills.includes('repo-verify'),
    'assembly.skills 应收窄为包含 repo-verify'
  );
  // JSON-only 约定：清单必须可无损序列化
  const round = JSON.parse(JSON.stringify(m));
  assert.deepEqual(round, m);
});

test('工具注册与读写闭环：save → list → delete（runWithUser 绑定 alice）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  await core.runWithUser({ sub: 'alice' }, async () => {
    // save
    const saved = await reg.call('note_save', { text: '今天对接医美看板', tag: 'work' });
    assert.equal(saved.ok, true);
    assert.ok(saved.id, '应返回备忘 id');

    // list
    const listed = await reg.call('note_list', {});
    assert.equal(listed.ok, true);
    assert.equal(listed.total, 1);
    assert.equal(listed.notes[0].text, '今天对接医美看板');

    // tag 过滤
    const miss = await reg.call('note_list', { tag: 'idea' });
    assert.equal(miss.total, 0);

    // delete
    const del = await reg.call('note_delete', { id: saved.id });
    assert.equal(del.deleted, true);
    const after = await reg.call('note_list', {});
    assert.equal(after.total, 0);
  });
});

test('owner 绑定：alice 保存的备忘 bob 不可见、不可删', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const saved = await core.runWithUser(alice, () =>
    reg.call('note_save', { text: 'alice 的私人备忘' })
  );
  assert.equal(saved.ok, true);

  // bob 视角：列表为空、删除也无效（越权视同不存在）
  const bobList = await core.runWithUser(bob, () => reg.call('note_list', {}));
  assert.equal(bobList.total, 0, '跨用户不可互见');
  const bobDel = await core.runWithUser(bob, () => reg.call('note_delete', { id: saved.id }));
  assert.equal(bobDel.deleted, false, '跨用户删除应被 (owner,id) 收口拒绝');

  // alice 视角：数据仍在
  const aliceList = await core.runWithUser(alice, () => reg.call('note_list', {}));
  assert.equal(aliceList.total, 1);
});

test('无运行上下文（CLI/单测）兜底 anon 桶：与登录用户互不串扰', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const saved = await reg.call('note_save', { text: '无上下文备忘' });
  assert.equal(saved.ok, true);

  const anonList = await reg.call('note_list', {});
  assert.equal(anonList.total, 1, 'anon 桶内可见');

  const aliceList = await core.runWithUser(alice, () => reg.call('note_list', {}));
  assert.equal(aliceList.total, 0, '登录用户看不到 anon 桶');
});

test('工具参数校验：空 text / 空 id 返回 error 结构（不抛错中断）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const badSave = await reg.call('note_save', { text: '   ' });
  assert.equal(badSave.error, true);

  const badDel = await reg.call('note_delete', { id: 'not-exist' });
  assert.equal(badDel.ok, true);
  assert.equal(badDel.deleted, false);
});

test('触发词命中：repo-verify 技能可被「构建/验证」类输入预激活', () => {
  const reg = new core.SkillRegistry();
  reg.registerMany(core.defaultSkills());

  const hits = reg.matchTriggers('帮我验证一下仓库构建是否全绿');
  assert.ok(hits.some((s) => s.id === 'repo-verify'), '应命中 repo-verify');

  // 技能描述注入系统提示词的目录应包含该技能
  const catalog = reg.describeForPrompt();
  assert.ok(catalog.includes('repo-verify'));
});

test('assembly.skills 收窄：memo agent 只启用 repo-verify', () => {
  const reg = new core.SkillRegistry();
  const skills = core.defaultSkills().filter(
    (s) => plugin.memoPlugin.manifest.assembly.skills.includes(s.id)
  );
  reg.registerMany(skills);
  assert.deepEqual(reg.list().map((s) => s.id), ['repo-verify']);
});

test('服务端扩展形状：纯路径路由 key + 方法内判断', () => {
  const ext = plugin.memoServerExtension;
  assert.equal(ext.id, 'memo');
  assert.equal(typeof ext.mountRoutes['/notes'], 'function');
  assert.equal(typeof ext.mountRoutes['/note'], 'function');
});

test('落库迁移：旧 notes.json 导入 legacy 桶后改名 .migrated，登录用户不可见', async () => {
  const dir = freshDataDir();
  fs.writeFileSync(
    path.join(dir, 'notes.json'),
    JSON.stringify([
      { id: 'legacy-1', text: '旧版备忘', tag: 'work', createdAt: Date.now() - 1000 },
    ]),
    'utf8'
  );

  const store = require('../dist/store.js');
  // 首次访问触发建表 + 迁移
  const mine = await store.listNotes(alice.sub);
  assert.equal(mine.length, 0, '登录用户不应看到 legacy 桶');
  const legacy = await store.listNotes(store.LEGACY_OWNER);
  assert.equal(legacy.length, 1, '旧数据应迁入 legacy 桶不丢失');
  assert.equal(legacy[0].id, 'legacy-1');
  assert.ok(
    fs.existsSync(path.join(dir, 'notes.json.migrated')),
    '旧文件应改名为 .migrated 防重复导入'
  );
});

test('落库迁移：旧 JSON 损坏时静默跳过（不阻断正常读写）', async () => {
  const dir = freshDataDir();
  fs.writeFileSync(path.join(dir, 'notes.json'), '{ not valid json,,', 'utf8');

  const store = require('../dist/store.js');
  const listed = await store.listNotes(alice.sub);
  assert.equal(listed.length, 0, '损坏文件应安全回退为空');

  const saved = await store.saveNote(alice.sub, '损坏后新建');
  assert.ok(saved.id);
  const after = await store.listNotes(alice.sub);
  assert.equal(after.length, 1, '损坏恢复后应能正常写入并读出');
});

test('边界：并发保存全部落盘（无丢失）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);
  const N = 12;
  const calls = Array.from({ length: N }, (_, i) =>
    core.runWithUser(alice, () => reg.call('note_save', { text: `并发备忘 #${i}` }))
  );
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.ok), '全部保存应成功');
  const listed = await core.runWithUser(alice, () => reg.call('note_list', {}));
  assert.equal(listed.total, N, '并发保存不应丢条目');
});

test('边界：超大文本（~1MB）往返一致', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);
  const big = 'x'.repeat(1024 * 1024) + '末尾标记';
  const saved = await core.runWithUser(alice, () =>
    reg.call('note_save', { text: big, tag: 'big' })
  );
  assert.equal(saved.ok, true);
  const listed = await core.runWithUser(alice, () => reg.call('note_list', { tag: 'big' }));
  assert.equal(listed.total, 1);
  assert.equal(listed.notes[0].text.length, big.length);
  assert.ok(listed.notes[0].text.endsWith('末尾标记'));
});

test('边界：非法/空 tag 处理（空串按无 tag，特殊字符原样存）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const emptyTag = await core.runWithUser(alice, () =>
    reg.call('note_save', { text: '空标签', tag: '' })
  );
  assert.equal(emptyTag.ok, true);
  assert.equal(emptyTag.tag, null, '空串 tag 应归一为无标签');

  const weirdTag = await core.runWithUser(alice, () =>
    reg.call('note_save', { text: '怪异标签', tag: 'a/b:c#d' })
  );
  assert.equal(weirdTag.ok, true);
  assert.equal(weirdTag.tag, 'a/b:c#d', '特殊字符 tag 应原样保留');

  const filtered = await core.runWithUser(alice, () =>
    reg.call('note_list', { tag: 'a/b:c#d' })
  );
  assert.equal(filtered.total, 1, '按怪异 tag 应能过滤命中');
});

// ---------------------------------------------------------------------------
// 提醒功能：store / 工具解析 / 路由 / 调度器
// ---------------------------------------------------------------------------

test('提醒：note_save 接受未来 remindAt 并落库 remindAt/notified=false', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const future = Date.now() + 60_000;
  const saved = await core.runWithUser(alice, () =>
    reg.call('note_save', { text: '开会', remindAt: future, tag: 'work' })
  );
  assert.equal(saved.ok, true);
  assert.equal(typeof saved.remindAt, 'number');
  assert.ok(saved.remindAt >= future - 1, '应回传 remindAt');

  // store 层可查到待提醒（未来时间 → 不在 pending，在 upcoming）
  const store = require('../dist/store.js');
  const upcoming = await store.upcomingReminders(alice.sub, 10);
  assert.equal(upcoming.length, 1, '未来提醒应出现在即将到来列表');
  assert.equal(upcoming[0].notified, false, '未触发时应 notified=false');
});

test('提醒：note_save 拒绝过去/非法 remindAt（忽略提醒，不污染数据）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const past = await core.runWithUser(alice, () =>
    reg.call('note_save', { text: '已过期', remindAt: Date.now() - 1000 })
  );
  assert.equal(past.ok, true);
  assert.equal(past.remindAt, null, '过去时间应忽略 remindAt');

  const bad = await core.runWithUser(alice, () =>
    reg.call('note_save', { text: '非法', remindAtISO: 'not-a-date' })
  );
  assert.equal(bad.ok, true);
  assert.equal(bad.remindAt, null, '非法 ISO 应忽略 remindAt');

  const store = require('../dist/store.js');
  assert.equal((await store.pendingReminders(Date.now())).length, 0, '无待提醒项');
});

test('提醒：pendingReminders 只返回到期且未 notified 的项；markNotified 按 owner 收口去重', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  // 直接写一条已到期的备忘（remindAt 在过去）
  await store.saveNote(alice.sub, '到期提醒', 'work', Date.now() - 1000);
  const due = await store.pendingReminders(Date.now());
  assert.equal(due.length, 1, '到期未通知应被捞回');
  assert.equal(due[0].owner, alice.sub, 'pending 应携带归属 owner');

  const ok = await store.markNotified(alice.sub, due[0].id);
  assert.equal(ok, true, '本人 ack 应成功');
  assert.equal((await store.pendingReminders(Date.now())).length, 0, 'ack 后不再出现');

  // 重复 ack 幂等
  const ok2 = await store.markNotified(alice.sub, due[0].id);
  assert.equal(ok2, false, '重复 ack 应返回 false（无变更）');

  // 越权 ack：bob 无法 ack alice 的提醒
  await store.saveNote(alice.sub, '另一条', 'work', Date.now() - 2000);
  const due2 = await store.pendingReminders(Date.now());
  assert.equal(due2.length, 1);
  const okBob = await store.markNotified(bob.sub, due2[0].id);
  assert.equal(okBob, false, '跨用户 ack 应无效');
});

test('提醒：路由 /reminders 返回 pending+upcoming；/reminders/ack 标记', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '即将开会', 'work', Date.now() + 30_000);
  await store.saveNote(alice.sub, '昨晚的事', 'life', Date.now() - 60_000);
  // bob 的到期提醒：不应混进 alice 的 pending
  await store.saveNote(bob.sub, 'bob 的事', 'life', Date.now() - 90_000);

  const ext = plugin.memoServerExtension;
  const mkReq = (url, method = 'GET') => ({ url, method });
  const collect = () => {
    let body = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(b) { body = b; },
    };
    return { res, get obj() { return JSON.parse(body); } };
  };

  // GET /reminders（宿主传入 alice）
  {
    const c = collect();
    await ext.mountRoutes['/reminders'](mkReq('/reminders', 'GET'), c.res, alice);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.owner, alice.sub, '应回显归属 owner');
    assert.equal(c.obj.upcoming.length, 1, 'upcoming 应含未来提醒');
    assert.equal(c.obj.pending.length, 1, 'pending 应只含本人到期提醒');
    assert.equal(c.obj.pending[0].text, '昨晚的事');
  }

  // POST /reminders/ack?id=...
  {
    const dueId = (await store.pendingReminders(Date.now())).find((n) => n.owner === alice.sub).id;
    const c = collect();
    await ext.mountRoutes['/reminders/ack'](mkReq(`/reminders/ack?id=${dueId}`, 'POST'), c.res, alice);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.notified, true, 'ack 应落库');
    const still = (await store.pendingReminders(Date.now())).filter((n) => n.owner === alice.sub);
    assert.equal(still.length, 0, 'ack 后本人 pending 清空');
  }
});

test('提醒：调度器到点 fire 一次（进程内去重）+ 重启自然补发（靠 pendingReminders）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const ReminderScheduler = require('../dist/reminder-scheduler.js').ReminderScheduler;

  const fires = [];
  const alerts = [];
  const logger = { info() {}, warn() {} };
  const sched = new ReminderScheduler(
    (r) => { fires.push(r); },
    (e) => alerts.push(e),
    logger
  );

  // 写一条已到期提醒
  await store.saveNote(alice.sub, '到点提醒', 'work', Date.now() - 1000);

  // 立即触发一次：应 fire 一次，且事件携带 owner
  await sched.triggerNow();
  assert.equal(fires.length, 1, '到期未通知项应 fire 一次');
  assert.equal(fires[0].owner, alice.sub, 'fire 事件应携带归属 owner');
  assert.equal(alerts.length, 0, '正常 fire 不应走 alert 通道');

  // 再次触发：进程内去重，不应重复 fire
  await sched.triggerNow();
  assert.equal(fires.length, 1, '进程内已 fire 过的 id 不应重复触发');

  // 「重启」语义：本进程 firedThisProcess 是内存态，但 store 层 pendingReminders 仍会捞回
  // （只要前端未 ack 落库）。这里模拟「前端未 ack」：pending 仍在，新进程会再次 fire。
  assert.equal((await store.pendingReminders(Date.now())).length, 1, '未 ack 时，重启后 pending 仍可被捞回（天然补发）');

  sched.stop();
});

test('提醒：调度器 fire 抛错走 alert 通道且不中断后续项', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const ReminderScheduler = require('../dist/reminder-scheduler.js').ReminderScheduler;

  let fires = 0;
  const alerts = [];
  const logger = { info() {}, warn() {} };
  const sched = new ReminderScheduler(
    () => { fires++; throw new Error('boom'); },
    (e) => alerts.push(e),
    logger
  );
  await store.saveNote(alice.sub, '会失败', 'x', Date.now() - 1000);
  await store.saveNote(bob.sub, '会成功', 'y', Date.now() - 1000);

  await sched.triggerNow();
  // 两项都到期：fire 对第一项抛错被捕获，第二项仍执行（fire 计数含失败的也调用了）
  assert.equal(fires, 2, '两项都应被 fire（失败不阻断后续）');
  assert.equal(alerts.length, 2, '两条都失败应各走一次 alert 通道');
  sched.stop();
});

test('提醒：前端视图按登录人渲染（待提醒卡 + owner 标注 + --ah- 令牌）', async () => {
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '看板提醒', 'idea', Date.now() + 120_000);
  const view = plugin.memoBoardView;
  assert.equal(view.tabId, 'memo');
  const html = await view.render(alice);
  assert.ok(typeof html === 'string');
  assert.ok(html.includes('待提醒'), '看板应包含「待提醒」区块');
  assert.ok(html.includes('看板提醒'), '看板应渲染本人数据');
  assert.ok(html.includes('alice'), '看板应标注归属用户');
  assert.ok(html.includes('--ah-'), '样式应使用 --ah-* 主题令牌');
});

// ---------------------------------------------------------------------------
// 提醒历史：错过通知窗口后的可回查能力
// ---------------------------------------------------------------------------

test('提醒历史：ack 时落库 notifiedAt，reminderHistory 按确认时间倒序返回', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  // 三条都已触发并被 ack（notified 由 markNotified 置位，同时写入 notifiedAt）
  const a = await store.saveNote(alice.sub, '第一条', 'work', Date.now() - 300_000);
  const b = await store.saveNote(alice.sub, '第二条', 'work', Date.now() - 200_000);
  const c = await store.saveNote(alice.sub, '第三条', 'life', Date.now() - 100_000);
  await store.markNotified(alice.sub, a.id);
  await store.markNotified(alice.sub, b.id);
  await store.markNotified(alice.sub, c.id);

  const hist = await store.reminderHistory(alice.sub, 20);
  assert.equal(hist.length, 3, '三条已 ack 的提醒都应进入历史');
  // 倒序：最近 ack 的在前
  assert.equal(hist[0].id, c.id, '最近确认的应排最前');
  assert.equal(hist[2].id, a.id, '最早确认的应排最后');
  for (const n of hist) {
    assert.equal(typeof n.notifiedAt, 'number', 'ack 应写入 notifiedAt 时间戳');
  }
});

test('提醒历史：未 ack 的项不进历史；pending/upcoming 也不混入历史', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const pending = await store.saveNote(alice.sub, '到期未 ack', 'work', Date.now() - 1000);
  const upcoming = await store.saveNote(alice.sub, '将来才提醒', 'work', Date.now() + 60_000);
  const done = await store.saveNote(alice.sub, '已确认', 'work', Date.now() - 5000);
  await store.markNotified(alice.sub, done.id);

  const hist = await store.reminderHistory(alice.sub, 20);
  assert.equal(hist.length, 1, '只有已 ack 的才进历史');
  assert.equal(hist[0].id, done.id);
  assert.ok(!hist.some((n) => n.id === pending.id), '到期未 ack 不应进历史');
  assert.ok(!hist.some((n) => n.id === upcoming.id), '未到期不应进历史');
});

test('提醒历史：无 remindAt 的普通备忘不会误入历史', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '纯备忘无提醒', 'idea');
  assert.equal((await store.reminderHistory(alice.sub, 20)).length, 0, '无 remindAt 的备忘不应出现在历史');
});

test('提醒历史：无 notifiedAt 的旧数据（回退 remindAt 排序仍可见）', async () => {
  const dir = freshDataDir();
  // 旧版本落盘形态：只有 notified 标志，没有 notifiedAt 字段 → 迁移后经 COALESCE 兜底排序
  fs.writeFileSync(
    path.join(dir, 'notes.json'),
    JSON.stringify([
      {
        id: 'legacy-1',
        text: '旧数据提醒',
        tag: 'work',
        createdAt: Date.now() - 600_000,
        remindAt: Date.now() - 500_000,
        notified: true,
      },
    ]),
    'utf8'
  );

  const store = require('../dist/store.js');
  const hist = await store.reminderHistory(store.LEGACY_OWNER, 20);
  assert.equal(hist.length, 1, '旧数据（无 notifiedAt）也应出现在历史里');
  assert.equal(hist[0].id, 'legacy-1');
});

test('提醒：路由 /reminders 额外返回 history 字段', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const done = await store.saveNote(alice.sub, '已提醒的', 'work', Date.now() - 10_000);
  await store.markNotified(alice.sub, done.id);

  const ext = plugin.memoServerExtension;
  let body = '';
  const res = {
    statusCode: 0,
    setHeader() {},
    end(b) {
      body = b;
    },
  };
  await ext.mountRoutes['/reminders']({ url: '/reminders', method: 'GET' }, res, alice);
  const data = JSON.parse(body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.history), 'history 应为数组');
  assert.equal(data.history.length, 1, 'history 应含已触发的提醒');
  assert.equal(data.history[0].id, done.id);
  assert.equal(typeof data.history[0].notifiedAt, 'number', 'history 项应带 notifiedAt');
});

test('提醒：前端看板新增「提醒历史」区块（渲染含 --ah- 令牌）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const done = await store.saveNote(alice.sub, '历史提醒', 'work', Date.now() - 30_000);
  await store.markNotified(alice.sub, done.id);

  const html = await plugin.memoBoardView.render(alice);
  assert.ok(html.includes('提醒历史'), '看板应包含「提醒历史」区块');
  assert.ok(html.includes('历史提醒'), '历史条目内容应被渲染');
  assert.ok(html.includes('--ah-'), '样式应使用 --ah-* 主题令牌');
  assert.ok(html.includes('删除'), '看板应提供删除操作（数据管理）');
});

// ---------------------------------------------------------------------------
// 数据管理：检索 / 统计 / 批量清理（落库 owner 绑定之上的管理能力）
// ---------------------------------------------------------------------------

test('数据管理：searchNotes 关键词/标签过滤 + 分页 + total（均按 owner 收口）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '项目进度 周报', 'work');
  await store.saveNote(alice.sub, '项目复盘 风险', 'work');
  await store.saveNote(alice.sub, '买菜清单 西红柿', 'life');
  await store.saveNote(bob.sub, 'bob 的保密备忘', 'work');

  const r1 = await store.searchNotes(alice.sub, { q: '项目' });
  assert.equal(r1.total, 2, '关键词「项目」应命中 2 条本人备忘');
  assert.ok(r1.items.every((n) => n.owner === alice.sub), '结果不应混入 bob');

  const r2 = await store.searchNotes(alice.sub, { tag: 'work' });
  assert.equal(r2.total, 2, 'tag=work 应命中 2 条');

  const r3 = await store.searchNotes(alice.sub, { limit: 1, offset: 0 });
  assert.equal(r3.total, 3, 'total 不受分页影响');
  assert.equal(r3.items.length, 1, 'limit=1 只回 1 条');
  const r4 = await store.searchNotes(alice.sub, { limit: 1, offset: 1 });
  assert.equal(r4.items.length, 1);
  assert.notEqual(r4.items[0].id, r3.items[0].id, 'offset 应翻到不同页');
});

test('数据管理：noteStats 统计（总数/带标签/含提醒/历史）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '普通备忘无标签');
  await store.saveNote(alice.sub, '带标签', 'work');
  await store.saveNote(alice.sub, '有提醒', 'work', Date.now() + 60_000);
  const done = await store.saveNote(alice.sub, '已提醒', 'work', Date.now() - 5_000);
  await store.markNotified(alice.sub, done.id);

  const s = await store.noteStats(alice.sub);
  assert.equal(s.total, 4);
  assert.equal(s.tagged, 3, '带标签 = 3（普通备忘无标签）');
  assert.equal(s.withReminder, 2, '含提醒 = 2（「有提醒」未来 + 「已提醒」过去 remind_at 均计入）');
  assert.equal(s.history, 1, '已提醒历史 = 1');
});

test('数据管理：deleteNotes 批量删除按 owner 收口（越权 id 忽略），返回实际删除数', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const a1 = await store.saveNote(alice.sub, 'a1');
  const a2 = await store.saveNote(alice.sub, 'a2');
  const b1 = await store.saveNote(bob.sub, 'b1');

  const removed = await store.deleteNotes(alice.sub, [a1.id, a2.id, b1.id]);
  assert.equal(removed, 2, '只应删除本人 2 条，bob 的被忽略');

  assert.equal((await store.listNotes(alice.sub)).length, 0, 'alice 的两条已删');
  assert.equal((await store.listNotes(bob.sub)).length, 1, 'bob 的数据不受影响');
  assert.equal(await store.deleteNotes(alice.sub, []), 0, '空 ids 返回 0');
});

test('数据管理：deleteAllOwnerNotes 仅清空当前 owner，不影响他人', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, 'a1');
  await store.saveNote(alice.sub, 'a2');
  await store.saveNote(bob.sub, 'b1');

  const removed = await store.deleteAllOwnerNotes(alice.sub);
  assert.equal(removed, 2);
  assert.equal((await store.listNotes(alice.sub)).length, 0);
  assert.equal((await store.listNotes(bob.sub)).length, 1, 'bob 不被波及');
});

test('数据管理：路由 /stats 返回统计；/notes 支持 q/offset/total', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '项目进度', 'work');
  await store.saveNote(alice.sub, '生活琐事', 'life');
  await store.saveNote(bob.sub, 'bob 保密', 'work');

  const ext = plugin.memoServerExtension;
  const collect = () => {
    let body = '';
    const res = { statusCode: 0, setHeader() {}, end(b) { body = b; } };
    return { res, get obj() { return JSON.parse(body); } };
  };

  {
    const c = collect();
    await ext.mountRoutes['/stats']({ url: '/stats', method: 'GET' }, c.res, alice);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.owner, alice.sub);
    assert.equal(c.obj.stats.total, 2, 'stats 只计本人');
  }
  {
    const c = collect();
    await ext.mountRoutes['/notes']({ url: `/notes?q=${encodeURIComponent('项目')}`, method: 'GET' }, c.res, alice);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.total, 1, 'q 过滤生效');
    assert.equal(c.obj.notes[0].text, '项目进度');
  }
  {
    const c = collect();
    await ext.mountRoutes['/notes']({ url: '/notes?tag=work&offset=0&limit=1', method: 'GET' }, c.res, alice);
    assert.equal(c.obj.total, 1, 'tag+limit 过滤');
    assert.equal(c.obj.notes.length, 1);
  }
});

test('数据管理：路由 /notes/batch 批量删除 + /notes/all 需 confirm', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const a1 = await store.saveNote(alice.sub, 'a1');
  const a2 = await store.saveNote(alice.sub, 'a2');
  await store.saveNote(bob.sub, 'b1');

  const ext = plugin.memoServerExtension;
  const collect = () => {
    let body = '';
    const res = { statusCode: 0, setHeader() {}, end(b) { body = b; } };
    return { res, get obj() { return JSON.parse(body); } };
  };
  const mkReq = (url, method, bodyObj) => ({
    url,
    method,
    on(ev, cb) {
      if (ev === 'data') cb(JSON.stringify(bodyObj));
      if (ev === 'end') cb();
    },
  });

  // batch 含越权 b1
  {
    const c = collect();
    await ext.mountRoutes['/notes/batch'](mkReq('/notes/batch', 'DELETE', { ids: [a1.id, a2.id] }), c.res, alice);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.removed, 2, '只删本人 2 条');
  }
  assert.equal((await store.listNotes(alice.sub)).length, 0, 'alice 清空');
  assert.equal((await store.listNotes(bob.sub)).length, 1, 'bob 不受影响');

  // /notes/all 无 confirm → 拒绝
  {
    const c = collect();
    await ext.mountRoutes['/notes/all'](mkReq('/notes/all', 'DELETE', {}), c.res, alice);
    assert.equal(c.obj.error, true, '缺 confirm 应拒绝');
  }
  // 重建后 confirm 清空
  await store.saveNote(alice.sub, 'a3');
  {
    const c = collect();
    await ext.mountRoutes['/notes/all'](mkReq('/notes/all', 'DELETE', { confirm: true }), c.res, alice);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.removed, 1, 'confirm 后应清空本人');
  }
  assert.equal((await store.listNotes(alice.sub)).length, 0);
});

test('数据管理：看板渲染管理面板（统计/搜索框/全选/批量删除/清空按钮）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '看板管理条目 A', 'work');
  await store.saveNote(alice.sub, '看板管理条目 B', 'life');

  const html = await plugin.memoBoardView.render(alice);
  assert.ok(html.includes('数据管理'), '应含「数据管理」面板');
  assert.ok(html.includes('id="memo-search"'), '应含搜索框');
  assert.ok(html.includes('memo-mgmt-chk'), '应含多选复选框');
  assert.ok(html.includes('memo-mgmt-all'), '应含全选框');
  assert.ok(html.includes('删除选中'), '应含批量删除按钮');
  assert.ok(html.includes('清空全部'), '应含清空全部按钮');
  assert.ok(html.includes('看板管理条目 A'), '应渲染本人数据');
  assert.ok(html.includes('--ah-'), '样式应使用 --ah-* 令牌');
});

test('全选 checkbox：使用 onchange 而非 onclick，避免 this 绑定丢失；JS 不含 < 运算符', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '条目 A', 'work');
  await store.saveNote(alice.sub, '条目 B', 'life');

  const html = await plugin.memoBoardView.render(alice);
  // 表头全选框应使用 onchange 事件（event.target 稳定），不是 onclick（this 易丢失）
  const headerMatch = html.match(/class="memo-mgmt-all"[^>]*>/);
  assert.ok(headerMatch, '应含全选复选框');
  assert.ok(headerMatch[0].includes('onchange='), '全选框应绑定 onchange 而非 onclick');
  assert.ok(!headerMatch[0].includes('onclick='), '全选框不应再绑定 onclick');
  // onchange JS 不应包含 < 运算符（esc('<') → &lt; 可能在属性解析层被错误解码）
  const onchangeJs = headerMatch[0].match(/onchange="([^"]*)"/)?.[1] ?? '';
  assert.ok(!onchangeJs.includes('&lt;'), '全选 JS 不应含 < 运算符（经 esc 转义为 &lt;）');
});

test('下拉菜单：点击选项应正确设置 hidden select value 并触发 change 事件', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '条目 A', 'work');
  await store.saveNote(alice.sub, '条目 B', 'life');

  const html = await plugin.memoBoardView.render(alice);
  // 选项的 onclick 应：1) 设置 hidden select value，2) 在 select 上 dispatch change，3) 关闭菜单
  const optionMatch = html.match(/memo-select-option[^>]*onclick="([^"]*)"/);
  assert.ok(optionMatch, '应含下拉选项 onclick');
  const onclickJs = optionMatch[1];
  // 应在 hidden select 上 dispatch change，不是在 li(this) 上
  assert.ok(onclickJs.includes('s.dispatchEvent(new Event'), '选项点击应在 select 上派发 change 事件');
  // 应关闭菜单（closest('.memo-select-menu') + style.display='none'）
  assert.ok(onclickJs.includes('.memo-select-menu'), '选项点击应关闭菜单');
  assert.ok(onclickJs.includes("display='none'"), '菜单应被隐藏');
});

test('数据管理：searchNotes 支持 sort（newest/oldest/remind）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const a = await store.saveNote(alice.sub, '第一条');
  const b = await store.saveNote(alice.sub, '第二条');
  const c = await store.saveNote(alice.sub, '第三条');

  const newest = await store.searchNotes(alice.sub, { sort: 'newest' });
  assert.equal(newest.items[0].id, c.id, 'newest 应把最后插入的排最前');
  const oldest = await store.searchNotes(alice.sub, { sort: 'oldest' });
  assert.equal(oldest.items[0].id, a.id, 'oldest 应把最早插入的排最前');

  // remind：有提醒的排前，无提醒(null)排后
  const withR = await store.saveNote(alice.sub, '有提醒', 'x', Date.now() + 60_000);
  const remind = await store.searchNotes(alice.sub, { sort: 'remind' });
  assert.equal(remind.items[0].id, withR.id, 'remind 排序有提醒的应在前');
  assert.ok(remind.items[remind.items.length - 1].remindAt == null, '无提醒的排最后');
});

test('数据管理：路由 /board 返回表体片段 JSON（含 html/total/offset/count），翻页+过滤生效', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  for (let i = 0; i < 5; i++) await store.saveNote(alice.sub, '条目 ' + i);
  await store.saveNote(bob.sub, 'bob 保密');

  const ext = plugin.memoServerExtension;
  const collect = () => {
    let body = '';
    const res = { statusCode: 0, setHeader() {}, end(b) { body = b; } };
    return { res, get obj() { return JSON.parse(body); } };
  };
  const mk = (url) => ({ url, method: 'GET' });

  // 第一页 limit=2（默认 newest 排序 → 两条最新：条目 4、条目 3）
  {
    const c = collect();
    await ext.mountRoutes['/board'](mk('/board?offset=0&limit=2'), c.res, alice);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.total, 5, '只计本人 5 条');
    assert.equal(c.obj.offset, 0);
    assert.equal(c.obj.count, 2, '本页 2 条');
    assert.ok(c.obj.html.includes('memo-mgmt-tbody'), '片段应含表体容器');
    assert.ok(c.obj.html.includes('条目 4'), 'newest 排序下首条应为最新（条目 4）');
  }
  // 第二页 offset=2（条目 2、条目 1）
  {
    const c = collect();
    await ext.mountRoutes['/board'](mk('/board?offset=2&limit=2'), c.res, alice);
    assert.equal(c.obj.offset, 2);
    assert.equal(c.obj.count, 2);
    assert.ok(c.obj.html.includes('条目 2') || c.obj.html.includes('条目 1'), '第二页应包含条目 2/1');
  }
  // 关键词过滤
  {
    const c = collect();
    await ext.mountRoutes['/board'](mk(`/board?q=${encodeURIComponent('条目 4')}`), c.res, alice);
    assert.equal(c.obj.total, 1, 'q 过滤后只 1 条');
    assert.ok(c.obj.html.includes('条目 4'));
  }
});

test('数据管理：noteTags 返回当前用户去重标签（不含他人、不含空标签）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, 'a1', 'work');
  await store.saveNote(alice.sub, 'a2', 'work');
  await store.saveNote(alice.sub, 'a3', 'life');
  await store.saveNote(alice.sub, 'a4'); // 无标签
  await store.saveNote(bob.sub, 'b1', 'secret'); // 他人标签不应混入

  const tags = await store.noteTags(alice.sub);
  assert.deepEqual(tags, ['life', 'work'], '应返回去重且排序后的本人标签，不含空标签');
  const bobTags = await store.noteTags(bob.sub);
  assert.deepEqual(bobTags, ['secret'], '只返回 bob 自己的标签');
});

test('数据管理：路由 /board 支持按标签过滤（tag 参数）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, '工作项', 'work');
  await store.saveNote(alice.sub, '生活项', 'life');
  await store.saveNote(alice.sub, '无标签项');

  const ext = plugin.memoServerExtension;
  const collect = () => {
    let body = '';
    const res = { statusCode: 0, setHeader() {}, end(b) { body = b; } };
    return { res, get obj() { return JSON.parse(body); } };
  };
  const mk = (url) => ({ url, method: 'GET' });

  {
    const c = collect();
    await ext.mountRoutes['/board'](mk(`/board?tag=${encodeURIComponent('work')}`), c.res, alice);
    assert.equal(c.obj.total, 1, 'tag=work 只命中 1 条');
    assert.ok(c.obj.html.includes('工作项'));
    assert.ok(!c.obj.html.includes('生活项'));
  }
});

test('看板：渲染含标签过滤下拉（全部标签 + 各标签项）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  await store.saveNote(alice.sub, 'x', 'work');
  await store.saveNote(alice.sub, 'y', 'life');

  const html = await plugin.memoBoardView.render(alice);
  assert.ok(html.includes('id="memo-tag"'), '应含标签过滤下拉');
  assert.ok(html.includes('全部标签'), '应含「全部标签」选项');
  assert.ok(html.includes('>work<'), '应含 work 标签选项');
  assert.ok(html.includes('>life<'), '应含 life 标签选项');
});

// ---------------------------------------------------------------------------
// 时区解析：无时区 ISO 按 Asia/Shanghai 解释（修 UTC 服务器晚 8 小时 bug）
// 注意：本文件常被以 TZ=UTC 运行（模拟 Render 服务器环境），用例必须时区无关。
// ---------------------------------------------------------------------------

test('时区：无时区 ISO 按 Asia/Shanghai 墙上时间解析（UTC 服务器不再偏 8 小时）', async () => {
  const store = require('../dist/store.js');
  const future = Date.now() + 90 * 24 * 3600_000; // 远期，避免被「仅接受未来」过滤
  const ymd = new Date(future).toISOString().slice(0, 10); // UTC 日期串做输入底稿

  // naive ISO（无时区）：09:28 应该就是东八区的 09:28
  const naive = store.resolveRemindAt(null, `${ymd}T09:28:00`);
  assert.ok(naive != null, 'naive ISO 应解析成功');
  // 期望值：同一墙上时间在 UTC 的 epoch，减去东八区 +8h 偏移
  const expected = Date.parse(`${ymd}T09:28:00Z`) - 8 * 3600_000;
  assert.equal(naive, expected, 'naive ISO 应按 Asia/Shanghai (+08:00) 解释');

  // 带偏移 ISO：直接按偏移解析，且与 naive 语义一致
  const aware = store.resolveRemindAt(null, `${ymd}T09:28:00+08:00`);
  assert.equal(aware, naive, '+08:00 偏移串应与 naive 按 Asia/Shanghai 解析等价');

  const z = store.resolveRemindAt(null, `${ymd}T01:28:00Z`);
  assert.equal(z, Date.parse(`${ymd}T01:28:00Z`), 'Z 结尾串按 UTC 原样解析');

  // epoch ms 不受时区影响
  assert.equal(store.resolveRemindAt(future), future, 'epoch ms 应原样透传');

  // 落库后可被 upcoming 捞到（证明整链路时区一致）
  freshDataDir();
  const saved = await store.saveNote(alice.sub, '时区核对', 'work', naive);
  const upcoming = await store.upcomingReminders(alice.sub, 10);
  assert.ok(upcoming.some((n) => n.id === saved.id), '按东八区解析的提醒应真实有效');
});
