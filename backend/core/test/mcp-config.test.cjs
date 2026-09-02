// 零依赖测试（node:test + node:assert）：覆盖 MCP 服务清单的环境变量解析。
// 直接 require 编译后的叶子模块，避免引入 MCP SDK 运行时依赖。
const test = require('node:test');
const assert = require('node:assert');

const { parseMcpServersEnv } = require('../dist/integrations/mcp/placeholder.js');

test('无 MCP 环境变量时返回空数组', () => {
  assert.deepStrictEqual(parseMcpServersEnv({}), []);
});

test('仅 MCP_SERVER_URL 时退化为单 context7 配置', () => {
  const out = parseMcpServersEnv({ MCP_SERVER_URL: 'https://mcp.context7.com/mcp' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'context7');
  assert.strictEqual(out[0].serverUrl, 'https://mcp.context7.com/mcp');
  assert.strictEqual(out[0].transportType, undefined);
});

test('MCP_SERVERS JSON 解析多个 server（含 transport/command/args/headers）', () => {
  const env = {
    MCP_SERVERS: JSON.stringify([
      {
        name: 'context7',
        serverUrl: 'https://mcp.context7.com/mcp',
        transportType: 'streamable-http',
        headers: { CONTEXT7_API_KEY: 'abc' },
      },
      {
        name: 'fs',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
      },
    ]),
  };
  const out = parseMcpServersEnv(env);
  assert.strictEqual(out.length, 2);

  assert.strictEqual(out[0].name, 'context7');
  assert.strictEqual(out[0].serverUrl, 'https://mcp.context7.com/mcp');
  assert.strictEqual(out[0].transportType, 'streamable-http');
  assert.deepStrictEqual(out[0].headers, { CONTEXT7_API_KEY: 'abc' });

  assert.strictEqual(out[1].name, 'fs');
  assert.strictEqual(out[1].command, 'npx');
  assert.deepStrictEqual(out[1].args, ['-y', '@modelcontextprotocol/server-filesystem', '/data']);
});

test('MCP_SERVERS 缺 name 时回退为 url 的 slug', () => {
  const env = {
    MCP_SERVERS: JSON.stringify([{ serverUrl: 'https://mcp.context7.com/mcp' }]),
  };
  const out = parseMcpServersEnv(env);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'mcp_context7_com');
  assert.strictEqual(out[0].serverUrl, 'https://mcp.context7.com/mcp');
});

test('MCP_SERVERS 中缺 url 与 command 的条目被跳过', () => {
  const env = {
    MCP_SERVERS: JSON.stringify([{ name: 'bad' }, { name: 'ok', serverUrl: 'https://x/mcp' }]),
  };
  const out = parseMcpServersEnv(env);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'ok');
});

test('MCP_SERVERS 为损坏 JSON 时退回 MCP_SERVER_URL', () => {
  const env = {
    MCP_SERVERS: 'not-json{',
    MCP_SERVER_URL: 'https://mcp.context7.com/mcp',
  };
  const out = parseMcpServersEnv(env);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].serverUrl, 'https://mcp.context7.com/mcp');
});

test('MCP_SERVERS 与 MCP_SERVER_URL 共存时不重复追加', () => {
  const env = {
    MCP_SERVER_URL: 'https://mcp.context7.com/mcp',
    MCP_SERVERS: JSON.stringify([{ name: 'c7', serverUrl: 'https://mcp.context7.com/mcp' }]),
  };
  const out = parseMcpServersEnv(env);
  // URL 相同 => 不重复
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'c7');
});
