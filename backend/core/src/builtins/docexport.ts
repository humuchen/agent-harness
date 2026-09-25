import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import { objectParams, ToolRegistry } from '../tools';

/**
 * 文件导出工具（P-交付闭环）：把结构化内容生成**真实文件**（.xlsx / .pptx / .csv），
 * 落到沙箱 root 的 `exports/` 目录下，供 `builtin__deliver_file`（server 侧）注册进
 * artifact-store 出现在「📎 交付文件」区，或经 `builtin__fs_read` 验读。
 *
 * 依赖纪律（与 OpenTelemetry 同款「可选依赖 + 优雅降级」先例）：
 * - exceljs / pptxgenjs 声明在 core 的 optionalDependencies；缺失时工具**注册不受影响**，
 *   调用时返回带安装指引的可操作错误，零依赖环境（CI 最小安装）不炸。
 * - csv 为纯 Node 零依赖实现，任何环境可用。
 *
 * 安全：文件名只取 basename 并白名单化扩展名；落盘路径恒在 `<root>/exports/` 内，
 * 复用 fs 工具同款「锁定 root」思路；单文件字节上限防大 payload 撑爆磁盘。
 */

export interface DocExportOptions {
  /** 导出根目录（文件恒写入 `<root>/exports/`）；默认 process.cwd()。 */
  root?: string;
}

/** 单文件字节上限（xlsx/pptx 为 zip 容器，几 MB 内绰绰有余）。 */
const DOC_EXPORT_MAX_BYTES = 16 * 1024 * 1024;

// ── exceljs 最小面（本地接口，避免编译期依赖可选包的类型） ──
interface ExcelJsWorksheet {
  addRows(rows: unknown[][]): void;
}
interface ExcelJsWorkbook {
  addWorksheet(name: string): ExcelJsWorksheet;
  xlsx: { writeFile(path: string): Promise<void> };
}
interface ExcelJsModule {
  Workbook: new () => ExcelJsWorkbook;
}

// ── pptxgenjs 最小面 ──
interface PptxSlide {
  addText(text: unknown, opts: Record<string, unknown>): void;
  addNotes(notes: string): void;
}
interface PptxInstance {
  layout: string;
  addSlide(): PptxSlide;
  writeFile(opts: { fileName: string }): Promise<string>;
}
interface PptxModule {
  new (): PptxInstance;
}

/** 可选依赖加载：缺失返回 null（调用方给可操作错误），绝不抛出。 */
function loadExcelJs(): ExcelJsModule | null {
  try {
    return require('exceljs') as ExcelJsModule;
  } catch {
    return null;
  }
}

function loadPptxGenJs(): PptxModule | null {
  try {
    return require('pptxgenjs') as PptxModule;
  } catch {
    return null;
  }
}

/** 文件名安全化：去路径与非法字符、限长，空则回落默认名；并归一扩展名。 */
function sanitizeFilename(raw: string, format: 'xlsx' | 'pptx' | 'csv'): string {
  const base = (raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
  const fallback = `交付文件.${format}`;
  if (!base) return fallback;
  const ext = `.${format}`;
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

/** 工作表名安全化：exceljs 限 31 字符且禁 : \ / ? * [ ]。 */
function sanitizeSheetName(raw: string, fallback: string): string {
  const name = (raw || '')
    .replace(/[:\\/?*[\]]/g, ' ')
    .trim()
    .slice(0, 31);
  return name || fallback;
}

/**
 * 行数据归一化：接受二维数组 `[[a, b], ...]` 或对象数组 `[{a:1,b:2}, ...]`。
 * 对象数组：以首个对象的键序为表头，自动补首行；后续对象缺键补空串。
 * 其余值 String() 化（number 保留为 number 进 Excel/CSV）。
 */
function normalizeRows(rows: unknown): Array<Array<string | number>> {
  if (!Array.isArray(rows)) return [];
  const out: Array<Array<string | number>> = [];
  for (const item of rows) {
    if (Array.isArray(item)) {
      out.push(item.map((v) => (typeof v === 'number' ? v : String(v ?? ''))));
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      out.push(Object.keys(rec).map((k) => (typeof rec[k] === 'number' ? (rec[k] as number) : String(rec[k] ?? ''))));
    } else if (item != null) {
      out.push([String(item)]);
    }
  }
  return out;
}

/** RFC 4180 CSV 字段转义：含引号/逗号/换行的字段加引号并双写内部引号。 */
function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Array<string | number>>): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

/** 统一成功返回体（与 builtin__fs_write 同构）。 */
function ok(relPath: string, bytes: number, format: string): string {
  return JSON.stringify({ ok: true, format, path: relPath, bytes });
}

export function registerDocExport(registry: ToolRegistry, opts: DocExportOptions = {}): void {
  const root = resolve(opts.root ?? process.cwd());
  const exportsDir = join(root, 'exports');

  registry.register(
    'builtin__doc_export',
    'Generate a real downloadable file from structured data. Formats: ' +
      '"xlsx" (sheets=[{name, rows}]), "pptx" (slides=[{title, bullets, notes?}]), ' +
      '"csv" (rows). rows accept 2D arrays or object arrays (first object keys become the header). ' +
      'The file is written under exports/ in the sandbox; deliver it with builtin__deliver_file ' +
      'so the user can download it.',
    objectParams(
      {
        format: { type: 'string', enum: ['xlsx', 'pptx', 'csv'], description: '输出格式。' },
        filename: { type: 'string', description: '目标文件名（如「季度汇总.xlsx」，扩展名自动归一）。' },
        sheets: {
          type: 'array',
          description: 'xlsx 专用：[{ name: 工作表名, rows: 二维数组或对象数组 }]。',
          items: { type: 'object' }
        },
        rows: {
          type: 'array',
          description: 'csv 专用：二维数组或对象数组（对象数组首行自动作表头）。',
          items: {}
        },
        slides: {
          type: 'array',
          description: 'pptx 专用：[{ title: 页标题, bullets: string[], notes?: 演讲备注 }]。',
          items: { type: 'object' }
        }
      },
      ['format', 'filename']
    ),
    async (args: Record<string, unknown>) => {
      const format = String(args.format ?? '') as 'xlsx' | 'pptx' | 'csv';
      const filename = sanitizeFilename(String(args.filename ?? ''), format);
      try {
        await fsp.mkdir(exportsDir, { recursive: true });
        const abs = join(exportsDir, filename);
        let bytes = 0;

        if (format === 'csv') {
          const rows = normalizeRows(args.rows);
          if (!rows.length) return 'error: csv 需要非空 rows（二维数组或对象数组）';
          const buf = Buffer.from(toCsv(rows), 'utf-8');
          if (buf.length > DOC_EXPORT_MAX_BYTES) return `error: 文件过大（${buf.length} bytes）`;
          await fsp.writeFile(abs, buf);
          bytes = buf.length;
        } else if (format === 'xlsx') {
          const ExcelJs = loadExcelJs();
          if (!ExcelJs) {
            return (
              'error: xlsx 生成器未安装（可选依赖 exceljs 缺失）。请在仓库根目录执行 ' +
              '`pnpm install` 后重试；或降级用 format="csv" 产出表格文本。'
            );
          }
          const rawSheets = Array.isArray(args.sheets) ? args.sheets : [];
          if (!rawSheets.length) return 'error: xlsx 需要非空 sheets（[{ name, rows }]）';
          const wb = new ExcelJs.Workbook();
          rawSheets.forEach((s, i) => {
            const rec = (s ?? {}) as Record<string, unknown>;
            const ws = wb.addWorksheet(sanitizeSheetName(String(rec.name ?? ''), `Sheet${i + 1}`));
            const rows = normalizeRows(rec.rows);
            if (rows.length) ws.addRows(rows);
          });
          await wb.xlsx.writeFile(abs);
          const st = await fsp.stat(abs);
          bytes = st.size;
        } else {
          const PptxGenJs = loadPptxGenJs();
          if (!PptxGenJs) {
            return (
              'error: pptx 生成器未安装（可选依赖 pptxgenjs 缺失）。请在仓库根目录执行 ' +
              '`pnpm install` 后重试；或先用 builtin__fs_write 落大纲文本兜底。'
            );
          }
          const rawSlides = Array.isArray(args.slides) ? args.slides : [];
          if (!rawSlides.length) return 'error: pptx 需要非空 slides（[{ title, bullets, notes? }]）';
          const pptx = new PptxGenJs();
          pptx.layout = 'LAYOUT_16x9';
          for (const s of rawSlides) {
            const rec = (s ?? {}) as Record<string, unknown>;
            const title = String(rec.title ?? '').trim();
            if (!title) continue;
            const slide = pptx.addSlide();
            slide.addText(title, { x: 0.5, y: 0.35, w: 9, h: 0.8, fontSize: 24, bold: true });
            const bullets = Array.isArray(rec.bullets)
              ? (rec.bullets as unknown[]).map((b) => ({ text: String(b ?? ''), options: { bullet: true } }))
              : [];
            if (bullets.length) {
              slide.addText(bullets, { x: 0.8, y: 1.4, w: 8.4, h: 3.5, fontSize: 14 });
            }
            const notes = typeof rec.notes === 'string' ? rec.notes.trim() : '';
            if (notes) slide.addNotes(notes);
          }
          await pptx.writeFile({ fileName: abs });
          const st = await fsp.stat(abs);
          bytes = st.size;
        }

        return ok(join('exports', filename), bytes, format);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );
}
