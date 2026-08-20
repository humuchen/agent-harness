// 集成测试：MCP stdio 子进程应继承父进程「顶层自定义 env」（connectMcpClient 的 `env ?? process.env` 兜底）。
//
// 背景：MCP SDK 1.30 的 StdioClientTransport 在未显式传 env 时只继承「sudo 白名单」环境变量
// （PATH/HOME/LANG…），自定义顶层 env（如 RAG_TRANSPORT、MCP_PROBE_VAR）不会被 stdio server 子进程继承，
// 导致其以错误模式启动（曾使外部 RAG 落入 HTTP 模式、stdout 污染 MCP 通道）。
// 本测试在 MCP_SERVERS 条目**不带 env 字段**的前提下，验证子进程仍能读到顶层 MCP_PROBE_VAR：
//   - 修复前：子进程工具名为 probe_NONE → registry.has('probe__probe_top-level-var') 为 false → 失败
//   - 修复后：子进程工具名为 probe_top-level-var → 通过
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ToolRegistry } = require('../dist/tools.js');
const { parseMcpServersEnv, connectMcpServers, disconnectAllMcp } = require('../dist/integrations/mcp/placeholder.js');

test('MCP stdio 子进程继承顶层自定义 env（MCP_SERVERS 条目无 env 字段）', async () => {
  const probeBin = path.join(__dirname, 'fixtures', 'mcp-env-probe.cjs');
  process.env.MCP_PROBE_VAR = 'top-level-var';
  process.env.MCP_SERVERS = JSON.stringify([{ name: 'probe', command: 'node', args: [probeBin] }]);
  const registry = new ToolRegistry();
  try {
    const configs = parseMcpServersEnv();
    assert.equal(configs.length, 1);
    assert.equal(configs[0].env, undefined, '条目未显式提供 env，验证顶层继承');

    const metas = await connectMcpServers(registry, configs);
    assert.equal(metas[0].status, 'connected', 'stdio server 应连接成功');
    assert.ok(
      registry.has('probe__probe_top-level-var'),
      `子进程应继承顶层 MCP_PROBE_VAR（实际工具名: ${registry.schemas().map((s) => s.name).join(', ') || '(无)'}）`
    );
    assert.equal(registry.has('probe__probe_NONE'), false, '不应退化为未继承（NONE）');
  } finally {
    await disconnectAllMcp();
    delete process.env.MCP_PROBE_VAR;
    delete process.env.MCP_SERVERS;
  }
});
