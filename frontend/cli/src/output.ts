/**
 * 输出工具：TTY 检测着色 + JSON 行输出。零依赖。
 */

const COLORS: Record<string, string> = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function useColor(): boolean {
  return !!process.stdout.isTTY && !process.env.NO_COLOR;
}

/** 给字符串上色（非 TTY 或设置了 NO_COLOR 时原样返回）。 */
export function c(color: keyof typeof COLORS, s: string): string {
  return useColor() ? `${COLORS[color]}${s}${COLORS.reset}` : s;
}

/** 向 stdout 写一行（字符串直接输出，对象序列化为 JSON）。 */
export function out(...args: unknown[]): void {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stdout.write(line + '\n');
}

/** 向 stderr 写一行。 */
export function err(...args: unknown[]): void {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stderr.write(line + '\n');
}

/** JSON 行输出（机器可读 / 管道消费）。 */
export function jsonOut(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 把一个 SSE 事件渲染成单行摘要，供人类阅读。 */
export function summarizeEvent(ev: Record<string, unknown>): string {
  const { type, ...rest } = ev;
  switch (type) {
    case 'job:accepted':
      return `job ${String(ev.jobId)}`;
    case 'env:status': {
      const env = (ev.env as Record<string, unknown>) ?? {};
      return `env ${String(env.envId)} ${String(env.status)}${env.envUrl ? ' → ' + String(env.envUrl) : ''}`;
    }
    case 'verify:assert':
      return `assert ${String(ev.name)} ${ev.passed ? c('green', 'PASS') : c('red', 'FAIL')}`;
    case 'verify:group':
      return `group ${String(ev.name)}`;
    case 'verify:summary':
      return `summary ${ev.passed ? c('green', 'PASS') : c('red', 'FAIL')} score=${String(ev.score)}`;
    case '_done':
    case '_verify_done':
    case '_env_done':
      return `${String(type)}`;
    default: {
      const restStr = Object.keys(rest).length
        ? ' ' + JSON.stringify(rest)
        : '';
      return `${String(type)}${restStr}`;
    }
  }
}
