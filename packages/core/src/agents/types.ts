/**
 * 智能体一等实体类型（统一基座平台 P0.1）。
 *
 * 设计目标：把「智能体（Agent）」从「同一个 harness 挂不同工具」提升为显式、可寻址、
 * 可被路由选中的一等实体。AgentCard 是能力声明 + 接入契约；AgentAssembly 是其本地装配配方。
 *
 * 约定：
 * - 与「工具 / MCP / 护栏 / 记忆」解耦：AgentCard 只描述「这个 agent 是什么、能做什么、怎么装」，
 *   真正的执行仍由既有 AgentHarness 承担（见 server/runner.ts 的 assembleAgent(card)）。
 * - 全部字段可 JSON 序列化，便于跨进程 / 跨主机经 A2A 协议传输（P1）。
 */

/** 智能体接入/协作传输方式。 */
export type AgentTransport = 'local' | 'mcp' | 'a2a';

/** 行业 / 领域标签。预留通用值，外部可传任意字符串（联合末尾的 (string & {})）。 */
export type IndustryDomain =
  | 'medical-aesthetics'
  | 'finance'
  | 'healthcare'
  | 'education'
  | 'generic'
  | (string & {});

/** 单项能力声明（用于能力索引与语义发现）。 */
export interface AgentCapability {
  id: string;
  version?: string;
  /** 输入 JSON Schema（可选，用于校验 / A2A TaskEnvelope 对齐）。 */
  inputSchema?: Record<string, unknown>;
  /** 输出 JSON Schema（可选）。 */
  outputSchema?: Record<string, unknown>;
}

export type AgentStatus = 'healthy' | 'degraded' | 'down';

/** 健康度（心跳上报）。 */
export interface AgentHealth {
  status: AgentStatus;
  /** 最近一次心跳时刻（epoch ms）；超过阈值视为 down。 */
  lastHeartbeat: number;
  /** 当前负载 0..1（供 Agent Selector 评分）。 */
  load: number;
}

/**
 * 本地 agent 的装配配方：assembleAgent 仅挂这些，而非全部工具 / 全部 MCP / 全部技能。
 * 这是「万能 harness」收敛为「领域 harness」的关键开关。
 */
export interface AgentAssembly {
  /** 覆盖系统提示词（不填则沿用运行模式默认提示词）。 */
  systemPrompt?: string;
  /** 仅启用这些 skill id（不填则启用全部 defaultSkills）。 */
  skills?: string[];
  /** 仅连接这些 MCP server（按 server 名匹配，不填则合并全部已连 MCP）。 */
  mcpServers?: string[];
  /** 仅注册这些内置工具名（见 BUILTIN_TOOL_NAMES；不填则注册全部内置工具）。 */
  tools?: string[];
  /** 该 agent 的默认运行模式；未指定时沿用调用方传入的 mode。 */
  defaultMode?: 'mock' | 'real' | 'real-mcp';
}

/** 智能体能力清单（Agent Card）—— 注册 / 发现 / 路由选中的核心元数据。 */
export interface AgentCard {
  id: string;
  name: string;
  domain: IndustryDomain;
  description?: string;
  capabilities: AgentCapability[];
  transport: AgentTransport;
  /** 远端地址（transport 为 a2a / mcp 时必填），用于跨主机 / 异构 agent 入驻。 */
  endpoint?: string;
  version: string;
  owner?: string;
  health: AgentHealth;
  sla?: { p95LatencyMs?: number; maxConcurrency?: number };
  /** 本地 agent 的装配配方（transport=local 时使用）。 */
  assembly?: AgentAssembly;
}

/** 内置工具名清单（与 runner.ts 的 registerBuiltinTools 对应）。 */
export const BUILTIN_TOOL_NAMES = [
  'calculator',
  'datetime',
  'web_fetch',
  'filesystem',
  'shell',
] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** 默认通用 agent：保留今天「万能 harness」行为，保证现有 UI / CLI 零改动可用。 */
export const DEFAULT_AGENT_ID = 'default';

export function makeDefaultAgentCard(): AgentCard {
  return {
    id: DEFAULT_AGENT_ID,
    name: 'Default Universal Agent',
    domain: 'generic',
    description: '保留现有行为的通用 agent：挂载全部内置工具、全部 MCP 与全部技能。',
    capabilities: [{ id: 'general-purpose' }],
    transport: 'local',
    version: '1.0.0',
    health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
    // 不填 assembly → assembleAgent 退化为今天的万能 harness。
  };
}
