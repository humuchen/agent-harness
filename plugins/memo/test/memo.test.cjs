/**
 * memo 插件单元测试（零依赖，node --test，require 编译产物 dist）。
 * 覆盖：manifest 形状 / 工具读写闭环 / 触发词命中 repo-verify / 路由扩展形状。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const core = require('../../../backend/core/dist/index.js');
const plugin = require('../dist/index.js');

/** 每个用例独立的临时数据目录（MEMO_DATA_DIR 由 store 惰性读取）。 */
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-'));
  process.env.MEMO_DATA_DIR = dir;
  return dir;
}

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

test('工具注册与读写闭环：save → list → delete', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

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

test('前端视图形状：tabId/label/render 返回含 --ah-* 令牌的 HTML', () => {
  const view = plugin.memoBoardView;
  assert.equal(view.tabId, 'memo');
  const html = view.render();
  assert.ok(typeof html === 'string');
  assert.ok(html.includes('--ah-'), '样式应使用 --ah-* 主题令牌');
});

// ---------------------------------------------------------------------------
// 边界测试：并发 / 超大文本 / 非法 tag / 存储损坏回退
// ---------------------------------------------------------------------------

test('边界：并发保存全部落盘（无丢失）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);
  const N = 12;
  const calls = Array.from({ length: N }, (_, i) =>
    reg.call('note_save', { text: `并发备忘 #${i}` })
  );
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.ok), '全部保存应成功');
  const listed = await reg.call('note_list', {});
  assert.equal(listed.total, N, '并发保存不应丢条目');
});

test('边界：超大文本（~1MB）往返一致', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);
  const big = 'x'.repeat(1024 * 1024) + '末尾标记';
  const saved = await reg.call('note_save', { text: big, tag: 'big' });
  assert.equal(saved.ok, true);
  const listed = await reg.call('note_list', { tag: 'big' });
  assert.equal(listed.total, 1);
  assert.equal(listed.notes[0].text.length, big.length);
  assert.ok(listed.notes[0].text.endsWith('末尾标记'));
});

test('边界：非法/空 tag 处理（空串按无 tag，特殊字符原样存）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const emptyTag = await reg.call('note_save', { text: '空标签', tag: '' });
  assert.equal(emptyTag.ok, true);
  assert.equal(emptyTag.tag, null, '空串 tag 应归一为无标签');

  const weirdTag = await reg.call('note_save', { text: '怪异标签', tag: 'a/b:c#d' });
  assert.equal(weirdTag.ok, true);
  assert.equal(weirdTag.tag, 'a/b:c#d', '特殊字符 tag 应原样保留');

  const filtered = await reg.call('note_list', { tag: 'a/b:c#d' });
  assert.equal(filtered.total, 1, '按怪异 tag 应能过滤命中');
});

test('边界：存储文件损坏时回退为空而非抛错', async () => {
  const dir = freshDataDir();
  // 手动写入损坏的 JSON
  fs.writeFileSync(path.join(dir, 'notes.json'), '{ this is not valid json,,', 'utf8');

  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const listed = await reg.call('note_list', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.total, 0, '损坏文件应安全回退为空');

  const saved = await reg.call('note_save', { text: '损坏后新建' });
  assert.equal(saved.ok, true);
  const after = await reg.call('note_list', {});
  assert.equal(after.total, 1, '损坏恢复后应能正常写入并读出');
});

// ---------------------------------------------------------------------------
// 提醒功能：store / 工具解析 / 路由 / 调度器
// ---------------------------------------------------------------------------

test('提醒：note_save 接受未来 remindAt 并落盘 remindAt/notified=false', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const future = Date.now() + 60_000;
  const saved = await reg.call('note_save', { text: '开会', remindAt: future, tag: 'work' });
  assert.equal(saved.ok, true);
  assert.equal(typeof saved.remindAt, 'number');
  assert.ok(saved.remindAt >= future - 1, '应回传 remindAt');

  // store 层可查到待提醒（未来时间 → 不在 pending，在 upcoming）
  const store = require('../dist/store.js');
  const upcoming = store.upcomingReminders(10);
  assert.equal(upcoming.length, 1, '未来提醒应出现在即将到来列表');
  assert.equal(upcoming[0].notified, false, '未触发时应 notified=false');
});

test('提醒：note_save 拒绝过去/非法 remindAt（忽略提醒，不污染数据）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const past = await reg.call('note_save', { text: '已过期', remindAt: Date.now() - 1000 });
  assert.equal(past.ok, true);
  assert.equal(past.remindAt, null, '过去时间应忽略 remindAt');

  const bad = await reg.call('note_save', { text: '非法', remindAtISO: 'not-a-date' });
  assert.equal(bad.ok, true);
  assert.equal(bad.remindAt, null, '非法 ISO 应忽略 remindAt');

  const store = require('../dist/store.js');
  assert.equal(store.pendingReminders(Date.now()).length, 0, '无待提醒项');
});

test('提醒：pendingReminders 只返回到期且未 notified 的项；markNotified 去重', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  // 直接写一条已到期的备忘（remindAt 在过去）
  store.saveNote('到期提醒', 'work', Date.now() - 1000);
  const due = store.pendingReminders(Date.now());
  assert.equal(due.length, 1, '到期未通知应被捞回');

  const ok = store.markNotified(due[0].id);
  assert.equal(ok, true, '首次 ack 应成功');
  assert.equal(store.pendingReminders(Date.now()).length, 0, 'ack 后不再出现');

  // 重复 ack 幂等
  const ok2 = store.markNotified(due[0].id);
  assert.equal(ok2, false, '重复 ack 应返回 false（无变更）');
});

test('提醒：路由 /reminders 返回 pending+upcoming；/reminders/ack 标记', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  store.saveNote('即将开会', 'work', Date.now() + 30_000);
  store.saveNote('昨晚的事', 'life', Date.now() - 60_000);

  const ext = plugin.memoServerExtension;
  const base = 'http://localhost';
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

  // GET /reminders
  {
    const c = collect();
    await ext.mountRoutes['/reminders'](mkReq('/reminders', 'GET'), c.res);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.upcoming.length, 1, 'upcoming 应含未来提醒');
    assert.equal(c.obj.pending.length, 1, 'pending 应含到期提醒');
  }

  // POST /reminders/ack?id=...
  {
    const dueId = store.pendingReminders(Date.now())[0].id;
    const c = collect();
    await ext.mountRoutes['/reminders/ack'](mkReq(`/reminders/ack?id=${dueId}`, 'POST'), c.res);
    assert.equal(c.obj.ok, true);
    assert.equal(c.obj.notified, true, 'ack 应落盘');
    assert.equal(store.pendingReminders(Date.now()).length, 0, 'ack 后 pending 清空');
  }
});

test('提醒：调度器到点 fire 一次（进程内去重）+ 重启自然补发（靠 pendingReminders）', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const ReminderScheduler = require('../dist/reminder-scheduler.js').ReminderScheduler;

  let fires = 0;
  const alerts = [];
  const logger = { info() {}, warn() {} };
  const sched = new ReminderScheduler(
    () => { fires++; },
    (e) => alerts.push(e),
    logger
  );

  // 写一条已到期提醒
  store.saveNote('到点提醒', 'work', Date.now() - 1000);

  // 立即触发一次：应 fire 一次
  await sched.triggerNow();
  assert.equal(fires, 1, '到期未通知项应 fire 一次');
  assert.equal(alerts.length, 0, '正常 fire 不应走 alert 通道');

  // 再次触发：进程内去重，不应重复 fire
  await sched.triggerNow();
  assert.equal(fires, 1, '进程内已 fire 过的 id 不应重复触发');

  // 「重启」语义：本进程 firedThisProcess 是内存态，但 store 层 pendingReminders 仍会捞回
  // （只要前端未 ack 落盘）。这里模拟「前端未 ack」：pending 仍在，新进程会再次 fire。
  assert.equal(store.pendingReminders(Date.now()).length, 1, '未 ack 时，重启后 pending 仍可被捞回（天然补发）');

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
  store.saveNote('会失败', 'x', Date.now() - 1000);
  store.saveNote('会成功', 'y', Date.now() - 1000);

  await sched.triggerNow();
  // 两项都到期：fire 对第一项抛错被捕获，第二项仍执行（fire 计数含失败的也调用了）
  assert.equal(fires, 2, '两项都应被 fire（失败不阻断后续）');
  assert.equal(alerts.length, 2, '两条都失败应各走一次 alert 通道');
  sched.stop();
});

test('提醒：前端视图形状新增「待提醒」卡（渲染含 --ah- 令牌）', () => {
  const store = require('../dist/store.js');
  store.saveNote('看板提醒', 'idea', Date.now() + 120_000);
  const view = plugin.memoBoardView;
  const html = view.render();
  assert.ok(typeof html === 'string');
  assert.ok(html.includes('待提醒'), '看板应包含「待提醒」区块');
  assert.ok(html.includes('--ah-'), '样式应使用 --ah-* 主题令牌');
});

// ---------------------------------------------------------------------------
// 提醒历史：错过通知窗口后的可回查能力
// ---------------------------------------------------------------------------

test('提醒历史：ack 时落盘 notifiedAt，reminderHistory 按确认时间倒序返回', () => {
  freshDataDir();
  const store = require('../dist/store.js');
  // 三条都已触发并被 ack（notified 由 markNotified 置位，同时写入 notifiedAt）
  const a = store.saveNote('第一条', 'work', Date.now() - 300_000);
  const b = store.saveNote('第二条', 'work', Date.now() - 200_000);
  const c = store.saveNote('第三条', 'life', Date.now() - 100_000);
  store.markNotified(a.id);
  store.markNotified(b.id);
  store.markNotified(c.id);

  const hist = store.reminderHistory(20);
  assert.equal(hist.length, 3, '三条已 ack 的提醒都应进入历史');
  // 倒序：最近 ack 的在前
  assert.equal(hist[0].id, c.id, '最近确认的应排最前');
  assert.equal(hist[2].id, a.id, '最早确认的应排最后');
  for (const n of hist) {
    assert.equal(typeof n.notifiedAt, 'number', 'ack 应写入 notifiedAt 时间戳');
  }
});

test('提醒历史：未 ack 的项不进历史；pending/upcoming 也不混入历史', () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const pending = store.saveNote('到期未 ack', 'work', Date.now() - 1000);
  const upcoming = store.saveNote('将来才提醒', 'work', Date.now() + 60_000);
  const done = store.saveNote('已确认', 'work', Date.now() - 5000);
  store.markNotified(done.id);

  const hist = store.reminderHistory(20);
  assert.equal(hist.length, 1, '只有已 ack 的才进历史');
  assert.equal(hist[0].id, done.id);
  assert.ok(!hist.some((n) => n.id === pending.id), '到期未 ack 不应进历史');
  assert.ok(!hist.some((n) => n.id === upcoming.id), '未到期不应进历史');
});

test('提醒历史：无 remindAt 的普通备忘不会误入历史', () => {
  freshDataDir();
  const store = require('../dist/store.js');
  store.saveNote('纯备忘无提醒', 'idea');
  assert.equal(store.reminderHistory(20).length, 0, '无 remindAt 的备忘不应出现在历史');
});

test('提醒历史：兼容无 notifiedAt 的旧数据（回退 remindAt 排序仍可见）', () => {
  const dir = freshDataDir();
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  // 模拟旧版本落盘形态：只有 notified 标志，没有 notifiedAt 字段
  const old = [
    {
      id: 'legacy-1',
      text: '旧数据提醒',
      tag: 'work',
      createdAt: Date.now() - 600_000,
      remindAt: Date.now() - 500_000,
      notified: true,
    },
  ];
  fs2.writeFileSync(path2.join(dir, 'notes.json'), JSON.stringify(old), 'utf8');

  const store = require('../dist/store.js');
  const hist = store.reminderHistory(20);
  assert.equal(hist.length, 1, '旧数据（无 notifiedAt）也应出现在历史里');
  assert.equal(hist[0].id, 'legacy-1');
});

test('提醒：路由 /reminders 额外返回 history 字段', async () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const done = store.saveNote('已提醒的', 'work', Date.now() - 10_000);
  store.markNotified(done.id);

  const ext = plugin.memoServerExtension;
  let body = '';
  const res = {
    statusCode: 0,
    setHeader() {},
    end(b) {
      body = b;
    },
  };
  await ext.mountRoutes['/reminders']({ url: '/reminders', method: 'GET' }, res);
  const data = JSON.parse(body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.history), 'history 应为数组');
  assert.equal(data.history.length, 1, 'history 应含已触发的提醒');
  assert.equal(data.history[0].id, done.id);
  assert.equal(typeof data.history[0].notifiedAt, 'number', 'history 项应带 notifiedAt');
});

test('提醒：前端看板新增「提醒历史」区块（渲染含 --ah- 令牌）', () => {
  freshDataDir();
  const store = require('../dist/store.js');
  const done = store.saveNote('历史提醒', 'work', Date.now() - 30_000);
  store.markNotified(done.id);

  const html = plugin.memoBoardView.render();
  assert.ok(html.includes('提醒历史'), '看板应包含「提醒历史」区块');
  assert.ok(html.includes('历史提醒'), '历史条目内容应被渲染');
  assert.ok(html.includes('--ah-'), '样式应使用 --ah-* 主题令牌');
});

