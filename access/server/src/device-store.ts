/**
 * 设备推送令牌存储（Device Push Token Store）。
 *
 * 持久化移动端的 FCM/APNs 推送令牌，用于服务端向指定设备发送推送通知。
 * 设计沿用本项目一贯的「接口 + 默认实现 + 组合工厂」：
 * - `DeviceStore` 是契约（register / unregister / list / resolve）；
 * - 默认实现 `FileDeviceStore` 把索引写 `<DEVICE_DIR>/index.json`；
 * - 后续可新增 `RedisDeviceStore` 实现同一接口，路由层零改动。
 *
 * 安全：owner 仅接受合法用户名格式；token 仅接受非空字符串。
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DeviceToken {
  id: string; // crypto.randomUUID()
  owner: string; // 用户名
  token: string; // FCM/APNs 设备令牌
  platform: 'ios' | 'android';
  createdAt: string;
  lastSeenAt: string;
}

export interface RegisterDeviceInput {
  owner: string;
  token: string;
  platform: 'ios' | 'android';
}

export interface DeviceStore {
  register(input: RegisterDeviceInput): Promise<DeviceToken>;
  unregister(id: string): Promise<boolean>;
  listByOwner(owner: string): Promise<DeviceToken[]>;
  /** 获取所有已注册的 token（用于广播推送） */
  listAll(): Promise<DeviceToken[]>;
}

/** 仅接受合法用户名格式（字母数字下划线连字符，1-64 字符）。 */
function safeUsername(u: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(u);
}

export class FileDeviceStore implements DeviceStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.indexPath = join(this.dir, 'index.json');
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async readIndex(): Promise<DeviceToken[]> {
    if (!existsSync(this.indexPath)) return [];
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as DeviceToken[]) : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(items: DeviceToken[]): Promise<void> {
    await this.ensureDirs();
    // P1 原子写修复：writeFile 直写 index.json——进程在写入中途崩溃会产生半截
    // JSON，下次读取 parse 失败回空数组 = **静默清空全部设备**。改 tmp + rename
    // 原子替换（与 memory/agents store 同模式）。
    const tmp = `${this.indexPath}.tmp.${process.pid}.${Date.now().toString(36)}`;
    try {
      await writeFile(tmp, JSON.stringify(items, null, 2), 'utf-8');
      const { rename } = await import('node:fs/promises');
      await rename(tmp, this.indexPath);
    } catch (e) {
      try {
        await unlink(tmp);
      } catch {
        /* 临时文件本就不存在 */
      }
      throw e;
    }
  }

  async register(input: RegisterDeviceInput): Promise<DeviceToken> {
    if (!safeUsername(input.owner)) {
      throw new Error('invalid owner username');
    }
    if (!input.token || typeof input.token !== 'string') {
      throw new Error('invalid device token');
    }

    const items = await this.readIndex();

    // P1 资源修复：per-owner 设备数上限——register 此前对每个新 token 无限写入
    //（端点仅要求 chat:read 且无速率限制），恶意客户端可刷爆 index.json。
    const MAX_DEVICES_PER_OWNER = Math.max(
      1,
      Number(process.env.DEVICE_MAX_PER_OWNER ?? 20) || 20
    );
    const ownerCount = items.filter((d) => d.owner === input.owner).length;
    if (
      ownerCount >= MAX_DEVICES_PER_OWNER &&
      !items.some((d) => d.token === input.token)
    ) {
      // 淘汰该 owner 最旧的设备（lastSeenAt 最小）腾位，保持最近活跃设备可用。
      const owned = items
        .filter((d) => d.owner === input.owner)
        .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
      const evict = owned[0];
      if (evict) {
        const idx = items.findIndex((d) => d.id === evict.id);
        if (idx !== -1) items.splice(idx, 1);
      }
    }

    // 幂等：同一 token 已存在则更新 lastSeenAt，不重复注册
    const existing = items.find((d) => d.token === input.token);
    if (existing) {
      existing.lastSeenAt = new Date().toISOString();
      await this.writeIndex(items);
      return existing;
    }

    const device: DeviceToken = {
      id: crypto.randomUUID(),
      owner: input.owner,
      token: input.token,
      platform: input.platform,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };

    items.push(device);
    await this.writeIndex(items);
    return device;
  }

  async unregister(id: string): Promise<boolean> {
    const items = await this.readIndex();
    const idx = items.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    items.splice(idx, 1);
    await this.writeIndex(items);
    return true;
  }

  async listByOwner(owner: string): Promise<DeviceToken[]> {
    if (!safeUsername(owner)) return [];
    const items = await this.readIndex();
    return items.filter((d) => d.owner === owner);
  }

  async listAll(): Promise<DeviceToken[]> {
    return this.readIndex();
  }
}

let storeSingleton: DeviceStore | null = null;

/** 组合工厂：按环境变量 DEVICE_DIR 选择落盘目录（默认 `.data/devices`）。 */
export function getDeviceStore(env: NodeJS.ProcessEnv = process.env): DeviceStore {
  if (!storeSingleton) {
    const dir = env.DEVICE_DIR || '.data/devices';
    storeSingleton = new FileDeviceStore(dir);
  }
  return storeSingleton;
}

/** 供测试注入自定义 store（传 null 重置单例）。 */
export function setDeviceStore(s: DeviceStore | null): void {
  storeSingleton = s;
}
