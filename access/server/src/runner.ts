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
  createSandboxExecutor,
  type Verifier,
  type AgentCard,
  type TenantContext,
  tenantSessionKey,
  policyEngine,
  type ContentBlock,
  getPluginToolRegistry,
  isEnabled
} from '@agent-harness/core';
import { mcpManager } from './mcp-manager';
import { waitApproval } from './shell-approval';
import { bridgeHarnessEvent } from './plugin-bootstrap';
import path from 'node:path';

loadEnv(); // 加载 git-ignored 的 .env；显式环境变量优先

/**
 * 把数据路径解析为绝对路径并做落盘安全校验。
 * - 绝对路径：原样返回。
 * - 相对路径：相对 APP_HOME（优先）或 process.cwd() 解析，并告警——
 *   相对路径会随进程 cwd 漂移，导致数据落盘分散（后台任务 / 多副本场景尤其危险，
 *   曾有插件因 cwd 偏移把库写到非预期目录）。
 * 建议部署时把 MEMORY_DIR / MEMORY_SQLITE_FILE 设为绝对路径（或设 APP_HOME）。
 */
function resolveDataPath(raw: string, what: string): string {
  if (path.isAbsolute(raw)) return raw;
  const base = process.env.APP_HOME || process.cwd();
  const resolved = path.resolve(base, raw);
  structLog('warn', 'data path not absolute', {
    what,
    raw,
    resolved,
    hint: `建议将 ${what} 设为绝对路径（或设置 APP_HOME）以避免 cwd 漂移导致落盘分散`
  });
  return resolved;
}

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
 * 当前真实日期时间上下文（Asia/Shanghai）。注入系统提示词，作为模型解析
 * 「X月X号」「下周」等相对日期的唯一权威锚点，杜绝凭训练记忆编造年份
 * （曾出现把「9月5号」误判为 2025-09-05 的回归）。
 */
function currentDateContextLine(): string {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  return (
    '当前真实日期与时间（Asia/Shanghai，解析「X月X号」等相对日期时必须以此为准，' +
    '严禁凭记忆猜测年份）：' +
    formatted
  );
}

/**
 * 记忆存储后端单例（P1-9：多租户 / DB 化）。
 *
 * 按环境变量在进程内构建一次并缓存，供 assembleAgent 与运维端点（/api/sessions、
 * /api/memory）共享同一后端：
 * - MEMORY_BACKEND=sqlite（或留空/未配置，默认）：node:sqlite（零 npm 依赖，Node 22+ 内置，多租户推荐）
 * - MEMORY_BACKEND=file （或配置了 MEMORY_DIR）：按会话分桶的 JSON 文件目录
 * - MEMORY_BACKEND=volatile：纯内存（无持久化，需显式指定）
 * sqlite 在运行期不可用时（老 Node）自动回退到 file 并告警。
 */
let _memoryStore: MemoryStore | null = null;
export function getMemoryStore(): MemoryStore {
  if (_memoryStore) return _memoryStore;
  const backend = (process.env.MEMORY_BACKEND || '').toLowerCase();
  if (backend === 'volatile') {
    _memoryStore = new VolatileMemoryStore();
  } else if (backend === 'sqlite' || backend === '') {
    const file = resolveDataPath(
      process.env.MEMORY_SQLITE_FILE || './data/memory.db',
      'MEMORY_SQLITE_FILE'
    );
    try {
      _memoryStore = new SqliteMemoryStore({ file });
      structLog('info', 'memory store', { backend: 'sqlite', file });
    } catch (e: any) {
      const dir = resolveDataPath(
        process.env.MEMORY_DIR || './data/memory',
        'MEMORY_DIR'
      );
      _memoryStore = new FileMemoryStore({ dir });
      structLog('warn', 'sqlite backend unavailable, fall back to file', {
        error: e?.message ?? String(e),
        dir
      });
    }
  } else if (backend === 'file' || process.env.MEMORY_DIR) {
    const dir = resolveDataPath(
      process.env.MEMORY_DIR || './data/memory',
      'MEMORY_DIR'
    );
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
 * - 即便后端是 volatile，进程内缓存也足以保证连续性；
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
      ...(summarizer ? { summarizer } : {})
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
  memoryArg?: Memory,
  /** 运行期自动验证门禁（P0-2）：传入则由 harness 在产出后自动校验，可选重试/标记。 */
  verifier?: Verifier,
  /** 验证未通过时的最大自动重试次数（透传给 harness）。 */
  verifyMaxRetries?: number,
  /**
   * P0.1：目标 agent 的能力卡片。提供时按 `card.assembly` 把「万能 harness」收窄为
   * 「领域 harness」（仅注册指定工具 / 技能 / MCP / 系统提示词）；为 undefined 时
   * 行为完全不变（今天的通用 harness），向后兼容。
   */
  card?: AgentCard | null,
  /**
   * P0.3 租户隔离：传入时按 tenant.id 从 PolicyEngine 取该租户护栏策略（含出网管控）注入
   * harness，并将记忆分区为 `tenant::session` 复合 key。为 undefined 时退化为通用默认策略
   * 与原始 sessionKey（今天的零租户行为完全不变），向后兼容。
   */
  tenantCtx?: TenantContext | null,
  /**
   * P2.d per-job 隔离后端：由调用方（run-queue）经 resolveIsolationBackend 收敛后的最终
   * backend 字符串（如 'os' / 'container' / 'local'）。缺省沿用 SANDBOX_BACKEND 全局值。
   * 通过它实现「不可信 / 跨行业 agent 强制强隔离」而不改动 shell 工具逻辑。
   */
  sandboxBackend?: string | null,
  /**
   * 是否启用 token 级流式（向聊天 UI 透出 llm:token / llm:reasoning 事件）。
   * 不传时：默认开启（受 AGENT_STREAM_TOKENS!=='false' 控制），mock 与 real 模式均生效
   * —— mock LLM 现已支持逐块流式回调，故本地无密钥也能看到打字机效果与深度思考块。
   */
  streamTokens?: boolean,
  /**
   * 联网搜索开关（Request 4）：显式控制是否注册 `web_fetch` 工具与「联网检索」技能。
   * - 不传 / true：沿用环境变量 BUILTINS_WEB（默认开启）行为，向后兼容。
   * - false：即便用户询问最新 / 外部信息，也不注册任何出网检索能力，避免无意义请求与资源消耗。
   * 调用方（run-queue）经 per-job `job.web` 收敛后透传。
   */
  webEnabled?: boolean,
  /**
   * 计划模式 propose（P0）：透传给 harness 的 planPropose 标志。开启后模型输出的
   * 计划 JSON 经 parsePlanOutput 校验通过时仅做密钥/注入扫描，跳过业务合规输出规则，
   * 避免结构化计划被误拦后回退为普通回答。缺省 false（行为不变）。
   */
  planPropose?: boolean,
  /**
   * 计划任务执行（P0）：计划模式逐任务派发的 run。开启后模型输出走 checkTaskOutput
   * ——「system prompt」等弱信号短语与宽松密钥样例正则会把架构教学内容误拦成
   * 兜底话术（实测 stealth/ox-alpha 概念综述即被拦）。缺省 false（行为不变）。
   */
  planTask?: boolean,
  /**
   * 自定义模型专属接口地址（可选，OpenAI 兼容端点 base URL）。提供时 OpenRouter LLM
   * 以该地址直连（配合 modelApiKey），用于支持用户自带的任意兼容端点。缺省走默认。
   */
  modelBaseUrl?: string,
  /** 自定义模型专属 API Key（可选）。与 modelBaseUrl 搭配；缺省走服务端默认凭证。 */
  modelApiKey?: string,
  /**
   * 所选模型的真实上下文窗口上限（token，可选）：来自前端模型目录的官方 context_length。
   * 透传给 harness 的 llm:usage 事件作为「上下文用量」分母；未传回落保守基线。
   */
  ctxWindow?: number
): Promise<AssembledAgent> {
  const tools = new ToolRegistry();
  const envPlatform: EnvPlatform = createEnvPlatform(); // 按 ENV_PLATFORM 选择后端（默认 harness，无 key 时 dry-run）
  const dryRun = envPlatform.dryRun;
  registerHarnessTools(tools, envPlatform);

  // P0.1：按 AgentCard 收窄工具面（缺省 card 或 card.assembly 未指定某维度时退化为全开）。
  const assembly = card?.assembly;
  const assemblyTools = assembly?.tools;
  const assemblySkills = assembly?.skills;
  const assemblyMcp = assembly?.mcpServers;

  // 注册零依赖的内置基础工具（calculator / datetime / web_fetch / filesystem），
  // 默认常开，可用环境变量 BUILTINS_FS / BUILTINS_WEB / BUILTINS_CALC / BUILTINS_DT
  // 设为 'false' 关闭；HARNESS_FS_ROOT 可限定文件沙箱根目录。
  // 沙箱 shell 能力默认关闭，需 SHELL_ENABLED=true 开启；开启后受白名单 + 作用域管控，
  // 若再设 SHELL_REQUIRE_CONFIRM=true 则每次执行前需经 /api/shell/approve 审批。
  const shellEnabled = process.env.SHELL_ENABLED === 'true';
  const shellRequireConfirm = process.env.SHELL_REQUIRE_CONFIRM === 'true';
  // 联网搜索总开关：环境变量 BUILTINS_WEB（默认开）× 本次 run 的 webEnabled（UI 开关）。
  // 两者任一为 false 即关闭 web_fetch 与「联网检索」技能 —— 即便用户询问外部/最新信息也不出网。
  const builtinWebEnabled =
    process.env.BUILTINS_WEB !== 'false' && (webEnabled ?? true);
  registerBuiltinTools(tools, {
    fsRoot: process.env.HARNESS_FS_ROOT || process.cwd(),
    fsEnabled: process.env.BUILTINS_FS !== 'false',
    webEnabled: builtinWebEnabled,
    calcEnabled: process.env.BUILTINS_CALC !== 'false',
    datetimeEnabled: process.env.BUILTINS_DT !== 'false',
    shellEnabled,
    shellRoot: process.env.SHELL_ROOT || process.cwd(),
    shellWhitelist: process.env.SHELL_WHITELIST
      ? process.env.SHELL_WHITELIST.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    shellRequireConfirmation: shellRequireConfirm,
    shellConfirm: shellRequireConfirm
      ? (req) => waitApproval(req.command, req.args)
      : undefined,
    shellAllowOperators: process.env.SHELL_ALLOW_OPERATORS === 'true',
    // P0-1/P2.d：选择 shell 执行器后端。优先用调用方收敛后的 per-job 隔离后端（sandboxBackend，
    // 已含 card/租户/env 升级逻辑），缺省回退全局 SANDBOX_BACKEND（local 硬化 / container 隔离）。
    sandboxBackend: sandboxBackend ?? process.env.SANDBOX_BACKEND,
    // P0.1：按 AgentCard.assembly.tools 收窄内置工具面（undefined/空 → 全部）。
    ...(assemblyTools ? { tools: assemblyTools } : {})
  });

  // 技能编排层：把基础工具打包成模型可一键选用的复合能力。
  // 注册表 + 元工具（builtin__use_skill）均为新增，不修改 Agent 主循环；
  // 技能目录与触发词自动预激活的指引会注入系统提示词。
  const skillRegistry = new SkillRegistry();
  // P0.1：若 card 指定了 skills，仅启用这些；undefined → 全部；空数组 [] → 一个都不启用。
  // Request 4：联网搜索关闭时（builtinWebEnabled=false）一并剔除「联网检索」技能，
  // 否则该技能仍会引导模型调用 web_fetch（已被关闭），造成无效出网尝试与资源浪费。
  const enabledSkills = defaultSkills().filter(
    (s) =>
      (!assemblySkills || assemblySkills.includes(s.id)) &&
      (builtinWebEnabled || s.id !== 'web-research')
  );
  skillRegistry.registerMany(enabledSkills);
  registerSkillTools(tools, skillRegistry);

  // 合并运行时已接入的 MCP 工具（共享注册表）。
  // P0.1：若 card 指定了 mcpServers，仅合并列出的 MCP server（按 server 名 / 工具名前缀匹配）。
  const allowMcp =
    assemblyMcp && assemblyMcp.length
      ? (name: string, source?: string) =>
          assemblyMcp.some(
            (s) =>
              source === `mcp:${s}` || name === s || name.startsWith(`${s}__`)
          )
      : undefined;
  tools.mergeFrom(mcpManager.liveRegistry(), allowMcp);

  // P3：合并已启用插件的工具（命名空间 `${pluginId}__`），使插件能力进入运行。
  // 插件工具经 core 的 getPluginToolRegistry 共享表注入，server 不感知任何具体插件。
  tools.mergeFrom(getPluginToolRegistry());

  const notes: string[] = [];
  notes.push(
    `环境平台后端：${envPlatform.kind}${
      dryRun ? '（dry-run，未连接真实平台）' : '（真实后端）'
    }；` +
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
    if (!process.env.OPEN_API_KEY) {
      throw new Error(
        '真实模式需要 OPEN_API_KEY（在 .env 中配置）。可切换到 Mock 模式离线验证。'
      );
    }
    const effectiveModel = resolveOpenRouterConfig({
      model: modelOverride
    }).model;
    // 自定义端点（可选）：前端自定义模型填写的 baseUrl/apiKey 优先于服务端默认配置，
    // 使同一 runner 既支持 OpenRouter 也支持任意 OpenAI 兼容直连端点。
    const primary = createOpenRouterLLM({
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
      ...(modelApiKey ? { apiKey: modelApiKey } : {})
    });
    llmKind = 'openrouter';

    // 故障转移：若同时配置了原生 OpenAI（或兼容端点）密钥，则用熔断器把 OpenRouter
    // 作为 primary、OpenAI 作为 secondary；primary 连续失败或限流时自动回落，对主循环透明。
    // 设 LLM_FAILOVER=false 可关闭（仅用 OpenRouter）。
    const openaiKey =
      process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
    if (openaiKey && process.env.LLM_FAILOVER !== 'false') {
      const secondary = createOpenAILLM(resolveOpenAIConfig());
      llm = createFailoverLLM(primary, secondary, {
        failThreshold: Number(process.env.LLM_FAILOVER_THRESHOLD ?? 3) || 3,
        cooldownMs:
          Number(process.env.LLM_FAILOVER_COOLDOWN_MS ?? 60_000) || 60_000,
        primaryLabel: 'openrouter',
        secondaryLabel: 'openai'
      });
      failover = true;
      notes.push(
        `使用真实 OpenRouter LLM（model=${effectiveModel}），并已启用 OpenAI 故障转移（熔断阈值 ${
          process.env.LLM_FAILOVER_THRESHOLD ?? 3
        }）。`
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
    notes.push(
      `已接入 MCP 服务 ${
        mcpManager.list().filter((s) => s.status === 'connected').length
      } 个，工具 ${total} 个。`
    );
  } else {
    notes.push('未检测到已连接的 MCP 服务（可在「MCP 服务」面板添加）。');
  }

  notes.push(
    '已内置基础工具：calculator / datetime / web_fetch / filesystem（默认常开，可被模型自动调用）。'
  );

  if (shellEnabled) {
    const wl = process.env.SHELL_WHITELIST
      ? process.env.SHELL_WHITELIST.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    notes.push(
      `已启用沙箱 shell 执行（builtin__shell_exec）：白名单 ${
        wl.length ? '[' + wl.join(', ') + ']' : '（空→不执行任何命令）'
      }` +
        `，作用域锁定 ${process.env.SHELL_ROOT || process.cwd()}` +
        (shellRequireConfirm
          ? '，每次执行需经 /api/shell/approve 审批。'
          : '。')
    );
  } else {
    notes.push(
      '沙箱 shell 执行未启用（设 SHELL_ENABLED=true 开启，受白名单 + 作用域管控）。'
    );
  }

  // 技能编排层：把技能目录与「按用户消息触发词自动预激活」的指引注入系统提示词。
  // 优化：问候/寒暄等明显不需要技能的输入，仅注入一行桩（id 列表），
  // 避免把 4+ 个技能说明无谓塞进系统提示（占 ~200-400 tokens）。
  const skillTriggered = userInput
    ? skillRegistry.hasTriggerMatch(userInput)
    : false;
  const triggeredSkills = userInput
    ? skillRegistry.matchTriggers(userInput)
    : [];
  const skillCatalog = skillRegistry.describeForPrompt(!skillTriggered);
  const skillBoost = userInput
    ? skillBoostPrompt(userInput, skillRegistry)
    : '';

  // 收集命中技能关联的工具 + 元工具，作为动态工具选择的「硬允许集」，
  // 防止 selectToolsForInput 把模型需要的技能工具裁掉（如 web-research 场景）。
  const triggeredSkillTools = new Set<string>(['builtin__use_skill']);
  for (const s of triggeredSkills) {
    for (const t of s.tools ?? []) triggeredSkillTools.add(t);
  }
  // P0.1：若 card 自带系统提示词，以其覆盖运行模式默认提示词（skillCatalog/boost 仍叠加）。
  const effectiveSystemPrompt = card?.assembly?.systemPrompt ?? systemPrompt;
  // 当前真实日期锚点：注入系统提示词，作为模型解析相对日期的权威基准，避免编造年份。
  const dateContext = currentDateContextLine();
  const finalSystemPrompt = [effectiveSystemPrompt, dateContext, skillCatalog, skillBoost]
    .filter(Boolean)
    .join('\n\n');
  const skillTitles = skillRegistry
    .enabledList()
    .map((s) => s.id)
    .join(' / ');
  notes.push(
    `已启用技能编排层：${skillTitles}，模型可自动选用并按既定流程解决问题。`
  );

  // 记忆后端：按会话隔离（P1-9）。未指定 sessionKey 时归入 'anonymous'，
  // 经 getMemoryStore() 选出的后端持久化（file/sqlite/volatile）。
  // 滑动窗口 maxWindow 可由 env MEMORY_WINDOW 调整（默认 20）。
  const maxWindow = Number(process.env.MEMORY_WINDOW ?? 20) || 20;
  // 当前 run 的计价/标识模型（modelOverride > env OPEN_MODEL > 内置默认），
  // 供 LLM 摘要器标注与成本明细。
  const accountModel = resolveOpenRouterConfig({ model: modelOverride }).model;
  // 上下文压缩（P1）：滑动窗口溢出淘汰旧轮次时，将其压缩为一条 system 摘要固定保留，
  // 根治「每步重发全部历史」导致的 token 平方增长（原问题 B 的根因）。
  // 默认关闭；CONTEXT_COMPRESSION=true 开启（经特性开关框架统一判定）。摘要器必须同步、返回有界字符串。
  const enableCompression = isEnabled('contextCompression');
  // 压缩模式：heuristic（默认，零额外调用，仅统计工具调用）| llm（调用 LLM 做高质量摘要）。
  // llm 仅可在 real 模式（真实 LLM 可用）下启用；mock 模式即便设了 llm 也会安全回退启发式。
  const compressionMode = (
    process.env.COMPRESSION_MODE || 'heuristic'
  ).toLowerCase();
  const useLlmSummarizer =
    enableCompression && compressionMode === 'llm' && llmKind === 'openrouter';
  const heuristicSummarizer: MemorySummarizer = ({ previous, evicted }) => {
    let userReqs = 0;
    let toolCalls = 0;
    const toolCounts = new Map<string, number>();
    for (const m of evicted) {
      if (m.role === 'user') userReqs++;
      const tcs = (
        m as { tool_calls?: Array<{ function?: { name?: string } }> }
      ).tool_calls;
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
  // P0.3：per-tenant 复合记忆 key（tenant::session），实现租户间记忆物理隔离；
  // 无 tenant 时退化为原始 sessionKey（与今天一致）。
  const effectiveSessionKey = tenantSessionKey(
    tenantCtx,
    sessionKey ?? 'anonymous'
  );
  const memory =
    memoryArg ?? getSessionMemory(effectiveSessionKey, maxWindow, summarizer);
  // 成本/配额：env 可配置单次 run 的 token 与成本上限，超出即熔断（P1-11）。
  const tokenBudget = process.env.MAX_TOKENS_PER_RUN
    ? Number(process.env.MAX_TOKENS_PER_RUN) || undefined
    : undefined;
  const costBudget = process.env.MAX_COST_PER_RUN
    ? Number(process.env.MAX_COST_PER_RUN) || undefined
    : undefined;
  // 闭环步数上限：显式 maxSteps 优先 > env MAX_STEPS > 默认 24（原为硬编码 12，
  // 复杂任务常被提前截断）。工具结果截断降低每步重发的 token 成本。
  const envMaxSteps = Number(process.env.MAX_STEPS);
  const effectiveMaxSteps =
    typeof maxSteps === 'number' && maxSteps > 0
      ? maxSteps
      : Number.isFinite(envMaxSteps) && envMaxSteps > 0
      ? envMaxSteps
      : 24;
  const maxToolResultChars =
    Number(process.env.MAX_TOOL_RESULT_CHARS ?? 16000) || 16000;
  const requireCompletion =
    process.env.AGENT_COMPLETION_CHECK === 'true' ||
    process.env.AGENT_COMPLETION_CHECK === '1';
  // P0.3：按租户取护栏策略（含出网 network 约束），注入 harness 的 per-run 覆盖；
  // 无 tenant 时取默认策略（与全局 default 一致，向后兼容）。该策略会自动覆盖
  // checkInput/checkOutput/checkToolArgs/redactOutput 的判定与 web_fetch 出网管控。
  const guardrailPolicy = tenantCtx
    ? policyEngine.getPolicy(tenantCtx.id)
    : policyEngine.getPolicy(undefined);
  const harness = new AgentHarness({
    llm,
    tools,
    memory,
    systemPrompt: finalSystemPrompt,
    // 事件桥接：把核心 harness 运行事件广播给插件事件订阅者（ctx.events.on），
    // 使插件能订阅 run:start / run:end 等运行时事件（如客服对话记录），全程无业务耦合。
    onEvent: (e: HarnessEvent) => {
      bridgeHarnessEvent(e);
      onEvent?.(e);
    },
    model: accountModel,
    // 真实上下文窗口（来自前端模型目录的官方 context_length）：llm:usage 的分母。
    ...(ctxWindow && ctxWindow > 0 ? { contextWindow: ctxWindow } : {}),
    tokenBudget,
    costBudget,
    maxSteps: effectiveMaxSteps,
    maxToolResultChars,
    requireCompletion,
    // P0-2：运行期自动验证门禁（验证器由 run-queue 按配置/env 装配后注入）。
    ...(verifier ? { verify: verifier } : {}),
    ...(verifier && verifyMaxRetries ? { verifyMaxRetries } : {}),
    // 透传运行队列下发的取消信号与整体超时（harness 已原生支持，UI 此前未接线）。
    ...(signal ? { signal } : {}),
    ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
    // P0.3：租户级护栏策略覆盖（含出网管控）。
    ...(guardrailPolicy ? { guardrailPolicy } : {}),
    // 动态工具选择：把 AgentCard.assembly.tools 与命中技能的关联工具作为硬允许集透传给 harness，
    // 配合核心 selectToolsForInput 按意图裁剪其余工具（问候→最小子集；真实任务→全量）。
    ...resolveAllowTools(assemblyTools, triggeredSkillTools),
    // 工具调用加固（默认开启，TOOL_DEDUP=false 可回退到旧行为）：
    // - enableToolDedup：同 run 内「同名 + 相同归一化参数」的重复工具调用直接复用首次结果，
    //   砍掉模型反复请求同一工具导致的调用爆炸（如截图 26 次 → 1 次），降低 token 成本。
    // - maxToolCallsPerStep：单 step 工具调用预算封顶（MAX_TOOL_CALLS_PER_STEP，默认 0 不限制）。
    enableToolDedup: process.env.TOOL_DEDUP !== 'false',
    maxToolCallsPerStep: Number(process.env.MAX_TOOL_CALLS_PER_STEP ?? 0) || 0,
    // P2：把租户身份注入 harness，使 token / cost / run 指标能按 tenantId 聚合（审计/计费）。
    ...(tenantCtx?.id ? { tenantId: tenantCtx.id } : {}),
    // 计划模式 propose（P0）：计划 JSON 输出走结构化校验，跳过业务合规输出规则。
    ...(planPropose ? { planPropose: true } : {}),
    // 计划任务执行（P0）：教学内容输出走 checkTaskOutput 宽松扫描（弱信号短语 /
    // 宽松密钥样例正则会误拦架构讲解），安全底线（真密钥 / 强信号注入）不放松。
    ...(planTask ? { planTask: true } : {}),
    // token 级流式：默认开启（AGENT_STREAM_TOKENS!=='false' 时可关），mock 与 real 均生效，
    // 供聊天 UI 打字机效果与深度思考块。
    ...(streamTokens ?? process.env.AGENT_STREAM_TOKENS !== 'false'
      ? { streamTokens: true }
      : {})
  });

  notes.push(
    `闭环步数上限 MAX_STEPS=${effectiveMaxSteps}` +
      (requireCompletion ? '，已启用完成自检（空响应即继续循环）' : '') +
      `；工具结果截断 ${maxToolResultChars} 字符；记忆窗口 ${maxWindow}` +
      (enableCompression
        ? `；已启用上下文压缩（${
            useLlmSummarizer
              ? 'LLM 摘要（调用模型压缩淘汰轮次）'
              : '启发式摘要（零额外调用）'
          }：淘汰轮次摘要为系统消息）`
        : '') +
      '。'
  );
  if (verifier) {
    notes.push(
      `已启用运行期自动验证门禁（P0-2）：${
        verifyMaxRetries && verifyMaxRetries > 0
          ? `未通过时最多自动重试 ${verifyMaxRetries} 次并自检修正`
          : '产出后自动校验，未通过则标记返回'
      }。`
    );
  }
  if (enableCompression && compressionMode === 'llm' && !useLlmSummarizer) {
    notes.push(
      '上下文压缩已设为 LLM 模式，但当前为 Mock/离线模式，已安全回退为启发式摘要。'
    );
  }

  return {
    harness,
    tools,
    memory,
    llmKind,
    dryRun,
    mcpConnected,
    notes,
    tokenBudget,
    costBudget,
    accountModel,
    failover
  };
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
        const c =
          typeof m.content === 'string' ? m.content : '[非文本 / 工具结果对象]';
        return `${m.role}: ${c}`;
      })
      .join('\n');
    const userContent =
      `此前已有摘要（需延续，勿重复）：\n${previous ?? '（无）'}\n\n` +
      `待压缩的对话轮次：\n${transcript}`;
    const messages: Message[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userContent }
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
        error: e?.message ?? String(e)
      });
      recordError('compression.llm');
      return previous ?? '';
    }
  };
}

/** AgentCard.assembly.tools 使用高-level 内置工具名（calculator / datetime / web_fetch /
 * filesystem / shell），而 harness.selectToolsForInput 按注册表实际名匹配。
 * 把二者映射为实际工具名，再与命中技能的关联工具合并成硬允许集。 */
function resolveAllowTools(
  assemblyTools: string[] | undefined,
  triggeredSkillTools: Set<string>
): { allowTools: string[] } | Record<string, never> {
  const BUILTIN_TOOL_MAP: Record<string, string[]> = {
    calculator: ['builtin__calculator'],
    datetime: [
      'builtin__datetime_now',
      'builtin__datetime_convert',
      'builtin__datetime_add'
    ],
    web_fetch: ['builtin__web_fetch'],
    filesystem: ['builtin__fs_read', 'builtin__fs_list', 'builtin__fs_search'],
    shell: ['builtin__shell_exec']
  };
  const set = new Set<string>();
  for (const t of triggeredSkillTools) set.add(t);
  for (const name of assemblyTools ?? []) {
    const mapped = BUILTIN_TOOL_MAP[name];
    if (mapped) for (const m of mapped) set.add(m);
    else set.add(name); // 未识别则按原样透传（可能是自定义工具名）
  }
  return set.size ? { allowTools: [...set] } : {};
}

/** 命中以下任一模式才视为「需要创建/管理临时环境」，走 创建 → 销毁 工具闭环；
 * 否则按普通问答处理（不触发任何工具）。 */
const ENV_INTENT =
  /(创建|建个|搭个|拉起|起|新建| Provision|provision).{0,4}(环境|沙箱|env)|临时环境|预览环境|验证环境|销毁环境|沙箱环境|ephemeral|preview\s*env|create\s+.{0,12}env|环境.{0,3}(创建|验证|预览|销毁)/i;

/** Mock LLM：无需密钥即可驱动 创建 → 销毁 闭环（与 examples/self-serve-env.ts 一致）。
 * 支持 token 级流式：开启 streamTokens 时通过 opts.onToken / opts.onReasoning 逐块回调，
 * 让聊天 UI 获得打字机效果与「深度思考」推理块。
 * 行为：仅当用户输入含「环境创建意图」时才调用环境工具；普通问答直接流式输出应答。 */
export function makeMockEnvLLM(): LLM {
  return async (messages, _tools, opts) => {
    const last = messages[messages.length - 1];

    if (last?.role === 'tool' && last.name === 'destroy_environment') {
      const h = safeParse(messageText(last) ?? '');
      const content = `已完成闭环：临时环境 ${h.envId} 已创建并销毁，无残留资源。`;
      await streamOut(opts?.onToken, content, 16);
      return { content, tool_calls: [] };
    }

    if (last?.role === 'tool' && last.name === 'create_ephemeral_environment') {
      const h = safeParse(messageText(last) ?? '');
      const call: ToolCall = {
        id: 'call_' + Date.now(),
        name: 'destroy_environment',
        arguments: { env_id: h.envId }
      };
      await streamOut(
        opts?.onReasoning,
        `用户希望创建一个临时环境用于验证。\n从请求解析：环境类型 ephemeral，TTL 8h。\n分支推断为 ${branchOf(
          messageText(last)
        )}，据此调用 create_ephemeral_environment 落地。`,
        14
      );
      return { content: '', tool_calls: [call] };
    }

    const text = messageText(last);

    // 普通问答：不触发任何工具，直接流式输出应答。
    if (!ENV_INTENT.test(text)) {
      const reply = mockGenericReply(text);
      await streamOut(opts?.onToken, reply, 18);
      return { content: reply, tool_calls: [] };
    }

    // 环境创建意图：走 创建 → 销毁 工具闭环。
    const branch = branchOf(text);
    const call: ToolCall = {
      id: 'call_' + Date.now(),
      name: 'create_ephemeral_environment',
      arguments: { env_type: 'ephemeral', branch, ttl_hours: 8 }
    };
    await streamOut(
      opts?.onReasoning,
      `收到用户请求，先明确目标环境。\n类型：ephemeral（临时、用完即销）。\n分支：从输入推断出 ${branch}。\n下一步调用 create_ephemeral_environment 创建，随后由 destroy_environment 自动清理。`,
      14
    );
    return { content: '', tool_calls: [call] };
  };
}

/** 离线 Mock 的普通问答应答：无法真正理解语义，给出透明且友好的占位回复，
 * 并提示切换到 real 模式可获真实回答。 */
function mockGenericReply(question: string): string {
  const q = question.trim();
  if (!q) return '你好，有什么可以帮你的？';
  const snippet = q.length > 60 ? q.slice(0, 60) + '…' : q;
  return (
    `（Mock 离线应答）收到你的问题：「${snippet}」。\n\n` +
    `这是未接入大模型的演示应答。说明：\n` +
    `· 普通问答不会触发环境工具；\n` +
    `· 只有明确提到「创建 / 临时 / 预览 / 验证环境」才会走 创建→销毁 闭环；\n` +
    `· 在服务端配置 OPEN_API_KEY 并切到 real 模式，即可获得真实回答。`
  );
}

/** 把文本按 1~3 字切片并逐块回调（带轻微延迟），模拟真实流式输出。 */
async function streamOut(
  cb: ((delta: string) => void) | undefined,
  text: string,
  delayMs: number
) {
  if (!cb || !text) return;
  let i = 0;
  while (i < text.length) {
    const step = text[i] === '\n' ? 1 : 1 + Math.floor(Math.random() * 2);
    cb(text.slice(i, i + step));
    i += step;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

function branchOf(text: string): string {
  const m = text.match(/基于\s*([^\s,，]+)\s*分支/);
  return m ? (m[1] ?? 'main') : 'main';
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/** 从 Message.content 中提取纯文本（兼容 ContentBlock[] 多模态结构）。 */
function messageText(msg: Message | undefined): string {
  if (!msg?.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter(
      (b): b is ContentBlock & { text: string } =>
        b.type === 'text' && typeof b.text === 'string'
    )
    .map((b) => b.text)
    .join('\n');
}
