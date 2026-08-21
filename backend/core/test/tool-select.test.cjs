'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { selectToolsForInput } = require('../dist/tools.js');

const ALL = [
  { name: 'send_message', description: '发送消息给用户', parameters: {} },
  { name: 'read_file', description: '读取文件内容', parameters: {} },
  { name: 'write_code', description: '生成或修改源代码', parameters: {} },
  { name: 'run_tests', description: '运行测试套件验证代码', parameters: {} },
  { name: 'query_database', description: '查询数据库记录', parameters: {} },
];

test('问候类短输入返回空子集（降低固定开销）', () => {
  const out = selectToolsForInput(ALL, '你好', {});
  assert.deepStrictEqual(out, []);
});

test('空输入仅返回硬允许集', () => {
  const out = selectToolsForInput(ALL, '', { allowTools: ['send_message'] });
  assert.deepStrictEqual(out.map((t) => t.name), ['send_message']);
});

test('代码相关查询命中代码类工具', () => {
  const out = selectToolsForInput(ALL, '帮我写一段代码并运行测试', { topK: 8 });
  const names = out.map((t) => t.name);
  assert.ok(names.includes('write_code'), `应包含 write_code，实际 ${JSON.stringify(names)}`);
  assert.ok(names.includes('run_tests'), `应包含 run_tests，实际 ${JSON.stringify(names)}`);
});

test('allowTools 硬允许始终保留且优先', () => {
  const out = selectToolsForInput(ALL, '你好', { allowTools: ['query_database'] });
  assert.deepStrictEqual(out.map((t) => t.name), ['query_database']);
});

test('topK 限制返回数量', () => {
  const out = selectToolsForInput(ALL, '代码 文件 数据库 测试 消息', { topK: 2, allowTools: [] });
  assert.ok(out.length <= 2, `应不超过 topK，实际 ${out.length}`);
});
