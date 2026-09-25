import { promises as fsp } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { objectParams, ToolRegistry } from '../tools';

export interface FilesystemOptions {
  root: string;
}

export function registerFilesystem(registry: ToolRegistry, opts: FilesystemOptions): void {
  const root = resolve(opts.root);
  // 词法层：将用户路径限制在 root 内；拒绝绝对路径与任何逃逸 root 的解析结果。
  const safe = (p: string): string => {
    if (isAbsolute(p)) throw new Error(`absolute paths not allowed: ${p}`);
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (rel.startsWith('..')) throw new Error(`path escapes root: ${p}`);
    return abs;
  };

  // 真实路径层（防 symlink 逃逸）：root 内的符号链接可能指向外部任意文件，
  // 词法校验拦不住。对「最近一个真实存在的祖先」做 fsp.realpath 解析后，
  // 与 realpath(root) 比对前缀；目标不存在时逐级上溯父目录（保留后缀段）。
  let realRootCache: string | null = null;
  const realRoot = async (): Promise<string> => {
    if (realRootCache) return realRootCache;
    try {
      realRootCache = await fsp.realpath(root);
    } catch {
      // root 本身尚不存在/不可解析：退回词法 root（后续读取自然报错）。
      realRootCache = root;
    }
    return realRootCache;
  };

  const safeReal = async (p: string): Promise<string> => {
    const abs = safe(p);
    const rr = await realRoot();
    let cur = abs;
    const suffix: string[] = [];
    for (;;) {
      try {
        const real = await fsp.realpath(cur);
        const realAbs = suffix.length ? join(real, ...suffix) : real;
        const rel = relative(rr, realAbs);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`path escapes root (symlink): ${p}`);
        }
        return realAbs;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') throw e;
        // 目标（或中间段）尚不存在：上溯到最近存在的祖先再拼回后缀。
        const parent = resolve(cur, '..');
        if (parent === cur) throw e;
        suffix.unshift(basename(cur));
        cur = parent;
      }
    }
  };

  registry.register(
    'builtin__fs_read',
    'Read a UTF-8 text file within the allowed root directory. Returns file content ' +
      '(truncated if very large).',
    objectParams({ path: { type: 'string', description: 'Path relative to the sandbox root.' } }, ['path']),
    async (args: Record<string, unknown>) => {
      const p = String(args.path ?? '');
      try {
        const abs = await safeReal(p);
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
        const abs = await safeReal(p);
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

  // 单次写入的字节上限（解码后）：防大 payload 撑爆沙箱盘与工具参数通道。
  const FS_WRITE_MAX_BYTES = 2 * 1024 * 1024;

  registry.register(
    'builtin__fs_write',
    'Write a file within the allowed root directory (parent dirs auto-created). ' +
      'Default encoding "utf-8" writes text; "base64" decodes content into binary bytes ' +
      '(e.g. images). Returns JSON {path, bytes}. Overwrites existing files.',
    objectParams(
      {
        path: { type: 'string', description: 'Path relative to the sandbox root.' },
        content: {
          type: 'string',
          description: 'File content: text (utf-8) or base64 string (encoding="base64").'
        },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'Content encoding; defaults to utf-8.'
        }
      },
      ['path', 'content']
    ),
    async (args: Record<string, unknown>) => {
      const p = String(args.path ?? '');
      const raw = String(args.content ?? '');
      const encoding = args.encoding === 'base64' ? 'base64' : 'utf-8';
      try {
        const abs = await safeReal(p);
        const buf =
          encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf-8');
        if (buf.length > FS_WRITE_MAX_BYTES) {
          return `error: content too large (${buf.length} bytes > ${FS_WRITE_MAX_BYTES})`;
        }
        await fsp.mkdir(resolve(abs, '..'), { recursive: true });
        await fsp.writeFile(abs, buf);
        // 返回相对 realRoot 的路径：与 fs_read/list 的入参约定一致（相对路径），
        // 模型可直接把该路径用于后续工具调用（相对 realRoot 时绝不产生绝对前缀）。
        return JSON.stringify({ path: relative(await realRoot(), abs), bytes: buf.length });
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
      const start = args.path ? await safeReal(String(args.path)) : await realRoot();
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
                  // 读取会跟随符号链接：先确认真实路径仍在 root 内。
                  const realAbs = await fsp.realpath(abs);
                  const relReal = relative(await realRoot(), realAbs);
                  if (relReal.startsWith('..') || isAbsolute(relReal)) continue;
                  const c = await fsp.readFile(realAbs, 'utf-8');
                  if (!c.includes(contentQ)) continue;
                } catch {
                  continue;
                }
              }
              results.push(relative(await realRoot(), abs));
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
