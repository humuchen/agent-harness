'use strict';
// 运行队列持久化后端测试（业务层，零依赖）：覆盖 Memory / File 后端的
// append/list/ack/clear 语义，以及 RunQueue + File 后端的启动重放。
// 仅依赖 node 内置模块；运行前需 `pnpm --filter @agent-harness/ui run build` 产 dist。
//
// 用「dist 不存在则跳过并显式 fail」的方式，避免静默跳过掩盖构建缺失。

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BACKEND_JS = path.join(__dirname, '..', 'dist', 'queue-backend.js');
const RUNQUEUE_JS = path.join(__dirname, '..', 'dist', 'run-queue.js');
const RUN = fs.existsSync(BACKEND_JS);

function loadBackend() {
  return require(BACKEND_JS);
}
function tmpDir() {
  const dir = path.join(os.tmpdir(), `qb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('MemoryQueueBackend: append/list/ack/clear', { skip: !RUN }, async () => {
  const { MemoryQueueBackend } = loadBackend();
  const b = new MemoryQueueBackend();
  assert.strictEqual(b.kind, 'memory');
  await b.append({ id: 'a', mode: 'mock', prompt: 'p1', enqueuedAt: 1 });
  await b.append({ id: 'b', mode: 'real', prompt: 'p2', sessionKey: 's1', enqueuedAt: 2 });
  let all = await b.list();
  assert.strictEqual(all.length, 2);
  await b.ack('a');
  all = await b.list();
  assert.deepStrictEqual(all.map((d) => d.id), ['b']);
  await b.clear();
  assert.strictEqual((await b.list()).length, 0);
});

test('FileQueueBackend: 追加写持久化 + ack 移除 + 坏行鲁棒', { skip: !RUN }, async () => {
  const { FileQueueBackend } = loadBackend();
  const file = path.join(tmpDir(), 'run-queue.jsonl');
  const b = new FileQueueBackend({ file });
  assert.strictEqual(b.kind, 'file');
  await b.append({ id: 'a', mode: 'mock', prompt: 'p1', enqueuedAt: 1 });
  await b.append({ id: 'b', mode: 'real', prompt: 'p2', sessionKey: 's', enqueuedAt: 2 });

  // 新实例从同一文件加载 → 持久化跨进程（重启）有效
  const b2 = new FileQueueBackend({ file });
  let all = await b2.list();
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((d) => d.id).sort(), ['a', 'b']);

  // ack 后重写文件，b2 再列应只剩 a
  await b2.ack('b');
  const b3 = new FileQueueBackend({ file });
  all = await b3.list();
  assert.deepStrictEqual(all.map((d) => d.id), ['a']);

  // 坏行/半截行：手动追加一行非法 JSON，加载时应当丢弃而不报错（崩溃安全）
  fs.appendFileSync(file, 'this is not json\n');
  const b4 = new FileQueueBackend({ file });
  all = await b4.list();
  assert.deepStrictEqual(all.map((d) => d.id), ['a']);
});

test('RunQueue + FileQueueBackend: 启动重放未开始任务并清空持久层', { skip: !RUN }, async () => {
  const { FileQueueBackend } = loadBackend();
  const { RunQueue } = require(RUNQUEUE_JS);
  const file = path.join(tmpDir(), 'run-queue.jsonl');
  // 预置一条未开始任务到持久层（模拟「上次进程崩溃遗留」）
  const b = new FileQueueBackend({ file });
  await b.append({ id: 'old1', mode: 'mock', prompt: 'replay-me', sessionKey: 'sX', enqueuedAt: 100 });

  // 构造 RunQueue 时传入同一后端 → 应自动重放
  const q = new RunQueue(b);
  // 重放是异步的（读文件 → 入队 → 清空），等一小段时间
  await new Promise((r) => setTimeout(r, 80));
  const jobs = q.list();
  assert.ok(jobs.some((j) => j.prompt === 'replay-me'), '重放后队列应包含持久化的未开始任务');

  // 持久层应被清空，避免下次重启重复执行
  const remaining = await b.list();
  assert.strictEqual(remaining.length, 0, '重放后持久层应清空');
});

// dist 未构建时给出明确失败提示，而非静默跳过整个套件。
test('dist 未构建时显式提示', { skip: RUN }, () => {
  assert.fail('packages/ui/dist/queue-backend.js 不存在：请先 `pnpm --filter @agent-harness/ui run build` 再跑本测试');
});
