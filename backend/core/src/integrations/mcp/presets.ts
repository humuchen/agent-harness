import type { McpTransportType } from './placeholder';

/**
 * 远端 MCP 预设清单（开箱默认配置）。
 *
 * 让用户在「MCP 服务」面板一键接入主流公共 MCP，不必手动查 URL / 拼 headers。
 * 单一事实来源：core 定义，UI 直接消费，前端与静态演示页各自引用同一份数据。
 *
 * authType 决定前端是否展示 token 输入框，以及 headers 如何拼装：
 *   - 'none'    ：无需鉴权（或鉴权已 baked 进 URL）。
 *   - 'bearer'  ：传入 token 后拼 `Authorization: Bearer ${token}`，可选、GitHub/Composio 必填。
 *   - 'oauth'   ：走 OAuth 流程，token 同样以 Bearer 注入（此处仅做静态配置接入）。
 *   - 'header'  ：通用请求头（如 X-MCP-Toolsets），由调用方按服务说明提供。
 */

export type McpAuthType = 'none' | 'bearer' | 'oauth' | 'header';

export interface McpPreset {
  /** 稳定 id，同时作为接入后的服务名（serverName）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 默认接入端点（HTTP/SSE 远端服务器）。stdio 预设时留空。 */
  url?: string;
  /** 传输类型（auto 会按 URL 是否以 /sse 结尾自动判定）。stdio 预设时留空。 */
  transportType?: McpTransportType;
  /** stdio 启动命令（如 "uvx"、"npx"）。HTTP 预设时留空。 */
  command?: string;
  /** stdio 启动参数。HTTP 预设时留空。 */
  args?: string[];
  /** stdio 子进程环境变量。HTTP 预设时留空。 */
  env?: Record<string, string>;
  authType: McpAuthType;
  /** token 输入框的标签（如「GitHub PAT」）。 */
  authLabel?: string;
  /** token 输入框占位符。 */
  authPlaceholder?: string;
  /** stdio 预设时用于注入 token 的环境变量名（如 MODELSCOPE_API_TOKEN）。HTTP 预设时留空。 */
  authEnvVar?: string;
  /** 该服务可提供的核心能力（前端以 chip 展示）。 */
  capabilities: string[];
  /** 官方文档 / 注册页。 */
  docUrl?: string;
  /** 是否推荐（前端高亮）。 */
  recommended?: boolean;
  /** 补充说明（如「需在 xxx 复制专属 URL」）。 */
  note?: string;
  /**
   * 是否支持面板「一键接入」（默认 true）。
   * 设为 false 的预设不渲染接入按钮，
   * 改为引导用户复制专属 URL 走「自定义添加」，避免一键必失败。
   */
  oneClick?: boolean;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'context7',
    name: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    transportType: 'streamable-http',
    authType: 'bearer',
    authLabel: 'Context7 API Key（可选）',
    authPlaceholder: 'ctx7_...（可留空，免费档免 key）',
    capabilities: ['库文档', 'API 最新片段', 'TypeScript/Python/Rust 等'],
    docUrl: 'https://context7.com',
    recommended: true,
    note: '零配置即可用，专治 LLM 用陈旧训练数据。免 key 时直接接入。'
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    transportType: 'streamable-http',
    authType: 'bearer',
    authLabel: 'GitHub PAT',
    authPlaceholder: 'ghp_... 或 github_pat_...',
    capabilities: ['仓库', 'Issue', 'PR', 'Copilot Spaces'],
    docUrl: 'https://github.com/features/copilot',
    recommended: true,
    note: '需 GitHub Copilot 订阅 + 有效 PAT；接入时填写 PAT。国内网络可能无法访问 api.githubcopilot.com（此时会 fetch failed）。'
  },
  {
    id: 'composio',
    name: 'Composio',
    url: 'https://connect.composio.dev/mcp',
    transportType: 'streamable-http',
    authType: 'bearer',
    authLabel: 'Composio API Key',
    authPlaceholder: 'ck_...',
    capabilities: ['Gmail', 'Slack', 'Notion', 'Linear', '1000+ 集成'],
    docUrl: 'https://composio.dev',
    recommended: true,
    note: '单端点覆盖 1000+ 集成，治理/鉴权由 Composio 托管。'
  },
  {
    id: 'modelscope',
    name: 'ModelScope（魔塔）',
    command: 'uvx',
    args: ['modelscope-mcp-server'],
    authType: 'bearer',
    authLabel: 'ModelScope API Key',
    authPlaceholder: 'msa_...（从 modelscope.cn 获取）',
    authEnvVar: 'MODELSCOPE_API_TOKEN',
    capabilities: ['模型调用', '数据集检索', '社区资源'],
    docUrl: 'https://www.modelscope.cn/mcp',
    note: '需 ModelScope 账号 + API Key（在 modelscope.cn → 首页 → 访问令牌 获取）。一键接入会自动安装 uvx 模式的 stdio 服务器并注入密钥。'
  },
  {
    id: 'filesystem',
    name: 'Filesystem（文件系统）',
    command: 'node',
    args: ['access/server/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', process.cwd()],
    authType: 'none',
    capabilities: ['读写文件', '列目录', '搜索'],
    docUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    note: `本地 stdio 文件服务；默认授权目录为服务运行目录（${process.cwd()}）。一键接入会动态注入当前工作目录作为可访问根。`
  },
  {
    id: 'fetch',
    name: 'Fetch（网页抓取）',
    command: 'node',
    args: ['access/server/node_modules/@tokenizin/mcp-npx-fetch/dist/index.js'],
    authType: 'none',
    capabilities: ['抓取网页', '提取正文', '内容摘要'],
    docUrl: 'https://www.npmjs.com/package/@tokenizin/mcp-npx-fetch',
    note: '基于 tokenizin/mcp-npx-fetch 的网页抓取服务，将 URL 转换为可读取的 Markdown / 文本。'
  },
  {
    id: 'memory',
    name: 'Memory（知识记忆）',
    command: 'node',
    args: ['access/server/node_modules/@modelcontextprotocol/server-memory/dist/index.js'],
    authType: 'none',
    capabilities: ['持久知识图谱', '实体关系', '跨会话记忆'],
    docUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    note: '基于知识图谱的持久记忆服务，默认数据落在其工作目录（memory.json）。'
  },
  {
    id: 'excel',
    name: 'Excel（表格处理）',
    command: 'node',
    args: ['access/server/node_modules/@negokaz/excel-mcp-server/dist/launcher.js'],
    env: { EXCEL_MCP_PAGING_CELLS_LIMIT: '4000' },
    authType: 'none',
    capabilities: ['读写 Excel', '单元格操作', '数据透视'],
    docUrl: 'https://github.com/negokaz/excel-mcp-server',
    note: 'negokaz/excel-mcp-server，分页上限已设为 4000 单元格（EXCEL_MCP_PAGING_CELLS_LIMIT）。'
  }
];

/** 返回全部预设（复制，避免外部修改内部数组）。 */
export function listPresets(): McpPreset[] {
  return MCP_PRESETS.slice();
}

/** 按 id 取单个预设。 */
export function getPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}

/**
 * 根据预设与可选 token 拼装连接所需的请求头。
 * - 'none': 始终返回 {}（鉴权已 baked 进 URL 或无需鉴权）。
 * - 其余：有 token 才注入 `Authorization: Bearer ${token}`，无 token 返回 {}（由调用方决定能否连）。
 */
export function headersForPreset(
  p: McpPreset,
  token?: string
): Record<string, string> {
  if (p.authType === 'none') return {};
  const t = token && token.trim();
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
}

/**
 * 对于 stdio 预设，将用户填写的 token 注入 env。
 * `authEnvVar` 指定环境变量名（如 MODELSCOPE_API_TOKEN）。
 * 返回 undefined 表示无需 env 注入（HTTP 预设或无 token）。
 */
export function envForPreset(
  p: McpPreset,
  token?: string
): Record<string, string> | undefined {
  if (!p.command || !p.authEnvVar) return undefined;
  const t = token && token.trim();
  if (!t) return undefined;
  return { [p.authEnvVar]: t };
}
