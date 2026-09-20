/**
 * 工件存储 —— S3 兼容对象存储后端（P5.7）。
 *
 * 与 `LocalArtifactStore` 实现同一 `ArtifactStore` 契约，把工件落到任意
 * S3 兼容对象存储（AWS S3 / Cloudflare R2 / MinIO / Render Object Storage），
 * 使成果物在 Render free plan 临时盘上也能跨重启 / 重部署保留。
 *
 * 设计要点：
 * - **零依赖**：SigV4 签名用 node:crypto 手写，HTTP 走 Node 22 全局 fetch，
 *   不引入 @aws-sdk（>10MB），部署体积与冷启动不受影响；
 * - **复用本地版的「索引 + 字节」模型**：`<prefix>/index.json` 存元数据数组、
 *   `<prefix>/files/<id>` 存字节，因此只需 GetObject / PutObject / DeleteObject
 *   三个操作，不需要 ListObjects（权限可收敛到这三个动作）；
 * - **寻址风格**：配置了 `S3_ENDPOINT`（R2 / MinIO / Render）走 path-style；
 *   未配置（原生 AWS）默认 virtual-host style（`bucket.s3.<region>.amazonaws.com`），
 *   可用 `S3_FORCE_PATH_STYLE=1` 强制 path-style；
 * - 安全：id 仍经过 `safeId` UUID 校验（与本地版一致），杜绝任意 key 注入；
 * - 并发：进程内用 promise 队列串行化「读索引→改→写回」，避免同一进程内
 *   并发 save/remove 互相覆盖（跨进程竞态与本地版语义相同，不额外上锁）。
 *
 * 环境变量（全部可注入，便于测试指向本地 stub）：
 * - `S3_BUCKET`            必填，桶名
 * - `S3_ACCESS_KEY_ID`     必填
 * - `S3_SECRET_ACCESS_KEY` 必填
 * - `S3_REGION`            默认 us-east-1
 * - `S3_ENDPOINT`          可选，S3 兼容端点（如 https://<account>.r2.cloudflarestorage.com）
 * - `S3_FORCE_PATH_STYLE`  '1'/'true' 时强制 path-style（默认：有 endpoint 即 path-style）
 * - `S3_PREFIX`            对象 key 前缀，默认 'artifacts'
 *
 * 模块自包含：除复用 `artifact-store.ts` 的契约类型与 `safeId` 外，不 import 任何其它项目模块。
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { ArtifactMeta, ArtifactStore, SaveArtifactInput } from './artifact-store.js';
import { safeId } from './artifact-store.js';

export interface S3ArtifactStoreOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** S3 兼容端点（含协议，不含尾斜杠）；缺省为原生 AWS virtual-host style。 */
  endpoint?: string;
  /** 强制 path-style 寻址。 */
  forcePathStyle?: boolean;
  /** 对象 key 前缀，默认 'artifacts'。 */
  prefix?: string;
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf-8').digest();
}

/** RFC 3986 逐段编码（encodeURIComponent 保留 `-_.!~*'()`，足够 S3 key 使用）。 */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export class S3ArtifactStore implements ArtifactStore {
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly region: string;
  private readonly endpoint?: string;
  private readonly forcePathStyle: boolean;
  private readonly prefix: string;
  /** 进程内写队列：串行化索引读改写，避免并发 save/remove 丢条目。 */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: S3ArtifactStoreOptions) {
    if (!opts.bucket) throw new Error('S3ArtifactStore: bucket is required');
    if (!opts.accessKeyId || !opts.secretAccessKey) {
      throw new Error('S3ArtifactStore: accessKeyId / secretAccessKey are required');
    }
    this.bucket = opts.bucket;
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.region = opts.region || 'us-east-1';
    this.endpoint = opts.endpoint?.replace(/\/+$/, '') || undefined;
    this.forcePathStyle = opts.forcePathStyle === true;
    this.prefix = (opts.prefix || 'artifacts').replace(/^\/+|\/+$/g, '');
  }

  /** 从环境变量构建（getArtifactStore 工厂使用）；缺关键变量返回 null。 */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): S3ArtifactStore | null {
    const bucket = env.S3_BUCKET || '';
    const accessKeyId = env.S3_ACCESS_KEY_ID || '';
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY || '';
    if (!bucket || !accessKeyId || !secretAccessKey) return null;
    return new S3ArtifactStore({
      bucket,
      accessKeyId,
      secretAccessKey,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle:
        env.S3_FORCE_PATH_STYLE === '1' || env.S3_FORCE_PATH_STYLE === 'true',
      prefix: env.S3_PREFIX || undefined
    });
  }

  private indexKey(): string {
    return `${this.prefix}/index.json`;
  }

  private fileKey(id: string): string {
    return `${this.prefix}/files/${id}`;
  }

  private objectUrl(key: string): { url: URL; host: string } {
    if (this.endpoint) {
      // path-style：<endpoint>/<bucket>/<key>
      const url = new URL(`${this.endpoint}/${this.bucket}/${encodeKeyPath(key)}`);
      return { url, host: url.host };
    }
    // virtual-host style：<bucket>.s3.<region>.amazonaws.com/<key>
    const url = new URL(
      `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodeKeyPath(key)}`
    );
    return { url, host: url.host };
  }

  /**
   * SigV4 签名并发起单对象请求。
   * 返回 { status, body }；网络错误 / 非 S3 语义错误向上抛出。
   */
  private async s3Request(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    body?: Buffer
  ): Promise<{ status: number; body: Buffer }> {
    const { url, host } = this.objectUrl(key);
    const payload = body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);

    // amzdate：YYYYMMDDTHHMMSSZ；datestamp：YYYYMMDD
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const datestamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    const amzdate = `${datestamp}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

    // CanonicalRequest = Method \n CanonicalURI \n CanonicalQuery \n CanonicalHeaders \n SignedHeaders \n PayloadHash
    const canonicalUri = url.pathname;
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzdate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      method,
      canonicalUri,
      '', // 无查询参数
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const scope = `${datestamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzdate,
      scope,
      sha256Hex(canonicalRequest)
    ].join('\n');

    // SigningKey = HMAC(HMAC(HMAC(HMAC("AWS4<secret>", date), region), "s3"), "aws4_request")
    const kDate = hmac(`AWS4${this.secretAccessKey}`, datestamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf-8').digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(url, {
      method,
      headers: {
        authorization,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzdate
      },
      body: method === 'PUT' ? new Uint8Array(payload) : undefined
    });
    const resBody = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: resBody };
  }

  private async readIndexRaw(): Promise<ArtifactMeta[]> {
    const { status, body } = await this.s3Request('GET', this.indexKey());
    if (status === 404) return [];
    if (status !== 200) {
      throw new Error(`S3ArtifactStore: read index failed (HTTP ${status})`);
    }
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      return Array.isArray(parsed) ? (parsed as ArtifactMeta[]) : [];
    } catch {
      // 索引损坏：回落空列表（与本地版语义一致，最坏情况文件对象仍可手动找回）。
      return [];
    }
  }

  private async writeIndexRaw(items: ArtifactMeta[]): Promise<void> {
    const body = Buffer.from(JSON.stringify(items, null, 2), 'utf-8');
    const { status } = await this.s3Request('PUT', this.indexKey(), body);
    if (status !== 200) {
      throw new Error(`S3ArtifactStore: write index failed (HTTP ${status})`);
    }
  }

  /** 进程内串行化「读索引→mutate→写回」。 */
  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    // 队列继续向后传播（失败不阻塞后续写），但调用方拿到自己的结果/错误。
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async list(runId?: string): Promise<ArtifactMeta[]> {
    const items = await this.readIndexRaw();
    return items
      .filter((m) => (runId ? m.runId === runId : true))
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async get(id: string): Promise<ArtifactMeta | null> {
    if (!safeId(id)) return null;
    const items = await this.readIndexRaw();
    return items.find((m) => m.id === id) ?? null;
  }

  async save(input: SaveArtifactInput): Promise<ArtifactMeta> {
    const meta: ArtifactMeta = {
      id: (await import('node:crypto')).randomUUID(),
      name: input.name,
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.content.length,
      owner: input.owner,
      createdAt: new Date().toISOString(),
      runId: input.runId,
      note: input.note
    };
    return this.withIndexLock(async () => {
      // 先写字节对象，再写索引：索引里出现即意味着字节已就绪（读侧不会 404）。
      const put = await this.s3Request('PUT', this.fileKey(meta.id), input.content);
      if (put.status !== 200) {
        throw new Error(`S3ArtifactStore: put object failed (HTTP ${put.status})`);
      }
      const items = await this.readIndexRaw();
      items.push(meta);
      await this.writeIndexRaw(items);
      return meta;
    });
  }

  async readContent(id: string): Promise<Buffer | null> {
    if (!safeId(id)) return null;
    const { status, body } = await this.s3Request('GET', this.fileKey(id));
    if (status === 404) return null;
    if (status !== 200) {
      throw new Error(`S3ArtifactStore: get object failed (HTTP ${status})`);
    }
    return body;
  }

  async remove(id: string): Promise<boolean> {
    if (!safeId(id)) return false;
    return this.withIndexLock(async () => {
      const items = await this.readIndexRaw();
      const idx = items.findIndex((m) => m.id === id);
      if (idx === -1) return false;
      // 先删字节对象再清索引；对象删除失败不阻断索引清理（与本地版语义一致）。
      try {
        const del = await this.s3Request('DELETE', this.fileKey(id));
        if (del.status !== 200 && del.status !== 204 && del.status !== 404) {
          throw new Error(`S3ArtifactStore: delete object failed (HTTP ${del.status})`);
        }
      } catch {
        /* 删除失败不阻塞索引清理，仍视为已移除条目。 */
      }
      items.splice(idx, 1);
      await this.writeIndexRaw(items);
      return true;
    });
  }
}
