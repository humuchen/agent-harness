import { objectParams, ToolRegistry } from '../tools';

/** 用 Intl 把 Date 格式化为人类可读字符串；非法时区回退 UTC。 */
function formatIn(d: Date, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return (
      new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(d) + ' (UTC fallback)'
    );
  }
}

function addDuration(d: Date, amount: number, unit: string): Date {
  const r = new Date(d.getTime());
  switch (unit) {
    case 'seconds':
      r.setSeconds(r.getSeconds() + amount);
      break;
    case 'minutes':
      r.setMinutes(r.getMinutes() + amount);
      break;
    case 'hours':
      r.setHours(r.getHours() + amount);
      break;
    case 'days':
      r.setDate(r.getDate() + amount);
      break;
    case 'weeks':
      r.setDate(r.getDate() + amount * 7);
      break;
    case 'months':
      r.setMonth(r.getMonth() + amount);
      break;
    case 'years':
      r.setFullYear(r.getFullYear() + amount);
      break;
    default:
      throw new Error(`unknown unit '${unit}'`);
  }
  return r;
}

export function registerDateTime(registry: ToolRegistry): void {
  registry.register(
    'builtin__datetime_now',
    'Get the current date/time. Returns ISO-8601 UTC and a human-readable form in the requested ' +
      'IANA timezone (e.g. "Asia/Shanghai", "America/New_York"). Defaults to UTC. Use this ' +
      'whenever the user asks about "now", dates, or times.',
    objectParams(
      { timezone: { type: 'string', description: 'IANA timezone name, e.g. Asia/Shanghai. Defaults to UTC.' } },
      []
    ),
    async (args: Record<string, unknown>) => {
      const tz = args.timezone ? String(args.timezone) : undefined;
      try {
        const d = new Date();
        return JSON.stringify({ iso: d.toISOString(), tz: tz ?? 'UTC', formatted: formatIn(d, tz), epoch: d.getTime() });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );

  registry.register(
    'builtin__datetime_convert',
    'Convert an ISO-8601 timestamp from one timezone to another.',
    objectParams(
      {
        time: { type: 'string', description: 'ISO-8601 timestamp, e.g. "2026-01-01T00:00:00Z".' },
        from: { type: 'string', description: 'Source IANA timezone (optional; inferred from the timestamp if omitted).' },
        to: { type: 'string', description: 'Target IANA timezone.' },
      },
      ['time', 'to']
    ),
    async (args: Record<string, unknown>) => {
      const d = new Date(String(args.time));
      if (isNaN(d.getTime())) return 'error: invalid time';
      const to = String(args.to);
      try {
        return JSON.stringify({
          from: args.from ? String(args.from) : 'parsed',
          to,
          iso: d.toISOString(),
          formatted: formatIn(d, to),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );

  registry.register(
    'builtin__datetime_add',
    'Add (or subtract with a negative amount) a duration to a time. unit is one of ' +
      'seconds/minutes/hours/days/weeks/months/years.',
    objectParams(
      {
        time: { type: 'string', description: 'ISO-8601 timestamp; defaults to now if omitted.' },
        amount: { type: 'number', description: 'Amount to add (negative to subtract).' },
        unit: { type: 'string', description: 'One of seconds/minutes/hours/days/weeks/months/years.' },
        timezone: { type: 'string', description: 'IANA timezone for output formatting.' },
      },
      ['amount', 'unit']
    ),
    async (args: Record<string, unknown>) => {
      const amount = Number(args.amount);
      const unit = String(args.unit);
      const base = args.time ? new Date(String(args.time)) : new Date();
      if (isNaN(base.getTime())) return 'error: invalid time';
      const tz = args.timezone ? String(args.timezone) : undefined;
      try {
        const d = addDuration(base, amount, unit);
        return JSON.stringify({ iso: d.toISOString(), formatted: formatIn(d, tz), epoch: d.getTime() });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );
}
