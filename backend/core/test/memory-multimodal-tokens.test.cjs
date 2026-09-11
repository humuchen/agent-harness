'use strict';
/**
 * 记忆淘汰层的多模态回归测试。
 *
 * 修复的缺陷：`historyTokens()` 走 `messageText()` 只抽 text 块，图片块一律记 0；
 * 且瘦身循环用 `typeof m.content !== 'string'` 直接跳过图片消息。二者叠加的后果是
 * 「历史图片每轮按视觉 token 真实计费，却既不参与计数、也不参与瘦身」——
 * 超大含图历史永远收敛不到预算，只能一路切旧轮次或最终 400。
 */
const test = require('node:test');
const assert = require('node:assert');
const { Memory } = require('../dist/memory.js');

const SHRUNK_MARK = '【上下文压缩·原内容已省略】';

function pngDataUrl(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return 'data:image/png;base64,' + b.toString('base64');
}

/** 一张 1024×768 的图按 2×2 图块计 = 85 + 680 = 765 tokens。 */
const IMG_TOKENS = 765;

test('historyTokens 计入图片视觉 token，而非记为 0', () => {
  const m = new Memory({ maxWindow: 20 });
  const url = pngDataUrl(1024, 768);
  m.add({
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url } }
    ]
  });
  const t = m.historyTokens();
  assert.ok(t >= IMG_TOKENS, `含图历史应计入视觉 token，实际 ${t}`);
});

test('仅有图片的历史不再被视为 0 占用', () => {
  const m = new Memory({ maxWindow: 20 });
  m.add({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: pngDataUrl(1024, 768) } }]
  });
  assert.ok(m.historyTokens() >= IMG_TOKENS, '图片块不应被记为 0');
});

test('fitToBudget 能把图片块瘦身为文本占位并真实降低占用', () => {
  const m = new Memory({ maxWindow: 20 });
  m.add({
    role: 'user',
    content: [
      { type: 'text', text: '这是一段很长的用户输入，用于确保消息本身具有可被压缩的体积。' },
      { type: 'image_url', image_url: { url: pngDataUrl(1024, 768) } }
    ]
  });
  const before = m.historyTokens();
  assert.ok(before > 200, `前置条件：占用应高于预算，实际 ${before}`);

  const changed = m.fitToBudget(200);
  assert.equal(changed, true, '应发生压缩');
  const after = m.historyTokens();
  assert.ok(after < before, `占用应下降：${before} → ${after}`);

  const msg = m.history()[0];
  assert.equal(typeof msg.content, 'string', '瘦身后应落为纯文本占位');
  assert.ok(msg.content.includes(SHRUNK_MARK), '应带压缩标记');
  assert.ok(msg.content.includes('1 张图片'), `应说明图片数量，实际：${msg.content}`);
});

test('含图片的工具消息瘦身后仍保留 tool_call_id 与 name（配对不破）', () => {
  const m = new Memory({ maxWindow: 20 });
  const url = pngDataUrl(1024, 768);
  m.add({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url } }]
  });
  m.add({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', name: 'screenshot', arguments: {} }]
  });
  m.add({
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'screenshot',
    content: [{ type: 'image_url', image_url: { url } }]
  });

  m.fitToBudget(200);

  const kept = m.history();
  const assistant = kept.find((x) => x.role === 'assistant');
  const tool = kept.find((x) => x.role === 'tool');
  assert.ok(assistant, 'assistant 消息不应被删除');
  assert.ok(tool, 'tool 结果不应被删除');
  assert.equal(tool.tool_call_id, 'call_1', 'tool_call_id 必须原样保留');
  assert.equal(tool.name, 'screenshot', 'name 必须原样保留');
  assert.ok(
    Array.isArray(assistant.tool_calls) && assistant.tool_calls[0].id === 'call_1',
    'assistant.tool_calls 必须原样保留'
  );
});

test('瘦身幂等：反复调用不会二次改写或反复标记', () => {
  const m = new Memory({ maxWindow: 20 });
  m.add({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: pngDataUrl(1024, 768) } }]
  });
  assert.equal(m.fitToBudget(200), true);
  const once = m.history()[0].content;
  assert.equal(m.fitToBudget(200), false, '已达标后不应再报告压缩');
  assert.equal(m.history()[0].content, once, '内容不应被二次改写');
});

test('存在纯文本候选时优先瘦身文本，不动图片', () => {
  // 构造「全窗同属最后一组」的窗口（assistant + 其 tool 结果），使组对齐淘汰
  // 无法切任何东西，从而把测试焦点完全放在瘦身的候选优先级上。
  const m = new Memory({ maxWindow: 20 });
  const url = pngDataUrl(1024, 768);
  m.add({
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', name: 'read_log', arguments: {} },
      { id: 'call_2', name: 'screenshot', arguments: {} }
    ]
  });
  m.add({ role: 'tool', tool_call_id: 'call_1', name: 'read_log', content: 'A'.repeat(20000) });
  m.add({
    role: 'tool',
    tool_call_id: 'call_2',
    name: 'screenshot',
    content: [{ type: 'image_url', image_url: { url } }]
  });

  // 预算取「压掉长文本即可达标」的量级，留出足够余量。
  assert.equal(m.fitToBudget(1000), true);

  const kept = m.history();
  const textTool = kept.find((x) => x.tool_call_id === 'call_1');
  const imageTool = kept.find((x) => x.tool_call_id === 'call_2');
  assert.equal(typeof textTool.content, 'string');
  assert.ok(textTool.content.includes(SHRUNK_MARK), '长文本工具结果应先被瘦身');
  assert.ok(
    Array.isArray(imageTool.content),
    '达标即停：有文本候选时不应把图片换成占位'
  );
});

test('无文本候选时才把图片瘦身为占位（同组内仍保留配对）', () => {
  const m = new Memory({ maxWindow: 20 });
  const url = pngDataUrl(1024, 768);
  m.add({
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', name: 'read_log', arguments: {} },
      { id: 'call_2', name: 'screenshot', arguments: {} }
    ]
  });
  m.add({ role: 'tool', tool_call_id: 'call_1', name: 'read_log', content: 'A'.repeat(20000) });
  m.add({
    role: 'tool',
    tool_call_id: 'call_2',
    name: 'screenshot',
    content: [{ type: 'image_url', image_url: { url } }]
  });

  // 预算远低于「仅压文本」的残留量，迫使图片也参与瘦身。
  assert.equal(m.fitToBudget(300), true);

  const kept = m.history();
  const imageTool = kept.find((x) => x.tool_call_id === 'call_2');
  assert.equal(typeof imageTool.content, 'string');
  assert.ok(imageTool.content.includes(SHRUNK_MARK), '图片块应被替换为压缩占位');
  assert.ok(imageTool.content.includes('1 张图片'), `应说明图片数量：${imageTool.content}`);
  assert.equal(imageTool.name, 'screenshot', 'name 必须原样保留');
  assert.ok(kept.some((x) => x.tool_call_id === 'call_1'), '同组其它 tool 结果必须保留');
});
