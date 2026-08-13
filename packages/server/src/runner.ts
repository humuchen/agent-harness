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
  resolveOpenRouterConfig,
  resolveOpenAIConfig,
  createFailoverLLM,
  createEnvPlatform,
  registerHarnessTools,
  type EnvPlatform,
  registerBuiltinTools,
  SkillRegistry,
  defaultSkills,
  registerSkillTools,
  skillBoostPrompt,
  loadEnv,
  structLog,
  recordError,
  type LLM,
  type HarnessEvent,
  type ToolCall,
  type Message,
  type MemorySummarizer,
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

/**
 * 多轮会话记忆缓存（连续对话支持）。
 *
 * 关键观察：`AgentHarness.run()` 内部会把每一轮 user/assistant/tool 消息追加到
 * `Memory` 的窗口，并在 `hasPersistence` 时 `load()`/`save()`。但 `execute()` 每次
 * run 都 `assembleAgent()` 出一个全新的 `Memory`，窗口随之丢失 → 表现为「单次运行」。
 *
 * 解法：按 sessionKey 复用同一 `Memory` 实例（进程内缓存），使同一会话的多次
 * `/api/run` 共享对话窗口，真正实现连续追问。该缓存与 store 后端**解耦**：
 * - 即便后端是 volatile（默认），进程内缓存也足以保证连续性；
 * - 若配置了 sqlite/file 后端，则额外落盘，用于进程崩溃/重启后的恢复
 *   （harness.run 在 `hasPersistence` 时会先 load 再 append）。
 * 并发安全由 run-queue 的 `runningSessions` 串行化保证：同会话同时只有 1 个 job 在跑。
 */
const SESSION_MEMORY_MAX = Number(process.env.SESSION_MEMORY_MAX ?? 256) || 256;
const sessionMemories = new Map<string, Memory>();
const sessionLastUsed = new Map<string, number>();

/** 淘汰最久未使用的会话记忆，防止内存无限膨胀（有界 LRU）。 */
function evictSessionMemories(): void {
  if (sessionMemories.size <= SESSION_MEMORY_MAX) return;
  const oldest = [...sessionLastUsed.entries()].sort((a, b) => a[1] - b[1]);
  let over = sessionMemories.size - SESSION_MEMORY_MAX;
  for (const [key] of oldest) {
    if (over <= 0) break;
    sessionMemories.delete(key);
    sessionLastUsed.delete(key);
    over -= 1;
  }
}

/**
 * 取得（或新建）某会话的 Memory 实例。跨 run 复用同一对象即可累积对话历史；
 * 已缓存则忽略 summarizer（创建时已绑定）。首次构建按 sessionKey 隔离到所选 store 后端。
 */
export function getSessionMemory(
  sessionKey: string,
  maxWindow: number,
  summarizer?: MemorySummarizer
): Memory {
  let mem = sessionMemories.get(sessionKey);
  if (!mem) {
    mem = new Memory({
      store: getMemoryStore(),
      sessionKey,
      maxWindow,
      ...(summarizer ? { summarizer } : {}),
    });
    sessionMemories.set(sessionKey, mem);
  }
  sessionLastUsed.set(sessionKey, Date.now());
  evictSessionMemories();
  return mem;
}

/** 失效某会话的进程内记忆缓存（如被清空 / 重置时），下次 run 将重建全新窗口。 */
export function invalidateSessionMemory(sessionKey: string): void {
  sessionMemories.delete(sessionKey);
  sessionLastUsed.delete(sessionKey);
}

/** 根据运行模式组装一个带事件回调的 Agent。 */
export async function assembleAgent(
  mode: RunMode,
  onEvent?: (e: HarnessEvent) => void,
  systemPrompt: string = SYSTEM_PROMPT,
  modelOverride?: string,
  userInput?: string,
  sessionKey?: string,
  /** 外部取消信号（来自运行队列的 job 级 AbortController / 进程优雅停机）。 */
  signal?: AbortSignal,
  /** 单次 run 的整体超时（毫秒）；超时后 harness 中止循环并返回超时提示。 */
  timeoutMs?: number,
  /** 单次 run 的循环步数上限；未传则取 env MAX_STEPS（默认 24）。复杂任务可调大。 */
  maxSteps?: number,
  /** 复用既有 Memory（连续对话）。不传则由 sessionKey 自动按会话缓存取/建。 */
  memoryArg?: Memory
): Promise<AssembledAgent> {
  const tools = new ToolRegistry();
  const envPlatform: EnvPlatform = createEnvPlatform(); // 按 ENV_PLATFORM 选择后端（默认 harness，无 key 时 dry-run）
  const dryRun = envPlatform.dryRun;
  registerHarnessTools(tools, envPlatform);

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
  notes.push(
    `环境平台后端：${envPlatform.kind}${dryRun ? '（dry-run，未连接真实平台）' : '（真实后端）'}；` +
      `通过 create_ephemeral_environment / destroy_environment 工具在对话中自助拉起/销毁环境。`
  );
  let llm: LLM;
  let llmKind: 'mock' | 'openrouter' = 'openrouter';
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
    const effectiveModel = resolveOpenRouterConfig({ model: modelOverride }).model;
    const primary = createOpenRouterLLM(modelOverride ? { model: modelOverride } : {});
    llmKind = 'openrouter';

    // 故障转移：若同时配置了原生 OpenAI（或兼容端点）密钥，则用熔断器把 OpenRouter
    // 作为 primary、OpenAI 作为 secondary；primary 连续失败或限流时自动回落，对主循环透明。
    // 设 LLM_FAILOVER=false 可关闭（仅用 OpenRouter）。
    const openaiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
    if (openaiKey && process.env.LLM_FAILOVER !== 'false') {
      const secondary = createOpenAILLM(resolveOpenAIConfig());
      llm = createFailoverLLM(primary, secondary, {
        failThreshold: Number(process.env.LLM_FAILOVER_THRESHOLD ?? 3) || 3,
        cooldownMs: Number(process.env.LLM_FAILOVER_COOLDOWN_MS ?? 60_000) || 60_000,
        primaryLabel: 'openrouter',
        secondaryLabel: 'openai',
      });
      failover = true;
      notes.push(
        `使用真实 OpenRouter LLM（model=${effectiveModel}），并已启用 OpenAI 故障转移（熔断阈值 ${process.env.LLM_FAILOVER_THRESHOLD ?? 3}）。`
      );
    } else {
      llm = primary;
      notes.push(`使用真实 OpenRouter LLM（model=${effectiveModel}）。`);
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
  // 滑动窗口 maxWindow 可由 env MEMORY_WINDOW 调整（默认 20）。
  const maxWindow = Number(process.env.MEMORY_WINDOW ?? 20) || 20;
  // 当前 run 的计价/标识模型（modelOverride > env OPENROUTER_MODEL > 内置默认），
  // 供 LLM 摘要器标注与成本明细。
  const accountModel = resolveOpenRouterConfig({ model: modelOverride }).model;
  // 上下文压缩（P1）：滑动窗口溢出淘汰旧轮次时，将其压缩为一条 system 摘要固定保留，
  // 根治「每步重发全部历史」导致的 token 平方增长（原问题 B 的根因）。
  // 默认关闭；CONTEXT_COMPRESSION=true 开启。摘要器必须同步、返回有界字符串。
  const enableCompression =
    process.env.CONTEXT_COMPRESSION === 'true' || process.env.CONTEXT_COMPRESSION === '1';
  // 压缩模式：heuristic（默认，零额外调用，仅统计工具调用）| llm（调用 LLM 做高质量摘要）。
  // llm 仅可在 real 模式（真实 LLM 可用）下启用；mock 模式即便设了 llm 也会安全回退启发式。
  const compressionMode = (process.env.COMPRESSION_MODE || 'heuristic').toLowerCase();
  const useLlmSummarizer =
    enableCompression && compressionMode === 'llm' && llmKind === 'openrouter';
  const heuristicSummarizer: MemorySummarizer = ({ previous, evicted }) => {
    let userReqs = 0;
    let toolCalls = 0;
    const toolCounts = new Map<string, number>();
    for (const m of evicted) {
      if (m.role === 'user') userReqs++;
      const tcs = (m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
      if (m.role === 'assistant' && Array.isArray(tcs)) {
        for (const tc of tcs) {
          const name = tc?.function?.name || 'unknown';
          toolCalls++;
          toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
        }
      }
    }
    const toolList =
      [...toolCounts.entries()].map(([n, c]) => `${n}×${c}`).join(', ') || '无';
    const line = `已完成 ${userReqs} 次用户交互、${toolCalls} 次工具调用（${toolList}），早期细节已压缩。`;
    // 增量合并：保留前次摘要尾部有界长度，避免跨多次压缩无限膨胀。
    const base = previous ? previous.slice(-220) : '';
    return (base ? base + ' ' : '') + line;
  };
  let summarizer: MemorySummarizer | undefined;
  if (enableCompression) {
    summarizer = useLlmSummarizer
      ? createLLMSummarizer(llm, accountModel ?? 'openrouter')
      : heuristicSummarizer;
  }
  // 复用按会话缓存的 Memory：同一 sessionKey 的多次 run 共享对话窗口，实现连续追问。
  // 显式传入的 memoryArg（如测试）优先；否则按 sessionKey 取/建进程内缓存实例。
  const memory = memoryArg ?? getSessionMemory(sessionKey ?? 'anonymous', maxWindow, summarizer);
  // 成本/配额：env 可配置单次 run 的 token 与成本上限，超出即熔断（P1-11）。
  const tokenBudget = process.env.MAX_TOKENS_PER_RUN ? Number(process.env.MAX_TOKENS_PER_RUN) || undefined : undefined;
  const costBudget = process.env.MAX_COST_PER_RUN ? Number(process.env.MAX_COST_PER_RUN) || undefined : undefined;
  // 闭环步数上限：显式 maxSteps 优先 > env MAX_STEPS > 默认 24（原为硬编码 12，
  // 复杂任务常被提前截断）。工具结果截断降低每步重发的 token 成本。
  const envMaxSteps = Number(process.env.MAX_STEPS);
  const effectiveMaxSteps =
    typeof maxSteps === 'number' && maxSteps > 0
      ? maxSteps
      : Number.isFinite(envMaxSteps) && envMaxSteps > 0
        ? envMaxSteps
        : 24;
  const maxToolResultChars = Number(process.env.MAX_TOOL_RESULT_CHARS ?? 16000) || 16000;
  const requireCompletion = process.env.AGENT_COMPLETION_CHECK === 'true' || process.env.AGENT_COMPLETION_CHECK === '1';
  const harness = new AgentHarness({
    llm,
    tools,
    memory,
    systemPrompt: finalSystemPrompt,
    onEvent,
    model: accountModel,
    tokenBudget,
    costBudget,
    maxSteps: effectiveMaxSteps,
    maxToolResultChars,
    requireCompletion,
    // 透传运行队列下发的取消信号与整体超时（harness 已原生支持，UI 此前未接线）。
    ...(signal ? { signal } : {}),
    ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
  });

  notes.push(
    `闭环步数上限 MAX_STEPS=${effectiveMaxSteps}` +
      (requireCompletion ? '，已启用完成自检（空响应即继续循环）' : '') +
      `；工具结果截断 ${maxToolResultChars} 字符；记忆窗口 ${maxWindow}` +
      (enableCompression
        ? `；已启用上下文压缩（${
            useLlmSummarizer ? 'LLM 摘要（调用模型压缩淘汰轮次）' : '启发式摘要（零额外调用）'
          }：淘汰轮次摘要为系统消息）`
        : '') +
      '。'
  );
  if (enableCompression && compressionMode === 'llm' && !useLlmSummarizer) {
    notes.push('上下文压缩已设为 LLM 模式，但当前为 Mock/离线模式，已安全回退为启发式摘要。');
  }

  return { harness, tools, memory, llmKind, dryRun, mcpConnected, notes, tokenBudget, costBudget, accountModel, failover };
}

/** 各模式对应的默认提示词（用户在 UI 留空时使用）。 */
export function defaultPromptFor(mode: RunMode): string {
  if (mode === 'mock') {
    return '帮我在测试环境基于 feature/login 分支拉起一个临时环境，跑完回归后帮我销毁';
  }
  return '帮我在测试环境基于 feature/login 分支拉起一个临时环境';
}

/**
 * LLM 摘要器（上下文压缩升级项）：把被淘汰的对话轮次交给同一个 LLM 做高质量压缩，
 * 生成 ≤400 字摘要。相比启发式（仅统计工具调用次数）更保真，但每次压缩会产生一次
 * 额外的 LLM 调用（有成本，建议用较便宜的模型或仅在长对话启用）。
 * 失败（限流 / 异常）时回退到「保留上一轮摘要」，绝不让压缩失败中断主运行。
 */
function createLLMSummarizer(llm: LLM, modelLabel: string): MemorySummarizer {
  const SYSTEM =
    '你是上下文压缩器。把用户提供的「被淘汰对话轮次」压缩成一条简洁中文摘要（≤300 字），' +
    '保留：关键决策与结论、工具调用及其结果、用户约束与偏好、尚未完成的待办。' +
    '不要编造新内容，不要输出 JSON，只输出纯文本摘要。';
  return async ({ previous, evicted }) => {
    const transcript = evicted
      .map((m) => {
        const c = typeof m.content === 'string' ? m.content : '[非文本 / 工具结果对象]';
        return `${m.role}: ${c}`;
      })
      .join('\n');
    const userContent =
      `此前已有摘要（需延续，勿重复）：\n${previous ?? '（无）'}\n\n` +
      `待压缩的对话轮次：\n${transcript}`;
    const messages: Message[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userContent },
    ];
    try {
      const resp = await llm(messages, []);
      let s = (resp?.content ?? '').trim();
      if (!s) return previous ?? '';
      if (s.length > 400) s = s.slice(0, 400) + '…';
      return s;
    } catch (e: any) {
      structLog('warn', 'llm summarizer failed, keep previous', {
        model: modelLabel,
        error: e?.message ?? String(e),
      });
      recordError('compression.llm');
      return previous ?? '';
    }
  };
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
