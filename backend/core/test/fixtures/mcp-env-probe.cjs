// 最小 MCP stdio server（协议级，零 SDK 依赖）——env 继承探测用。
// 把父进程注入的自定义环境变量 process.env.MCP_PROBE_VAR 暴露进工具名：
//   tools/list 返回 [{ name: `probe_<value>` }]。
// 用于验证 connectMcpClient 的 `env ?? process.env` 兜底（SDK 1.30 默认只继承 sudo 白名单 env）。
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || msg.jsonrpc !== '2.0' || msg.id === undefined) return; // notification 不回
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'env-probe', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    const val = process.env.MCP_PROBE_VAR ?? 'NONE';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: `probe_${val}`, description: 'env inheritance probe', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    });
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
