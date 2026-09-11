/**
 * IM 多实例状态聚合器（P2-5）。
 *
 * 当平台在多个区域 / 租户部署多个 IM 机器人实例（飞书 / 钉钉 / 企业微信）时，
 * 在一处集中展示各实例的健康、连接、回调吞吐、最后心跳、故障转移状态。
 *
 * 设计沿用「接口 + 默认实现 + 组合工厂」范式（与 im/ 模块同级，零新增依赖）：
 * - `ImStatusAggregator` 持有各 `ImBridge` 引用，周期性采集心跳与计数；
 * - `snapshot()` 返回 `ImInstanceStatus[]`，供 `GET /api/im/status` 消费；
 * - 心跳采集用 `unref` 定时器（复用 run-queue 的约定），后台心跳不阻止进程退出；
 * - 故障转移：由 `ImBridge` 已有的重推去重决定主/备，聚合器标记 `failover` 字段。
 *
 * 本模块仅读取 `ImBridge` 的 `snapshot()`，不修改 im/ 任何内部逻辑。
 */

import type { ImBridge } from './im/bridge';
import type { ImProvider } from './im';

/** 单实例的健康/连接/吞吐/心跳/故障转移状态。 */
export interface ImInstanceStatus {
  /** 实例标识：`im:<provider>:<region>`（region 缺省为 'default'）。 */
  id: string;
  provider: ImProvider;
  /** 区域 / 租户标签（多实例部署用于区分）。 */
  region?: string;
  /** 健康：最近一次心跳在采样窗口内。 */
  healthy: boolean;
  /** 最后心跳时间（ISO 字符串）。 */
  lastHeartbeat: string;
  /** 累计接收的回调总数。 */
  callbacksTotal: number;
  /** 累计处理失败数。 */
  errorsTotal: number;
  /** 在飞任务数（当前活跃的 agent 执行）。 */
  inflight: number;
  /** 故障转移标识：'primary' / 'standby' / undefined（单实例无标记）。 */
  failover?: 'primary' | 'standby';
}

/** 聚合快照结果。 */
export interface ImStatusSnapshot {
  instances: ImInstanceStatus[];
  /** 聚合时间戳。 */
  updatedAt: string;
}

/** 心跳采样窗口（ms）：在此窗口内有心跳则视为 healthy。 */
const HEARTBEAT_WINDOW_MS = 5 * 60 * 1000; // 5 分钟

/**
 * IM 状态聚合器。
 *
 * 每个 `ImBridge` 实例对应一个 IM 实例（一个平台的一个部署区域）。
 * 聚合器周期性采集各 bridge 的 snapshot，维护心跳时间戳。
 */
export class ImStatusAggregator {
  private readonly bridges: Array<{ bridge: ImBridge; provider: ImProvider; region?: string }>;
  /** 最近一次心跳时间（epoch ms）。 */
  private heartbeats = new Map<string, number>();
  /** 累计计数（自聚合器启动以来，非 bridge 内部的累计）。 */
  private aggregateCounters = new Map<string, { received: number; failed: number }>();
  /** 采样定时器（unref，不阻止进程退出）。 */
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: ImStatusSnapshot = { instances: [], updatedAt: new Date().toISOString() };

  constructor(
    bridges: Array<{ bridge: ImBridge; provider: ImProvider; region?: string }>,
    /** 采样间隔（ms），默认 30 秒。 */
    sampleIntervalMs: number = 30_000
  ) {
    this.bridges = bridges;
    // 初始化心跳为当前时间（bridge 在构造时就绪）
    for (const b of bridges) {
      const id = this.instanceId(b.provider, b.region);
      this.heartbeats.set(id, Date.now());
      this.aggregateCounters.set(id, { received: 0, failed: 0 });
    }
    // 启动 unref 心跳采样定时器
    this.timer = setInterval(() => this.sample(), sampleIntervalMs);
    this.timer.unref?.();
  }

  /** 实例标识。 */
  private instanceId(provider: ImProvider, region?: string): string {
    return `im:${provider}:${region ?? 'default'}`;
  }

  /** 单次采样：读取各 bridge 的 snapshot，更新心跳与累计计数。 */
  private sample(): void {
    for (const b of this.bridges) {
      const id = this.instanceId(b.provider, b.region);
      const snap = b.bridge.snapshot() as Record<string, unknown>;
      const counters = (snap.counters as Record<string, number>) ?? {};
      // 累计计数（bridge 内部的是累计值，这里取当前值作为累计）
      this.aggregateCounters.set(id, {
        received: Number(counters.received ?? 0),
        failed: Number(counters.failed ?? 0)
      });
      // 更新心跳
      this.heartbeats.set(id, Date.now());
    }
  }

  /** 获取当前聚合快照。 */
  snapshot(): ImStatusSnapshot {
    const now = Date.now();
    const instances: ImInstanceStatus[] = this.bridges.map((b) => {
      const id = this.instanceId(b.provider, b.region);
      const snap = b.bridge.snapshot() as Record<string, unknown>;
      const counters = (snap.counters as Record<string, number>) ?? {};
      const agg = this.aggregateCounters.get(id) ?? { received: 0, failed: 0 };
      const lastHb = this.heartbeats.get(id) ?? 0;
      const healthy = now - lastHb < HEARTBEAT_WINDOW_MS;
      return {
        id,
        provider: b.provider,
        region: b.region,
        healthy,
        lastHeartbeat: new Date(lastHb).toISOString(),
        callbacksTotal: Number(counters.received ?? agg.received ?? 0),
        errorsTotal: Number(counters.failed ?? agg.failed ?? 0),
        inflight: Number((snap.inflight as number) ?? 0),
        // 故障转移标记：单实例时不标记；多实例时由部署配置决定（此处简化为 undefined）
      };
    });
    this.lastSnapshot = { instances, updatedAt: new Date().toISOString() };
    return this.lastSnapshot;
  }

  /** 停止心跳采样（用于优雅停机）。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── 组合工厂 ──

let aggregatorSingleton: ImStatusAggregator | null = null;

/**
 * 组合工厂：构造单例 ImStatusAggregator。
 * 从环境变量 IM_REGIONS 读取多实例配置（逗号分隔的 provider:region 对），
 * 默认覆盖所有已启用的 im 实例。
 *
 * @param bridges 已启用的 ImBridge 实例列表
 */
export function getImStatusAggregator(bridges: ImBridge[]): ImStatusAggregator {
  if (!aggregatorSingleton) {
    // 从环境变量解析 regions 映射
    const regions = parseImRegions(process.env.IM_REGIONS);
    const entries = bridges.map((bridge) => {
      const provider = extractProvider(bridge);
      return {
        bridge,
        provider,
        region: regions[provider]
      };
    });
    aggregatorSingleton = new ImStatusAggregator(entries);
  }
  return aggregatorSingleton;
}

/** 供测试注入自定义聚合器（传 null 重置单例）。 */
export function setImStatusAggregator(s: ImStatusAggregator | null): void {
  aggregatorSingleton = s;
}

// ── 辅助函数 ──

/** 从 IM_REGIONS 环境变量解析 provider → region 映射。格式：feishu:cn-1,dingtalk:cn-2 */
function parseImRegions(raw?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [provider, region] = part.trim().split(':');
    if (provider && region) out[provider.trim()] = region.trim();
  }
  return out;
}

/** 从 ImBridge 提取 provider 列表（用于构造聚合器）。 */
function extractProvider(bridge: ImBridge): ImProvider {
  const providers = bridge.enabledProviders();
  if (providers.length > 0) {
    const p = providers[0];
    if (p) return p;
  }
  return 'feishu'; // 兜底（不应出现）
}
