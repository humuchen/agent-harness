import { ToolRegistry } from '@agent-harness/core';
import { connectMcpServer, disconnectAllMcp, type McpServerMeta } from '@agent-harness/core';

/**
 * MCP 服务的运行时管理器（单例）。
 *
 * - 持有一个共享 ToolRegistry，存放所有已接入 MCP 服务的工具（按服务前缀避免冲突），
 *   供每次 Agent 运行合并使用。
 * - 启动时从环境变量加载服务：
 *    - `MCP_SERVERS`：JSON 数组，形如 [{"name":"context7","url":"...","headers":{...}}]
 *    - `MCP_SERVER_URL`：单服务快捷配置，默认命名为 "context7"
 * - 运行时可通过 `addServer` 逐步添加更多服务（对应「后续逐步添加」的诉求）。
 */
class McpManager {
  private registry = new ToolRegistry();
  private servers: McpServerMeta[] = [];
  private initialized = false;

  /** 启动连接：从环境变量加载并接入所有已配置服务（不阻塞调用方）。 */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const list = this.envServers();
    // 顺序连接，避免并发握手压垮免费服务；连接进度实时反映到 servers 列表。
    (async () => {
      for (const s of list) {
        const meta = await connectMcpServer(this.registry, {
          name: s.name,
          serverUrl: s.url,
          headers: s.headers,
        });
        this.servers.push(meta);
      }
    })().catch((e) => console.error('[mcp-manager] init error:', e));
  }

  /** 运行时新增一个 MCP 服务，返回其连接元数据。 */
  async addServer(name: string, url: string, headers?: Record<string, string>): Promise<McpServerMeta> {
    const clean = name.trim() || this.slug(url);
    const meta = await connectMcpServer(this.registry, { name: clean, serverUrl: url, headers });
    // 同名服务则覆盖旧条目。
    const idx = this.servers.findIndex((s) => s.name === clean);
    if (idx >= 0) this.servers[idx] = meta;
    else this.servers.push(meta);
    return meta;
  }

  list(): McpServerMeta[] {
    return this.servers;
  }

  /** 当前所有 MCP 工具所在的共享注册表（供 Agent 运行合并）。 */
  liveRegistry(): ToolRegistry {
    return this.registry;
  }

  /** 关闭所有已接入的 MCP 连接（进程退出时调用）。 */
  async shutdown(): Promise<void> {
    await disconnectAllMcp().catch(() => {});
    this.servers = [];
  }

  private envServers(): { name: string; url: string; headers?: Record<string, string> }[] {
    const out: { name: string; url: string; headers?: Record<string, string> }[] = [];
    const raw = process.env.MCP_SERVERS;
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const s of arr) {
            if (s && s.url) {
              out.push({ name: s.name || this.slug(s.url), url: s.url, headers: s.headers });
            }
          }
        }
      } catch {
        /* 忽略损坏的 JSON */
      }
    }
    const single = process.env.MCP_SERVER_URL;
    if (single && !out.some((s) => s.url === single)) {
      out.push({ name: 'context7', url: single });
    }
    return out;
  }

  private slug(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname.replace(/[^a-zA-Z0-9]/g, '_');
    } catch {
      return 'mcp';
    }
  }
}

export const mcpManager = new McpManager();
