// 覆盖 MCP 工具调用前的「必填参数」预检（missingRequiredArgs）。
// 直接 require 编译后的叶子模块，避免引入 MCP SDK 运行时依赖。
const test = require('node:test');
const assert = require('node:assert');

const { missingRequiredArgs } = require('../dist/integrations/mcp/placeholder.js');

// 官方 @modelcontextprotocol/server-filesystem 的 write_file inputSchema
const WRITE_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path to the file' },
    content: { type: 'string', description: 'Content to write' },
  },
  required: ['path', 'content'],
};

test('write_file 漏传 content 时被判定缺失', () => {
  assert.deepStrictEqual(missingRequiredArgs(WRITE_FILE_SCHEMA, { path: 'a.txt' }), ['content']);
});

test('write_file content 为空字符串 "" 时视为合法（不缺失）', () => {
  assert.deepStrictEqual(missingRequiredArgs(WRITE_FILE_SCHEMA, { path: 'a.txt', content: '' }), []);
});

test('write_file content 为 null 时判定缺失', () => {
  assert.deepStrictEqual(missingRequiredArgs(WRITE_FILE_SCHEMA, { path: 'a.txt', content: null }), ['content']);
});

test('write_file 参数整体为空对象时 path 与 content 均缺失', () => {
  assert.deepStrictEqual(missingRequiredArgs(WRITE_FILE_SCHEMA, {}), ['path', 'content']);
});

test('args 非对象（undefined）时所有 required 缺失', () => {
  assert.deepStrictEqual(missingRequiredArgs(WRITE_FILE_SCHEMA, undefined), ['path', 'content']);
});

test('schema 无 required 时永不报缺失', () => {
  assert.deepStrictEqual(missingRequiredArgs({ type: 'object', properties: {} }, {}), []);
  assert.deepStrictEqual(missingRequiredArgs(undefined, {}), []);
});

test('required 全部齐备时不报缺失', () => {
  assert.deepStrictEqual(
    missingRequiredArgs(WRITE_FILE_SCHEMA, { path: 'a.txt', content: 'hello' }),
    []
  );
});
