/**
 * 工件存储（Artifact Store）。
 *
 * 持久化 Agent 运行产生的「工件」——任意二进制 / 文本产物（导出文件、截图、报告等）。
 * 设计沿用本项目一贯的「接口 + 默认实现 + 组合工厂」：
 * - `ArtifactStore` 是契约（list / get / save / readContent / remove）；
 * - 默认实现 `LocalArtifactStore` 把索引写 `<ARTIFACT_DIR>/index.json`、把字节写 `<ARTIFACT_DIR>/files/<id>`；
 * - `S3ArtifactStore`（`./artifact-store-s3.js`）把同一模型落到 S3 兼容对象存储，
 *   供 Render 等临时盘环境跨重启保留工件（P5.7）；
 * - 工厂按环境变量选择后端：`ARTIFACT_STORE=s3` 且配置了 S3_BUCKET 时用 S3，否则本地盘。
 *
 * 安全：id 仅接受合法 UUID（`crypto.randomUUID()`），所有按 id 的文件访问都经过 `safeId` 校验，
 * 杜绝 `../` 路径遍历；除同包的 atomic-write（索引原子落盘）外不依赖其它项目模块。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteJson } from './atomic-write';

export interface ArtifactMeta {
  id: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  owner: string;
  createdAt: string;
  runId?: string;
  note?: string;
}

export interface SaveArtifactInput {
  name: string;
  kind: string;
  mimeType: string;
  content: Buffer;
  owner: string;
  runId?: string;
  note?: string;
}

export interface ArtifactStore {
  /** 列出全部工件（最新在前）；传 runId 时仅返回该 run 归档的工件（P4.6 计划桥交付文件按 run 拉取）。 */
  list(runId?: string): Promise<ArtifactMeta[]>;
  get(id: string): Promise<ArtifactMeta | null>;
  save(input: SaveArtifactInput): Promise<ArtifactMeta>;
  readContent(id: string): Promise<Buffer | null>;
  remove(id: string): Promise<boolean>;
}

/** 仅允许合法 UUID 作为 id，杜绝路径遍历（如 `../etc/passwd`）。 */
export function safeId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** 人类可读文件大小：B / KB / MB。导出便于测试与前端复用。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly filesDir: string;
  /**
   * 索引读-改-写互斥链（P1 修复）：save / remove 都执行「读 index → 修改 → 写回」，
   * 并发时互相覆盖丢条目（Promise 均为微任务交错，非原子）。用 promise 链串行化
   * 单进程内的临界区；多副本部署应使用 S3 后端（其内部按对象存储原子性处理）。
   */
  private indexChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    // resolve 保证基于绝对/相对目录的落盘位置确定，不随进程 cwd 漂移。
    this.dir = resolve(dir);
    this.filesDir = join(this.dir, 'files');
    this.indexPath = join(this.dir, 'index.json');
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true });
  }

  private async readIndex(): Promise<ArtifactMeta[]> {
    if (!existsSync(this.indexPath)) return [];
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ArtifactMeta[]) : [];
    } catch {
      // 索引损坏：回落空列表，避免端点 5xx（最坏情况丢失索引，文件仍可手动找回）。
      return [];
    }
  }

  private async writeIndex(items: ArtifactMeta[]): Promise<void> {
    // P1 修复：改用 tmp→rename 原子写（复用 atomic-write.ts；此前直接 writeFile，
    // 崩溃时留下半截 JSON——虽有「解析失败回落空列表」兜底，但表现为「看起来丢数据」）。
    atomicWriteJson(this.indexPath, items);
  }

  async list(runId?: string): Promise<ArtifactMeta[]> {
    const items = await this.readIndex();
    // 最新创建在前。
    return items
      .filter((m) => (runId ? m.runId === runId : true))
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async get(id: string): Promise<ArtifactMeta | null> {
    if (!safeId(id)) return null;
    const items = await this.readIndex();
    return items.find((m) => m.id === id) ?? null;
  }

  async save(input: SaveArtifactInput): Promise<ArtifactMeta> {
    await this.ensureDirs();
    const id = randomUUID();
    const meta: ArtifactMeta = {
      id,
      name: input.name,
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.content.length,
      owner: input.owner,
      createdAt: new Date().toISOString(),
      runId: input.runId,
      note: input.note
    };
    await writeFile(join(this.filesDir, id), input.content);
    // P1 修复：读-改-写段进互斥链，防并发 save/remove 互相覆盖索引条目。
    await (this.indexChain = this.indexChain.then(async () => {
      const items = await this.readIndex();
      items.push(meta);
      await this.writeIndex(items);
    }));
    return meta;
  }

  async readContent(id: string): Promise<Buffer | null> {
    if (!safeId(id)) return null;
    const file = join(this.filesDir, id);
    if (!existsSync(file)) return null;
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<boolean> {
    if (!safeId(id)) return false;
    // P1 修复：与 save 同一互斥链，防并发读改写互相覆盖。
    let removed = false;
    await (this.indexChain = this.indexChain.then(async () => {
      const items = await this.readIndex();
      const idx = items.findIndex((m) => m.id === id);
      if (idx === -1) return;
      const file = join(this.filesDir, id);
      if (existsSync(file)) {
        try {
          await unlink(file);
        } catch {
          /* 文件删除失败（如权限）不影响索引清理，仍视为已移除条目。 */
        }
      }
      items.splice(idx, 1);
      await this.writeIndex(items);
      removed = true;
    }));
    return removed;
  }
}

let storeSingleton: ArtifactStore | null = null;

/**
 * 组合工厂：按环境变量选择后端（P5.7）。
 * - `ARTIFACT_STORE=s3` 且 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY 齐备
 *   → `S3ArtifactStore`（S3 兼容对象存储，跨重启 / 临时盘环境保留工件）；
 * - 否则 → `LocalArtifactStore`，落盘目录 `ARTIFACT_DIR`（默认 `.data/artifacts`）。
 * 切换后端不迁移历史数据（两种后端索引格式一致，本地旧工件需手动导入）。
 */
export function getArtifactStore(env: NodeJS.ProcessEnv = process.env): ArtifactStore {
  if (!storeSingleton) {
    if (env.ARTIFACT_STORE === 's3') {
      // 惰性 require：仅 S3 后端加载该模块，避免本地部署无谓加载（同时规避静态循环依赖）。
      const { S3ArtifactStore } =
        require('./artifact-store-s3.js') as typeof import('./artifact-store-s3.js');
      const s3 = S3ArtifactStore.fromEnv(env);
      if (!s3) {
        throw new Error(
          'ARTIFACT_STORE=s3 但缺少 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY 配置'
        );
      }
      storeSingleton = s3;
    } else {
      const dir = env.ARTIFACT_DIR || '.data/artifacts';
      storeSingleton = new LocalArtifactStore(dir);
    }
  }
  return storeSingleton;
}

/** 供测试注入自定义 store（传 null 重置单例）。 */
export function setArtifactStore(s: ArtifactStore | null): void {
  storeSingleton = s;
}
