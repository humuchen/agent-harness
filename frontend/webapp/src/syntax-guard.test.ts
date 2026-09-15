import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * 样式模块语法守卫。
 *
 * 背景：本仓的样式以 `css` 标签模板承载。模板字面量**不认注释** ——
 * 哪怕反引号写在块注释（斜杠星号 …… 星号斜杠）里，它依然会终止模板，
 * 后续 CSS 会被当成 JS 解析。两种后果都很难在开发期发现：
 *
 *   1. 硬失败：解析报错，但只有在 `vite build`（rolldown）阶段才暴露，
 *      且聚合后的报错指向「绑定错误」而非具体那一行 —— 本地 `vitest` 会
 *      莫名其妙地整仓库崩溃，线上（Render）构建则直接挂掉。真实事故：
 *      `styles/responsive.ts:77` 的注释里写了反引号，线上 mobile 构建失败。
 *   2. 静默截断：反引号成对出现、且中间内容恰好是合法 JS 时，文件**能解析通过**，
 *      但 `css` 只拿到前半段 —— 样式静默丢失，没有任何报错。
 *
 * 因此这里断言两层：全量语法解析（抓硬失败）+ 样式模块模板内未闭合的块注释
 * （抓静默截断）。修复手法统一为：注释里的引用改用「」。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.workbuddy']);

interface Issue {
  file: string;
  line: number;
  column: number;
  message: string;
}

/** 样式模块：`css` 模板的主要栖息地（含 chat-styles.ts 这种聚合入口）。 */
function isStyleModule(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return p.startsWith('styles/') || p === 'chat-styles.ts';
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 偏移 → 1 基的行列号（自建行首索引，避免为定位反复构造 AST）。 */
function makeLocator(src: string): (offset: number) => { line: number; column: number } {
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && (lineStarts.at(line + 1) ?? Infinity) <= offset) {
      line++;
    }
    return { line: line + 1, column: offset - (lineStarts.at(line) ?? 0) + 1 };
  };
}

/**
 * 取单文件的语法诊断。
 *
 * 用公开 API `transpileModule(reportDiagnostics)` 而非 `SourceFile.parseDiagnostics`
 * —— 后者是 TypeScript 内部字段、不在公开类型里。语义上也更贴切：它走的正是
 * 打包器（esbuild / rolldown）对单个模块所做的「解析 + 变换」，故它报错即构建报错。
 */
function getSyntaxIssues(file: string, rel: string, src: string): Issue[] {
  const { diagnostics } = ts.transpileModule(src, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext
    }
  });
  const locate = makeLocator(src);
  return (diagnostics ?? []).map((d) => {
    const pos = locate(d.start ?? 0);
    return {
      file: rel,
      line: pos.line,
      column: pos.column,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' ')
    };
  });
}

/** 样式模块内出现未闭合的块注释 —— 通常是反引号把模板提前截断了。 */
function getTruncationIssues(file: string, rel: string, src: string): Issue[] {
  if (!isStyleModule(rel)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const locate = makeLocator(src);
  const issues: Issue[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isTemplateLiteral(node)) {
      const raw = node.getText(sf);
      const text = raw.slice(1, raw.endsWith('`') ? -1 : undefined);
      const open = text.indexOf('/*');
      if (open !== -1 && text.indexOf('*/', open) === -1) {
        const pos = locate(node.getStart(sf));
        issues.push({
          file: rel,
          line: pos.line,
          column: pos.column,
          message: '模板字面量内含未闭合的块注释 —— 注释里的反引号把模板提前截断了（改用「」）'
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return issues;
}

function format(sources: Map<string, string>, issues: Issue[]): string {
  return issues
    .slice(0, 10)
    .map((i) => {
      const line = (sources.get(i.file) ?? '').split(/\r?\n/)[i.line - 1] ?? '';
      return `  ${i.file}:${i.line}:${i.column}  ${i.message}\n      > ${line.trim().slice(0, 120)}`;
    })
    .join('\n');
}

describe('样式模块语法守卫', () => {
  const files = collectSourceFiles(SRC_DIR).map((f) => ({
    file: f,
    rel: path.relative(SRC_DIR, f).replace(/\\/g, '/'),
    src: fs.readFileSync(f, 'utf8')
  }));
  const sources = new Map(files.map((f) => [f.rel, f.src]));

  it('存在可扫描的源码文件（守卫本身未被静默跳过）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('全部源码可被解析（无提前终止的模板字面量）', () => {
    const issues = files.flatMap((f) => getSyntaxIssues(f.file, f.rel, f.src));
    expect(issues, `发现 ${issues.length} 处语法错误（仅在构建阶段暴露）：\n${format(sources, issues)}`).toEqual([]);
  });

  it('样式模块内不存在被截断的模板（静默丢样式）', () => {
    const issues = files.flatMap((f) => getTruncationIssues(f.file, f.rel, f.src));
    expect(issues, `发现 ${issues.length} 处可疑的模板截断：\n${format(sources, issues)}`).toEqual([]);
  });
});
