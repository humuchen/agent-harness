import { objectParams, ToolRegistry } from '../tools';

// 数据转换 / ETL 内置工具：在「无外部依赖」前提下提供轻量结构化数据处理能力，
// 让 agent 能就地把文本 / JSON / CSV 解析、清洗、抽取与聚合，避免把脏活丢回 LLM 或外部脚本。
// 工具以 `builtin__` 前缀命名，护栏 / 记忆 / 追踪自动覆盖。
//
// 支持的 operation：
//  - json.parse : 把 JSON 文本解析为对象/数组（可选按点路径抽取子字段）
//  - csv.parse  : 把 CSV 文本解析为对象数组（首行作为表头；支持引号包裹与转义）
//  - text.clean : 文本清洗（trim / 折叠空白 / 去 HTML 标签 / 去重行 / 小写 等可组合）
//  - aggregate  : 对 JSON 数组做统计（count/sum/avg/min/max，或按 groupBy 分组计数）

type Json = unknown;

/** 按点路径从对象/数组抽取子值；非法路径返回原值。支持 `a.b`、`a.0.c`。 */
function getPath(obj: Json, path: string): Json {
  if (!path) return obj;
  const segs = path.split('.').map((s) => s.trim()).filter(Boolean);
  let cur: Json = obj;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return undefined as unknown;
    cur = (cur as Record<string, Json>)[seg];
  }
  return cur;
}

/** 极简 CSV 解析：支持引号包裹字段、字段内双引号转义（""）、字段内换行。 */
function parseCsv(text: string, delimiter: string, hasHeader: boolean): Json[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // 兼容 CRLF：吃掉 \r，等 \n 收行（孤立 \r 也收行）
      pushRow();
    } else {
      field += c;
    }
  }
  // 收尾：若有未闭合字段或最后一行非空则补一行
  if (field.length > 0 || row.length > 0) pushRow();
  // 去掉纯空白的空尾行
  const clean = rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));

  if (!hasHeader || clean.length === 0) {
    return clean.map((r) => r.map((v) => v));
  }
  const header = clean[0];
  return clean.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, idx) => {
      o[h.trim()] = r[idx] ?? '';
    });
    return o;
  });
}

/** 把数值字段强制为 number；非数值返回 undefined（聚合时跳过）。 */
function toNum(v: Json): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function cleanText(text: string, modes: string[]): string {
  let out = text;
  for (const m of modes) {
    switch (m) {
      case 'trim':
        out = out
          .split('\n')
          .map((l) => l.trim())
          .join('\n')
          .trim();
        break;
      case 'collapse':
        out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
        break;
      case 'stripHtml':
        out = out.replace(/<[^>]*>/g, '');
        break;
      case 'dedupeLines':
        out = Array.from(new Set(out.split('\n'))).join('\n');
        break;
      case 'lower':
        out = out.toLowerCase();
        break;
      case 'upper':
        out = out.toUpperCase();
        break;
      case 'stripBlankLines':
        out = out
          .split('\n')
          .filter((l) => l.trim() !== '')
          .join('\n');
        break;
      default:
        // 未知 mode 静默忽略
        break;
    }
  }
  return out;
}

export function registerDataTransform(registry: ToolRegistry): void {
  registry.register(
    'builtin__data_transform',
    'Lightweight data ETL without external dependencies. Operations: ' +
      'json.parse (parse JSON text, optional dot-path extraction), ' +
      'csv.parse (CSV text → array of objects, quoted fields supported), ' +
      'text.clean (trim/collapse/stripHtml/dedupeLines/lower/upper/stripBlankLines), ' +
      'aggregate (count/sum/avg/min/max over a numeric field, optionally grouped). ' +
      'Example: operation="csv.parse", data="name,age\\nAlice,30".',
    objectParams(
      {
        operation: {
          type: 'string',
          enum: ['json.parse', 'csv.parse', 'text.clean', 'aggregate'],
          description: '要执行的数据处理操作。'
        },
        data: {
          type: 'string',
          description: '输入数据文本（JSON / CSV / 纯文本）。'
        },
        options: {
          type: 'object',
          description:
            '操作相关参数：json.parse→{path?}; csv.parse→{delimiter?,hasHeader?}; ' +
            'text.clean→{modes?:string[]}; aggregate→{field?,metrics?:string[],groupBy?}。'
        }
      },
      ['operation', 'data']
    ),
    async (args: Record<string, unknown>) => {
      const operation = args.operation ? String(args.operation) : '';
      if (!operation) return 'error: 缺少 operation';
      const data = args.data == null ? '' : String(args.data);
      const options =
        args.options && typeof args.options === 'object' && !Array.isArray(args.options)
          ? (args.options as Record<string, unknown>)
          : {};

      try {
        switch (operation) {
          case 'json.parse': {
            const parsed = JSON.parse(data);
            const path = typeof options.path === 'string' ? options.path : '';
            const result = path ? getPath(parsed, path) : parsed;
            return JSON.stringify(result);
          }
          case 'csv.parse': {
            const delimiter =
              typeof options.delimiter === 'string' && options.delimiter
                ? options.delimiter
                : ',';
            const hasHeader = options.hasHeader !== false; // 默认有表头
            if (!data.trim()) return 'error: 空 CSV 数据';
            return JSON.stringify(parseCsv(data, delimiter, hasHeader));
          }
          case 'text.clean': {
            const rawModes = Array.isArray(options.modes)
              ? options.modes.map((m) => String(m))
              : [];
            const modes = rawModes.length ? rawModes : ['trim', 'collapse'];
            return cleanText(data, modes);
          }
          case 'aggregate': {
            let arr: Json[];
            try {
              arr = JSON.parse(data);
            } catch {
              return 'error: aggregate 需要 JSON 数组输入';
            }
            if (!Array.isArray(arr)) return 'error: aggregate 需要 JSON 数组输入';
            const field = typeof options.field === 'string' ? options.field : '';
            const metricsRaw = Array.isArray(options.metrics)
              ? options.metrics.map((m) => String(m))
              : [];
            const metrics = metricsRaw.length
              ? metricsRaw
              : ['count', 'sum', 'avg', 'min', 'max'];
            const groupBy = typeof options.groupBy === 'string' ? options.groupBy : '';

            if (groupBy) {
              const groups = new Map<string, Json[]>();
              for (const item of arr) {
                const key = String(getPath(item, groupBy) ?? 'null');
                const g = groups.get(key) ?? [];
                g.push(item);
                groups.set(key, g);
              }
              const out: Record<string, unknown> = {};
              for (const [key, items] of groups) {
                out[key] = aggregateItems(items, field, metrics);
              }
              return JSON.stringify({ groupedBy: groupBy, groups: out, totalGroups: groups.size });
            }
            return JSON.stringify(aggregateItems(arr, field, metrics));
          }
          default:
            return `error: 未知 operation "${operation}"`;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );
}

/** 在一个 JSON 数组上计算给定指标。field 为空时仅统计 count。 */
function aggregateItems(
  arr: Json[],
  field: string,
  metrics: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = { count: arr.length };
  if (!field) return out;
  const nums: number[] = [];
  for (const item of arr) {
    const v = getPath(item, field);
    const n = toNum(v);
    if (n !== undefined) nums.push(n);
  }
  if (metrics.includes('sum')) {
    out.sum = nums.reduce((a, b) => a + b, 0);
  }
  if (metrics.includes('avg')) {
    out.avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  if (metrics.includes('min')) {
    out.min = nums.length ? Math.min(...nums) : null;
  }
  if (metrics.includes('max')) {
    out.max = nums.length ? Math.max(...nums) : null;
  }
  if (metrics.includes('countNumeric')) {
    out.countNumeric = nums.length;
  }
  return out;
}
