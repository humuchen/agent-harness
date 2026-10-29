/**
 * 事件总线抽象（P2 事件模型）。
 *
 * 统一审计 / 告警 / 指标 / 跨实例事件的消息通道，替代各自落盘 + Redis pub/sub 的分散模式：
 * - 审计（audit）/ 告警（alert）/ 指标（metric）三类事件统一经总线分发；
 * - 默认内存后端（零依赖、零配置，向后兼容——不接总线时各 sink 仍按原路径工作）；
 * - 可选 Redis 后端（动态导入，缺依赖即降级，不引入硬依赖）；
 * - 预留 Kafka / NATS / Pulsar 扩展点（EventBusBackend 接口，按需实现后挂载）。
 *
 * 降级原则：backend 缺失或发布失败绝不阻塞主业务流程（与 telemetry / audit 的
 * "sink 异常被吞"约定一致）。
 */

/** 事件类别。audit/alert/metric 为内置语义，其余留给业务扩展。 */
export type EventCategory = 'audit' | 'alert' | 'metric' | (string & {});

/** 一条总线事件（全字段可 JSON 序列化）。 */
export interface BusEvent {
  /** 事件类别。 */
  category: EventCategory;
  /** 事件名称（如 'agent.run.end' / 'quota.exceeded' / 'step.timeout'）。 */
  name: string;
  /** 事件负载（任意 JSON）。 */
  payload: Record<string, unknown>;
  /** 时间戳（ISO 字符串，缺省由实现填充）。 */
  ts?: string;
}

/** 订阅回调。返回值被忽略；抛错被总线吞掉（不阻塞发布方）。 */
export type EventHandler = (e: BusEvent) => void | Promise<void>;

/**
 * 事件总线后端接口。内存 / Redis / Kafka / NATS 等均实现该接口。
 * publish 必须「至少投递一次」语义尽力而为；失败不抛（返回 false 表示未投递）。
 */
export interface EventBusBackend {
  /** 后端名称（用于日志与诊断）。 */
  readonly name: string;
  publish(e: BusEvent): Promise<boolean>;
  /** 可选：关闭后端连接（优雅退出时调用）。 */
  close?(): Promise<void>;
}

/** 内存事件总线后端（默认）。进程内分发，零依赖、零配置。 */
export class MemoryEventBusBackend implements EventBusBackend {
  readonly name = 'memory';
  publish(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Redis 事件总线后端（可选）。动态导入 redis 客户端，缺依赖 / 连接失败即降级内存。 */
export class RedisEventBusBackend implements EventBusBackend {
  readonly name = 'redis';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private channel: string;
  private ready: Promise<boolean>;

  constructor(url: string, channel = 'agent-harness:events') {
    this.channel = channel;
    this.ready = this._init(url).catch(() => false);
  }

  private async _init(url: string): Promise<boolean> {
    try {
      // 动态导入：redis 为可选依赖，缺失时降级内存后端。
      // @ts-ignore - redis 为可选依赖，类型不可用；运行时缺失会走 catch 降级
      const mod = await import('redis');
      const client = mod.createClient({ url });
      await client.connect();
      this.client = client;
      return true;
    } catch {
      return false;
    }
  }

  async publish(e: BusEvent): Promise<boolean> {
    if (!(await this.ready)) return false;
    try {
      await this.client.publish(this.channel, JSON.stringify(e));
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client?.quit?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 事件总线：后端 + 进程内订阅者注册表。
 * - publish：先经后端持久化/跨实例分发，再同步给本进程订阅者（订阅者异常被吞）。
 * - subscribe：注册订阅者，返回取消订阅函数。
 */
export class EventBus {
  private backend: EventBusBackend;
  private handlers = new Map<EventCategory, Set<EventHandler>>();

  constructor(backend?: EventBusBackend) {
    this.backend = backend ?? new MemoryEventBusBackend();
  }

  /** 替换后端（如从内存切到 Redis）。 */
  setBackend(backend: EventBusBackend): void {
    this.backend = backend;
  }

  /** 发布事件：后端投递 + 进程内分发。后端失败不阻塞订阅者。 */
  async publish(e: BusEvent): Promise<void> {
    const event: BusEvent = { ts: new Date().toISOString(), ...e };
    try {
      await this.backend.publish(event);
    } catch {
      /* 后端失败不阻塞 */
    }
    const subs = this.handlers.get(event.category);
    if (subs) {
      for (const h of subs) {
        try {
          await h(event);
        } catch {
          /* 订阅者异常被吞 */
        }
      }
    }
  }

  /** 订阅某类别事件，返回取消订阅函数。 */
  subscribe(category: EventCategory, handler: EventHandler): () => void {
    let subs = this.handlers.get(category);
    if (!subs) {
      subs = new Set();
      this.handlers.set(category, subs);
    }
    subs.add(handler);
    return () => subs!.delete(handler);
  }

  /** 关闭后端连接。 */
  async close(): Promise<void> {
    await this.backend.close?.();
  }
}

/**
 * 全局事件总线实例（默认内存后端）。
 * 各模块可通过它发布 audit / alert / metric 事件，实现统一事件流。
 */
export const eventBus = new EventBus();

/**
 * 便捷发布：审计 / 告警 / 指标三类内置语义。
 */
export function publishAuditEvent(name: string, payload: Record<string, unknown>): Promise<void> {
  return eventBus.publish({ category: 'audit', name, payload });
}
export function publishAlertEvent(name: string, payload: Record<string, unknown>): Promise<void> {
  return eventBus.publish({ category: 'alert', name, payload });
}
export function publishMetricEvent(name: string, payload: Record<string, unknown>): Promise<void> {
  return eventBus.publish({ category: 'metric', name, payload });
}

/**
 * 从环境变量装配事件总线：
 * - EVENT_BUS=redis 且 EVENT_BUS_REDIS_URL 配置时启用 Redis 后端（可选，缺依赖降级内存）；
 * - 否则使用内存后端。
 * 返回当前生效的总线实例（与全局 eventBus 同一实例，便于订阅）。
 */
export function setupEventBus(): EventBus {
  const kind = (process.env.EVENT_BUS || 'memory').toLowerCase();
  const url = process.env.EVENT_BUS_REDIS_URL;
  if (kind === 'redis' && url) {
    eventBus.setBackend(new RedisEventBusBackend(url));
  }
  return eventBus;
}
