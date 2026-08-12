import { promises as fsp } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { objectParams, ToolRegistry } from '../tools';

export interface FilesystemOptions {
  root: string;
}

export function registerFilesystem(registry: ToolRegistry, opts: FilesystemOptions): void {
  const root = resolve(opts.root);
  // 将用户路径限制在 root 内；拒绝绝对路径与任何逃逸 root 的解析结果。
  const safe = (p: string): string => {
    if (isAbsolute(p)) throw new Error(`absolute paths not allowed: ${p}`);
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (rel.startsWith('..')) throw new Error(`path escapes root: ${p}`);
    return abs;
  };

  registry.register(
    'builtin__fs_read',
    'Read a UTF-8 text file within the allowed root directory. Returns file content ' +
      '(truncated if very large).',
    objectParams({ path: { type: 'string', description: 'Path relative to the sandbox root.' } }, ['path']),
    async (args: Record<string, unknown>) => {
      const p = String(args.path ?? '');
      try {
        const abs = safe(p);
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) return 'error: is a directory, use builtin__fs_list';
        const buf = await fsp.readFile(abs, 'utf-8');
        const cap = 200_000;
        const text = buf.length > cap ? buf.slice(0, cap) + '\n...[truncated]' : buf;
        return text;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );

  registry.register(
    'builtin__fs_list',
    'List entries of a directory within the allowed root. Returns names with type (file/dir).',
    objectParams(
      { path: { type: 'string', description: 'Directory path relative to root; defaults to root.' } },
      []
    ),
    async (args: Record<string, unknown>) => {
      const p = args.path ? String(args.path) : '.';
      try {
        const abs = safe(p);
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        const list = entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
        return JSON.stringify(list);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );

  registry.register(
    'builtin__fs_search',
    'Search files under the root whose name contains `name_contains` (and optionally whose ' +
      'content contains `content_contains`). Returns up to 50 matching relative paths.',
    objectParams(
      {
        name_contains: { type: 'string', description: 'Substring to match in file names.' },
        content_contains: { type: 'string', description: 'Optional substring to match in file contents.' },
        path: { type: 'string', description: 'Start directory relative to root (default root).' },
      },
      []
    ),
    async (args: Record<string, unknown>) => {
      const nameQ = args.name_contains ? String(args.name_contains) : '';
      const contentQ = args.content_contains ? String(args.content_contains) : '';
      const start = args.path ? safe(String(args.path)) : root;
      try {
        const results: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          if (results.length >= 50) return;
          const entries = await fsp.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (results.length >= 50) return;
            const abs = join(dir, e.name);
            if (e.isDirectory()) {
              await walk(abs);
            } else {
              if (nameQ && !e.name.includes(nameQ)) continue;
              if (contentQ) {
                try {
                  const c = await fsp.readFile(abs, 'utf-8');
                  if (!c.includes(contentQ)) continue;
                } catch {
                  continue;
                }
              }
              results.push(relative(root, abs));
            }
          }
        };
        await walk(start);
        return JSON.stringify({ matches: results, count: results.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );
}
