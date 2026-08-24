/**
 * 本地零依赖环境后端（LocalEnvPlatform）。
 *
 * 不依赖 Harness / Kubernetes / Docker，纯用 Node 内置 API 真正起一个预览服务：
 * - 为每个 env 分配独立目录 `ENV_LOCAL_ROOT/<envId>` 并写入一张预览页（含分支/owner/创建时间/TTL）；
 * - 起一个 `node:http` 静态服务暴露 `http://<host>:<port>`，端口由系统自动分配（无冲突）；
 * - 按 `ttlHours` 注册定时器，到期自动销毁（成本护栏）；
 * - 销毁时关闭服务、清定时器、删除目录。
 *
 * 这让它成为"自助环境治理闭环"的**开箱即真实可跑**后端：Agent 调 create → 拿到可访问 URL
 * → 用户可打开 → Agent 调 destroy → URL 下线。适合本地验证、内部小团队、演示，也是 K8s
 * 后端之外的轻量替代。所有改动均进程内，无外部依赖，与核心 framework 零耦合。
 */
import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import type { EphemeralEnvInput, EnvHandle } from './env-platform.types';
import type { EnvPlatform } from './env-platform';

interface LocalEnvRecord {
  envId: string;
  port: number;
  url: string;
  dir: string;
  server: Server;
  timer?: ReturnType<typeof setTimeout>;
  branch: string;
  owner?: string;
  ttlHours: number;
  createdAt: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'env';
}

export class LocalEnvPlatform implements EnvPlatform {
  readonly kind = 'local' as const;
  readonly dryRun = false;
  private root: string;
  private host: string;
  private envs = new Map<string, LocalEnvRecord>();

  constructor(opts: { root?: string; host?: string } = {}) {
    this.root = opts.root ?? process.env.ENV_LOCAL_ROOT ?? './data/previews';
    this.host = opts.host ?? process.env.ENV_LOCAL_HOST ?? 'localhost';
  }

  async createEphemeralEnvironment(input: EphemeralEnvInput): Promise<EnvHandle> {
    const envId = safeName(input.envId ?? `env-${Date.now()}`);
    const dir = join(this.root, envId);
    await mkdir(dir, { recursive: true });
    const ttlHours = input.ttlHours ?? 8;
    const createdAt = Date.now();
    const page = buildPreviewPage({ envId, branch: input.branch, owner: input.owner, ttlHours, createdAt });
    await writeFile(join(dir, 'index.html'), page, 'utf-8');
    const { port, server, url } = await this.startServer(dir);
    const rec: LocalEnvRecord = {
      envId,
      port,
      url,
      dir,
      server,
      branch: input.branch,
      owner: input.owner,
      ttlHours,
      createdAt,
    };
    if (ttlHours > 0) {
      rec.timer = setTimeout(() => {
        this.destroyEnvironment({ envId }).catch(() => {});
      }, ttlHours * 3600 * 1000);
    }
    this.envs.set(envId, rec);
    return { envId, envUrl: url, status: 'ready', executionId: `local:${port}` };
  }

  async destroyEnvironment(input: { envId: string }): Promise<EnvHandle> {
    const envId = safeName(input.envId);
    const rec = this.envs.get(envId);
    if (!rec) {
      return { envId, envUrl: '', status: 'destroyed' };
    }
    if (rec.timer) clearTimeout(rec.timer);
    await new Promise<void>((resolve) => {
      try {
        rec.server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    await rm(rec.dir, { recursive: true, force: true }).catch(() => {});
    this.envs.delete(envId);
    return { envId, envUrl: '', status: 'destroyed', executionId: `local:${rec.port}` };
  }

  async createEphemeralEnvironmentWithEvents(
    input: EphemeralEnvInput,
    onStage: (status: string) => void
  ): Promise<EnvHandle> {
    onStage('PROVISIONING');
    await sleep(300);
    onStage('RUNNING');
    await sleep(500);
    const handle = await this.createEphemeralEnvironment(input);
    onStage('READY');
    return handle;
  }

  async destroyEnvironmentWithEvents(
    input: { envId: string },
    onStage: (status: string) => void
  ): Promise<EnvHandle> {
    onStage('DESTROYING');
    await sleep(300);
    const handle = await this.destroyEnvironment(input);
    onStage('DESTROYED');
    return handle;
  }

  async getStatus(envId: string): Promise<string | undefined> {
    const rec = this.envs.get(safeName(envId));
    return rec ? 'ready' : undefined;
  }

  /** 启动一个静态文件服务并解析出真实端口（listen(0) 由系统分配，避免冲突）。 */
  private startServer(dir: string): Promise<{ port: number; server: Server; url: string }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res, dir).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('internal error');
          }
        });
      });
      server.on('error', reject);
      server.listen(0, this.host, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const url = `http://${this.host}:${port}`;
        resolve({ port, server, url });
      });
    });
  }

  private async handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    dir: string
  ): Promise<void> {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] || '/');
    // 防目录穿越：归一化后必须仍落在 dir 内。
    const target = normalize(join(dir, urlPath));
    if (!target.startsWith(dir + sep) && target !== dir) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    let filePath = target;
    try {
      const stat = await import('node:fs/promises').then((fs) => fs.stat(filePath));
      if (stat.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
      // 文件不存在：回退到 index.html（SPA 风格）
      filePath = join(dir, 'index.html');
    }
    try {
      const body = await readFile(filePath);
      const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  /** 列出当前仍在运行的环境（运维/调试用）。 */
  listEnvs(): LocalEnvRecord[] {
    return [...this.envs.values()];
  }

  /** 关闭所有环境（进程优雅停机时调用）。 */
  async shutdown(): Promise<void> {
    await Promise.all([...this.envs.keys()].map((id) => this.destroyEnvironment({ envId: id })));
  }
}

function buildPreviewPage(opts: {
  envId: string;
  branch: string;
  owner?: string;
  ttlHours: number;
  createdAt: number;
}): string {
  const t = new Date(opts.createdAt).toISOString();
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>预览环境 ${opts.envId}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#e6edf3;background:#0e1116}
.code{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.k{color:#8b949e}</style></head>
<body>
<h1>预览环境已就绪</h1>
<p>这是一个由 <b>LocalEnvPlatform</b> 真实拉起的临时/预览环境（非 dry-run）。</p>
<div class="code">
<div><span class="k">envId&nbsp;&nbsp;:</span> ${opts.envId}</div>
<div><span class="k">branch&nbsp;:</span> ${opts.branch}</div>
<div><span class="k">owner&nbsp;&nbsp;:</span> ${opts.owner ?? '(未指定)'}</div>
<div><span class="k">ttl&nbsp;&nbsp;&nbsp;&nbsp;:</span> ${opts.ttlHours}h 后自动销毁</div>
<div><span class="k">created:</span> ${t}</div>
</div>
<p>把你的应用构建产物放进此目录，即可通过本 URL 对外提供预览。Agent 调用 <code>destroy_environment</code> 后此环境会被销毁。</p>
</body></html>`;
}
