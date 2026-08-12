import {
  AgentHarness,
  ToolRegistry,
  Memory,
  MemoryStore,
  FileMemoryStore,
  SqliteMemoryStore,
  VolatileMemoryStore,
  createOpenRouterLLM,
  createOpenAILLM,
  createFailoverLLM,
  HarnessClient,
  registerHarnessTools,
  registerBuiltinTools,
  SkillRegistry,
  defaultSkills,
  registerSkillTools,
  skillBoostPrompt,
  loadEnv,
  structLog,
  type LLM,
  type HarnessEvent,
  type ToolCall,
} from '@agent-harness/core';
import { mcpManager } from './mcp-manager';
import { waitApproval } from './shell-approval';

loadEnv(); // 加载 git-ignored 的 .env；显式环境变量优先

export type RunMode = 'mock' | 'real' | 'real-mcp';

export interface AssembledAgent {
  harness: AgentHarness;
  tools: ToolRegistry;
  memory: Memory;
  llmKind: 'mock' | 'openrouter';
  dryRun: boolean;
  mcpConnected: boolean;
  notes: string[];
  /** 单次 run 的 token 预算（未配置则 undefined）。 */
  tokenBudget?: number;
  /** 单次 run 的成本预算（美元，未配置则 undefined）。 */
  costBudget?: number;
  /** 用于成本计价的模型标识。 */
  accountModel?: string;
  /** 是否启用了 provider 故障转移。 */
  failover: boolean;
}

const SYSTEM_PROMPT =
  '你是基础设施助手。用户需要临时/预览环境时，调用 create_ephemeral_environment；' +
  '用户确认回归/验证完成后，务必调用 destroy_environment 清理，避免资源浪费。';

/**
 * 记忆存储后端单例（P1-9：多租户 / DB 化）。
 *
 * 按环境变量在进程内构建一次并缓存，供 assembleAgent 与运维端点（/api/sessions、
 * /api/memory）共享同一后端：
 * - MEMORY_BACKEND=sqlite：node:sqlite（零 npm 依赖，Node 22+ 内置，多租户推荐）
 * - MEMORY_BACKEND=file （或配置了 MEMORY_DIR）：按会话分桶的 JSON 文件目录
 * - MEMORY_BACKEND=volatile / 未配置：纯内存（无持久化，默认）
 * sqlite 在运行期不可用时（老 Node）自动回退到 file 并告警。
 */
let _memoryStore: MemoryStore | null = null;
export function getMemoryStore(): MemoryStore {
  if (_memoryStore) return _memoryStore;
  const backend = (process.env.MEMORY_BACKEND || '').toLowerCase();
  if (backend === 'volatile') {
    _memoryStore = new VolatileMemoryStore();
  } else if (backend === 'sqlite') {
    const file = process.env.MEMORY_SQLITE_FILE || './data/memory.db';
    try {
      _memoryStore = new SqliteMemoryStore({ file });
      structLog('info', 'memory store', { backend: 'sqlite', file });
    } catch (e: any) {
      const dir = process.env.MEMORY_DIR || './data/memory';
      _memoryStore = new FileMemoryStore({ dir });
      structLog('warn', 'sqlite backend unavailable, fall back to file', {
        error: e?.message ?? String(e),
        dir,
      });
    }
  } else if (backend === 'file' || process.env.MEMORY_DIR) {
    const dir = process.env.MEMORY_DIR || './data/memory';
    _memoryStore = new FileMemoryStore({ dir });
    structLog('info', 'memory store', { backend: 'file', dir });
  } else {
    _memoryStore = new VolatileMemoryStore();
  }
  return _memoryStore;
}

/** 根据运行模式组装一个带事件回调的 Agent。 */
export async function assembleAgent(
  mode: RunMode,
  onEvent?: (e: HarnessEvent) => void,
  systemPrompt: string = SYSTEM_PROMPT,
  modelOverride?: string,
  userInput?: string,
  sessionKey?: string
): Promise<AssembledAgent> {
  const tools = new ToolRegistry();
  const harnessClient = new HarnessClient(); // 未设置 HARNESS_API_KEY 时自动 dry-run
  const dryRun = !process.env.HARNESS_API_KEY;
  registerHarnessTools(tools, harnessClient);

  // 注册零依赖的内置基础工具（calculator / datetime / web_fetch / filesystem），
  // 默认常开，可用环境变量 BUILTINS_FS / BUILTINS_WEB / BUILTINS_CALC / BUILTINS_DT
  // 设为 'false' 关闭；HARNESS_FS_ROOT 可限定文件沙箱根目录。
  // 沙箱 shell 能力默认关闭，需 SHELL_ENABLED=true 开启；开启后受白名单 + 作用域管控，
  // 若再设 SHELL_REQUIRE_CONFIRM=true 则每次执行前需经 /api/shell/approve 审批。
  const shellEnabled = process.env.SHELL_ENABLED === 'true';
  const shellRequireConfirm = process.env.SHELL_REQUIRE_CONFIRM === 'true';
  registerBuiltinTools(tools, {
    fsRoot: process.env.HARNESS_FS_ROOT || process.cwd(),
    fsEnabled: process.env.BUILTINS_FS !== 'false',
    webEnabled: process.env.BUILTINS_WEB !== 'false',
    calcEnabled: process.env.BUILTINS_CALC !== 'false',
    datetimeEnabled: process.env.BUILTINS_DT !== 'false',
    shellEnabled,
    shellRoot: process.env.SHELL_ROOT || process.cwd(),
    shellWhitelist: process.env.SHELL_WHITELIST
      ? process.env.SHELL_WHITELIST.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    shellRequireConfirmation: shellRequireConfirm,
    shellConfirm: shellRequireConfirm ? (req) => waitApproval(req.command, req.args) : undefined,
    shellAllowOperators: process.env.SHELL_ALLOW_OPERATORS === 'true',
  });

  // 技能编排层：把基础工具打包成模型可一键选用的复合能力。
  // 注册表 + 元工具（builtin__use_skill）均为新增，不修改 Agent 主循环；
  // 技能目录与触发词自动预激活的指引会注入系统提示词。
  const skillRegistry = new SkillRegistry();
  skillRegistry.registerMany(defaultSkills());
  registerSkillTools(tools, skillRegistry);

  // 合并运行时已接入的 MCP 工具（共享注册表）。
  tools.mergeFrom(mcpManager.liveRegistry());

  const notes: string[] = [];
  let llm: LLM;
  let llmKind: 'mock' | 'openrouter' = 'mock';
  let failover = false;
  const mcpConnected = mcpManager.list().some((s) => s.status === 'connected');

  if (mode === 'mock') {
    llm = makeMockEnvLLM();
    llmKind = 'mock';
    notes.push('内置 Mock LLM（无需密钥），离线即可跑通 创建 → 销毁 闭环。');
  } else {
    // real / real-mcp 都依赖真实 OpenRouter
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error(
        '真实模式需要 OPENROUTER_API_KEY（在 .env 中配置）。可切换到 Mock 模式离线验证。'
      );
    }
    const model =
      (modelOverride && modelOverride.trim()) ||
      (process.env.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL.trim()) ||
      undefined;
    const primary = createOpenRouterLLM(model ? { model } : {});
    llmKind = 'openrouter';

    // 故障转移：若同时配置了原生 OpenAI（或兼容端点）密钥，则用熔断器把 OpenRouter
    // 作为 primary、OpenAI 作为 secondary；primary 连续失败或限流时自动回落，对主循环透明。
    // 设 LLM_FAILOVER=false 可关闭（仅用 OpenRouter）。
    const openaiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
    if (openaiKey && process.env.LLM_FAILOVER !== 'false') {
      const secondary = createOpenAILLM({
        apiKey: process.env.OPENAI_API_KEY,
        model: (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim()) || undefined,
        baseUrl: (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.trim()) || undefined,
      });
      llm = createFailoverLLM(primary, secondary, {
        failThreshold: Number(process.env.LLM_FAILOVER_THRESHOLD ?? 3) || 3,
        cooldownMs: Number(process.env.LLM_FAILOVER_COOLDOWN_MS ?? 60_000) || 60_000,
        primaryLabel: 'openrouter',
        secondaryLabel: 'openai',
      });
      failover = true;
      notes.push(
        `使用真实 OpenRouter LLM（model=${model ?? '默认'}），并已启用 OpenAI 故障转移（熔断阈值 ${process.env.LLM_FAILOVER_THRESHOLD ?? 3}）。`
      );
    } else {
      llm = primary;
      notes.push(`使用真实 OpenRouter LLM（model=${model ?? '默认'}）。`);
    }
  }

  if (mcpConnected) {
    const total = mcpManager
      .list()
      .filter((s) => s.status === 'connected')
      .reduce((n, s) => n + s.tools.length, 0);
    notes.push(`已接入 MCP 服务 ${mcpManager.list().filter((s) => s.status === 'connected').length} 个，工具 ${total} 个。`);
  } else {
    notes.push('未检测到已连接的 MCP 服务（可在「MCP 服务」面板添加）。');
  }

  notes.push(
    '已内置基础工具：calculator / datetime / web_fetch / filesystem（默认常开，可被模型自动调用）。'
  );

  if (shellEnabled) {
    const wl = process.env.SHELL_WHITELIST
      ? process.env.SHELL_WHITELIST.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    notes.push(
      `已启用沙箱 shell 执行（builtin__shell_exec）：白名单 ${wl.length ? '[' + wl.join(', ') + ']' : '（空→不执行任何命令）'}` +
        `，作用域锁定 ${process.env.SHELL_ROOT || process.cwd()}` +
        (shellRequireConfirm ? '，每次执行需经 /api/shell/approve 审批。' : '。')
    );
  } else {
    notes.push('沙箱 shell 执行未启用（设 SHELL_ENABLED=true 开启，受白名单 + 作用域管控）。');
  }

  // 技能编排层：把技能目录与「按用户消息触发词自动预激活」的指引注入系统提示词。
  const skillCatalog = skillRegistry.describeForPrompt();
  const skillBoost = userInput ? skillBoostPrompt(userInput, skillRegistry) : '';
  const finalSystemPrompt = [systemPrompt, skillCatalog, skillBoost].filter(Boolean).join('\n\n');
  const skillTitles = skillRegistry.enabledList().map((s) => s.id).join(' / ');
  notes.push(`已启用技能编排层：${skillTitles}，模型可自动选用并按既定流程解决问题。`);

  // 记忆后端：按会话隔离（P1-9）。未指定 sessionKey 时归入 'anonymous'，
  // 经 getMemoryStore() 选出的后端持久化（file/sqlite/volatile）。
  const memory = new Memory({ store: getMemoryStore(), sessionKey });
  // 成本/配额：env 可配置单次 run 的 token 与成本上限，超出即熔断（P1-11）。
  const tokenBudget = process.env.MAX_TOKENS_PER_RUN ? Number(process.env.MAX_TOKENS_PER_RUN) || undefined : undefined;
  const costBudget = process.env.MAX_COST_PER_RUN ? Number(process.env.MAX_COST_PER_RUN) || undefined : undefined;
  const accountModel =
    (modelOverride && modelOverride.trim()) ||
    (process.env.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL.trim()) ||
    undefined;
  const harness = new AgentHarness({
    llm,
    tools,
    memory,
    systemPrompt: finalSystemPrompt,
    onEvent,
    model: accountModel,
    tokenBudget,
    costBudget,
  });

  return { harness, tools, memory, llmKind, dryRun, mcpConnected, notes, tokenBudget, costBudget, accountModel, failover };
}

/** 各模式对应的默认提示词（用户在 UI 留空时使用）。 */
export function defaultPromptFor(mode: RunMode): string {
  if (mode === 'mock') {
    return '帮我在测试环境基于 feature/login 分支拉起一个临时环境，跑完回归后帮我销毁';
  }
  return '帮我在测试环境基于 feature/login 分支拉起一个临时环境';
}

/** Mock LLM：无需密钥即可驱动 创建 → 销毁 闭环（与 examples/self-serve-env.ts 一致）。 */
export function makeMockEnvLLM(): LLM {
  return async (messages) => {
    const last = messages[messages.length - 1];

    if (last?.role === 'tool' && last.name === 'destroy_environment') {
      const h = safeParse(last.content ?? '');
      return {
        content: `已完成闭环：临时环境 ${h.envId} 已创建并销毁，无残留资源。`,
        tool_calls: [],
      };
    }

    if (last?.role === 'tool' && last.name === 'create_ephemeral_environment') {
      const h = safeParse(last.content ?? '');
      const call: ToolCall = {
        id: 'call_' + Date.now(),
        name: 'destroy_environment',
        arguments: { env_id: h.envId },
      };
      return { content: '', tool_calls: [call] };
    }

    const text = last?.content ?? '';
    const branchMatch = text.match(/基于\s*([^\s,，]+)\s*分支/);
    const branch = branchMatch ? branchMatch[1] : 'main';
    const call: ToolCall = {
      id: 'call_' + Date.now(),
      name: 'create_ephemeral_environment',
      arguments: { env_type: 'ephemeral', branch, ttl_hours: 8 },
    };
    return { content: '', tool_calls: [call] };
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
