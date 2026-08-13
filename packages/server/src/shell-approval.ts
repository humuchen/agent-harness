/**
 * 服务端 shell 审批网关。
 *
 * 当 UI 以 `SHELL_REQUIRE_CONFIRM=true` 开启 shell 能力时，shell 工具执行前
 * 需经此审批（human-in-the-loop）。流程：
 *   1. 工具请求执行 → confirm 回调调用 `waitApproval(command, args)` 挂起等待；
 *   2. 操作员（人或自动化脚本）调用 `POST /api/shell/approve` 注入批准；
 *   3. 匹配的等待项被 resolve(true)，命令继续执行；超时未批准则拒绝（安全默认）。
 *
 * 这把「确认」从「终端交互」推广到「Web 审批」，使 Web Playground 也能安全启用
 * 交互式 shell 执行，而不必在无人值守时偷偷放行。
 */

type Pending = { resolve: (ok: boolean) => void; timer: NodeJS.Timeout };

// 已永久批准的命令签名（免重复确认）。
const approved = new Set<string>();
// 正在等待审批的命令签名 → 等待者列表。
const pending = new Map<string, Pending[]>();

/** 命令签名：同一 command + 同一 args 视为同一次审批。 */
export function shellSignature(command: string, args: string[]): string {
  return JSON.stringify([command, args]);
}

/** 预先批准某个命令签名（由 /api/shell/approve 的 preapprove 模式使用）。 */
export function preapprove(sig: string): void {
  approved.add(sig);
}

/**
 * 等待某次命令审批。
 * @returns 被批准返回 true；超时（默认 30s）或未被批准返回 false。
 */
export function waitApproval(command: string, args: string[], timeoutMs = 30_000): Promise<boolean> {
  const sig = shellSignature(command, args);
  if (approved.has(sig)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const entry: Pending = {
      resolve,
      timer: setTimeout(() => {
        const list = pending.get(sig);
        if (list) pending.set(sig, list.filter((p) => p !== entry));
        resolve(false);
      }, timeoutMs),
    };
    const list = pending.get(sig) ?? [];
    list.push(entry);
    pending.set(sig, list);
  });
}

/**
 * 批准某次命令：放行所有正在等待的匹配项。
 * @returns 被放行的等待项数量。
 */
export function approve(command: string, args: string[]): number {
  const sig = shellSignature(command, args);
  approved.add(sig);
  const list = pending.get(sig);
  if (!list || list.length === 0) return 0;
  pending.set(sig, []);
  for (const p of list) {
    clearTimeout(p.timer);
    p.resolve(true);
  }
  return list.length;
}
