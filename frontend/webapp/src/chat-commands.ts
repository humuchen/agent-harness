/**
 * Slash Command 命令框架（P1-⑥）。
 *
 * 设计目标：让用户通过 `/` 前缀输入命令（如 `/new`、`/web off`），
 * 命令在前端被解析并拦截，不经过 /api/run LLM 推理，直接执行本地副作用。
 *
 * 架构：
 * - `SlashCommand` 接口 + `register`/解析器 —— 纯函数模块，零依赖
 * - `CommandContext` 抽象了 chat.ts 提供的副作用方法，解耦命令实现与 UI
 * - `registerBuiltinCommands` 注册 8 个内置命令
 * - `handleSlashCommand(input, ctx)`：入口 —— 解析+拦截，返回 true 表示拦截成功
 */

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  /** 返回 true 表示命令被消费（不应继续向 /api/run 发送） */
  execute: (args: string, ctx: CommandContext) => boolean | Promise<boolean>;
}

export interface CommandContext {
  clearMessages(): void;
  newConversation(): void;
  copyFinal(): Promise<void>;
  toggleWeb(): void;
  setMode(mode: 'mock' | 'real' | 'real-mcp'): void;
  setInteractionMode(mode: 'qa' | 'plan'): void;
  exportRun(): void;
  notifySuccess(msg: string): void;
  notifyWarning(msg: string): void;
}

/** 命令注册表。 */
const register = new Map<string, SlashCommand>();

/** 注册一个命令（含别名）。 */
export function registerCommand(cmd: SlashCommand): void {
  register.set(cmd.name, cmd);
  for (const a of cmd.aliases ?? []) register.set(a, cmd);
}

/** 列出所有已注册命令（去重）。 */
export function getCommands(): SlashCommand[] {
  return [...new Set(register.values())];
}

/**
 * 解析 slash command 输入。
 * 返回 { cmd, args } 或 null（如果不是 command）。
 * 命令名不区分大小写。
 */
export function parseCommand(input: string): { cmd: string; args: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const cmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  return { cmd: cmd.toLowerCase(), args };
}

/**
 * 处理一次 slash command 输入。
 * 返回 true 表示命令被消费（输入框应清空，不继续发送）；
 * 返回 false 表示不是 command（或命令未知），交由正常流程。
 */
export function handleSlashCommand(input: string, ctx: CommandContext): boolean {
  const parsed = parseCommand(input);
  if (!parsed) return false;
  const cmd = register.get(parsed.cmd);
  if (!cmd) {
    ctx.notifyWarning(`未知命令：/${parsed.cmd}，输入 /help 查看可用命令`);
    return true; // 拦截：告知用户
  }
  const ok = cmd.execute(parsed.args, ctx);
  void ok; // fire-and-forget
  return true;
}

/**
 * 注册所有内置命令。
 * 调用方传入 CommandContext，内置命令执行时使用。
 */
export function registerBuiltinCommands(ctx: CommandContext): void {
  registerCommand({
    name: 'new', aliases: ['clear', 'reset'],
    description: '开启新对话，清空当前会话',
    execute: () => { ctx.newConversation(); ctx.notifySuccess('已开启新对话'); return true; }
  });

  registerCommand({
    name: 'help', aliases: ['h'],
    description: '显示可用命令列表',
    execute: () => {
      const cmds = getCommands()
        .map((c) => {
          const alias = c.aliases?.length ? ` (别名: ${c.aliases.join(', ')})` : '';
          return `/${c.name} — ${c.description}${alias}`;
        })
        .join('\n');
      ctx.notifySuccess(`可用命令：\n${cmds}`);
      return true;
    }
  });

  registerCommand({
    name: 'web',
    description: '切换联网搜索开关（/web on|off，默认 toggle）',
    execute: (args) => {
      ctx.toggleWeb();
      ctx.notifySuccess(`联网搜索已${args === 'off' ? '关闭' : '开启'}`);
      return true;
    }
  });

  registerCommand({
    name: 'mode',
    description: '切换运行模式（/mode mock|real|real-mcp）',
    execute: (args) => {
      const m = args as 'mock' | 'real' | 'real-mcp';
      if (['mock', 'real', 'real-mcp'].includes(m)) {
        ctx.setMode(m);
        ctx.notifySuccess(`运行模式已切换为：${m}`);
        return true;
      }
      ctx.notifyWarning('用法：/mode <mock|real|real-mcp>');
      return false;
    }
  });

  registerCommand({
    name: 'plan',
    description: '切换计划模式（/plan on|off）',
    execute: (args) => {
      const target = args === 'off' ? 'qa' : 'plan';
      ctx.setInteractionMode(target);
      ctx.notifySuccess(`交互模式已切换为：${target === 'plan' ? '计划' : '问答'}`);
      return true;
    }
  });

  registerCommand({
    name: 'copy',
    description: '复制最终结果到剪贴板',
    execute: async () => {
      await ctx.copyFinal();
      return true;
    }
  });

  registerCommand({
    name: 'export',
    description: '导出运行记录为 HTML',
    execute: () => {
      ctx.exportRun();
      return true;
    }
  });

  registerCommand({
    name: 'stop',
    description: '停止当前 agent 运行',
    execute: () => {
      ctx.notifyWarning('停止功能请使用 UI 的「停止」按钮');
      return true;
    }
  });
}
