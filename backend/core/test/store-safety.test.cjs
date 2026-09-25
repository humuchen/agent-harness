'use strict';
// store-safety.ts 专用测试（P0-1 补齐）。
// 覆盖 quarantineCorruptFile 的核心行为：坏文件隔离改名、告警、空状态继续。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { after } = require('node:test');

const { quarantineCorruptFile } = require('../dist/store-safety.js');

// 创建临时目录用于测试
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-safety-test-'));

test('损坏文件被隔离改名（.corrupt-<ts> 后缀）', () => {
  const filePath = path.join(tmpDir, 'memory-test-1.json');
  fs.writeFileSync(filePath, '{ broken json');
  assert.ok(fs.existsSync(filePath));

  const result = quarantineCorruptFile(filePath, 'memory', new Error('Unexpected token'));

  // 返回隔离路径
  assert.ok(result !== null);
  assert.ok(result.startsWith(filePath + '.corrupt-'));
  // 原文件不再存在
  assert.ok(!fs.existsSync(filePath));
  // 隔离文件存在
  assert.ok(fs.existsSync(result));
  // 隔离文件内容与原文件一致（保留现场供人工恢复）
  assert.strictEqual(fs.readFileSync(result, 'utf8'), '{ broken json');
});

test('文件不存在时返回 null（不误报，不创建文件）', () => {
  const filePath = path.join(tmpDir, 'nonexistent.json');
  assert.ok(!fs.existsSync(filePath));

  const result = quarantineCorruptFile(filePath, 'memory', new Error('no such file'));

  assert.strictEqual(result, null);
  // 不应创建任何文件
  assert.ok(!fs.existsSync(filePath));
  assert.ok(!fs.existsSync(filePath + '.corrupt-123'));
});

test('多次隔离同一逻辑路径时生成不同时间戳后缀', () => {
  const filePath = path.join(tmpDir, 'memory-test-2.json');
  fs.writeFileSync(filePath, 'garbage 1');
  quarantineCorruptFile(filePath, 'memory', new Error('parse error 1'));

  // 重新写入（模拟「写入新数据后又损坏」场景）
  fs.writeFileSync(filePath, 'garbage 2');
  // 确保时间戳不同
  const oldTime = Date.now();
  while (Date.now() === oldTime) { /* spin until clock advances */ }

  const result2 = quarantineCorruptFile(filePath, 'memory', new Error('parse error 2'));
  assert.ok(result2 !== null);
  assert.ok(result2.includes('.corrupt-'));
  assert.ok(!fs.existsSync(filePath));
  assert.ok(fs.existsSync(result2));
});

test('不同 store 标识都能正常工作', () => {
  const stores = ['memory', 'workflow', 'agents', 'rag', 'custom-store'];
  for (const store of stores) {
    const filePath = path.join(tmpDir, `${store}-test.json`);
    fs.writeFileSync(filePath, 'not json');
    const result = quarantineCorruptFile(filePath, store, new Error(`${store} corrupted`));
    assert.ok(result !== null, `store=${store} should quarantine`);
    assert.ok(!fs.existsSync(filePath), `store=${store} original should be gone`);
    assert.ok(fs.existsSync(result), `store=${store} quarantined file should exist`);
  }
});

test('隔离后调用方可继续以「空状态」运行（不抛异常）', () => {
  const filePath = path.join(tmpDir, 'memory-safe-continue.json');
  fs.writeFileSync(filePath, 'totally broken');

  // quarantineCorruptFile 不应抛异常
  assert.doesNotThrow(() => {
    quarantineCorruptFile(filePath, 'memory', new Error('JSON.parse failed'));
  });

  // 原文件已被隔离，调用方可以重新写入「空状态」数据
  fs.writeFileSync(filePath, '{}');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(data, {});
});

// 清理临时文件
after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});
