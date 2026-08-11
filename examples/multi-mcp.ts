/**
 * 多 MCP server 接入演练。
 *
 * 演示「一个 Agent + 多个 MCP 服务」的真实形态：
 *   - 配置来源统一走 core 的 parseMcpServersEnv()：优先读 MCP_SERVERS（JSON 数组，
 *     每个 server 可独立带 transport / command / args / headers），否则退回 MCP_SERVER_URL。
 *   - 用 connectMcpServers() 顺序接入，每个 server 失败都不影响其余。
 *   - 工具按 `<server>__<tool>` 前缀注册，自动避免命名冲突，护栏/记忆/追踪照常生效。
 *   - 运行结束后调用 disconnectAllMcp() 清理所有连接（与 UI 进程退出时的清理同一条路径）。
 *
 * 运行：pnpm --filter @agent-harness/examples run mcp:multi
 * 自包含默认值：未配置任何 MCP 环境变量时，使用示例（context7 远程 + 本地 filesystem stdio）。
 */
import path from 'node:path';
import {
  AgentHarness,
  ToolRegistry,
  createOpenRouterLLM,
  parseMcpServersEnv,
  connectMcpServers,
  disconnectAllMcp,
  loadEnv,
} from '@agent-harness/core';
import type { LLM } from '@agent-harness/core';

loadEnv();

async function main(): Promise<void> {
  const tools = new ToolRegistry();

  // 1) 解析多 server 配置：MCP_SERVERS 优先，否则 MCP_SERVER_URL，二者皆无则给演示默认值。
  let configs = parseMcpServersEnv();
  if (configs.length === 0) {
    configs = [
      { name: 'context7', serverUrl: 'https://mcp.context7.com/mcp' },
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', path.resolve(process.cwd())],
      },
    ];
    console.log('[multi-mcp] 未检测到 MCP 环境变量，使用示例默认配置（context7 + filesystem）');
  }

  // 2) 顺序接入每个 server（单个失败不影响其余）。
  const metas = await connectMcpServers(tools, configs);
  for (const m of metas) {
    console.log(
      `  - ${m.name}: ${m.status} (${m.tools.length} tools)` + (m.error ? ` — ${m.error}` : '')
    );
  }
  console.log(`[multi-mcp] 已注册 ${tools.schemas().length} 个工具到共享 ToolRegistry`);

  // 3) 真实/ Mock LLM 驱动。
  const llm: LLM = process.env.OPENROUTER_API_KEY
    ? createOpenRouterLLM()
    : (async (_m, _t) => ({
        content:
          '（mock）多 MCP server 已按上方日志接入；填入 OPENROUTER_API_KEY 后由真实模型驱动工具调用。',
        tool_calls: [],
      }));

  const agent = new AgentHarness({
    llm,
    tools,
    systemPrompt:
      '你是多工具助手。可用工具来自多个 MCP server，名字带 <server>__ 前缀。' +
      '需要时调用 filesystem 读写文件、用 context7 查询库文档。',
  });

  const answer = await agent.run('列出当前目录下的文件，并告诉我 typescript 这个库的 Context7 库 ID。');
  console.log('\n=== 最终回复 ===\n' + answer);

  // 4) 演示连接生命周期清理（UI 在 SIGINT/SIGTERM 时也走这条路径）。
  await disconnectAllMcp();
  console.log('\n[multi-mcp] 已 disconnectAllMcp()，所有 MCP 连接已清理。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
