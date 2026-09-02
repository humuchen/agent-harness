/**
 * Circuit Breaker（P1-2）：保护 LLM 上游持续 5xx 时不逐个请求硬等超时。
 *
 * 设计：
 *   - 状态机：CLOSED → OPEN → HALF_OPEN → CLOSED
 *   - 失败阈值：连续 N 次失败打开熔断（默认 3）
 *   - 半开试探：熔断打开后等待 timeoutMs，允许一次"试探"请求
 *   - 成功闭环：试探成功则回归 CLOSED；失败则延长熔断
 *   - 透传：熔断打开期间直接抛 CircuitBreakerOpen，不消耗重试次数
 *
 * 使用方式（在 LLM 调用前包裹）：
 *   const cb = new CircuitBreaker({ failureThreshold: 3, timeoutMs: 30_000 });
 *   async function callWithBreaker(fn) {
 *     return cb.withRequest(fn);
 *   }
 */

export interface CircuitBreakerOptions {
  /** 连续失败次数达到此值则打开熔断。 */
  failureThreshold?: number;
  /** 熔断打开后进入半开状态的等待时间（ms），默认 30000。 */
  timeoutMs?: number;
  /** 允许通过半开状态的试探请求数（默认 1）。 */
  halfOpenAttempts?: number;
  /** 用于标记错误的额外信息。 */
  name?: string;
}

const DEFAULTS: Required<CircuitBreakerOptions> = {
  failureThreshold: 3,
  timeoutMs: 30_000,
  halfOpenAttempts: 1,
  name: 'default',
};

export class CircuitBreakerOpen extends Error {
  constructor(name: string, consecutiveFailures: number) {
    super(
      `[CircuitBreaker:${name}] open — ${consecutiveFailures} consecutive failures, retry after timeout`
    );
    this.name = 'CircuitBreakerOpen';
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private readonly opts: Required<CircuitBreakerOptions>;
  private lastFailureAt = 0;
  private halfOpenAttempts = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get currentState(): CircuitState {
    // 若在 OPEN 状态且已超过 timeoutMs，自动转入 HALF_OPEN
    if (
      this.state === 'open' &&
      this.lastFailureAt > 0 &&
      Date.now() - this.lastFailureAt >= this.opts.timeoutMs
    ) {
      this.state = 'half-open';
      this.halfOpenAttempts = 0;
    }
    return this.state;
  }

  /**
   * 包裹异步调用：若熔断打开则直接抛出 CircuitBreakerOpen；
   * 否则执行 fn，成功关闭计数器，失败递增计数器并在阈值时打开熔断。
   */
  async withRequest<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      throw new CircuitBreakerOpen(this.opts.name, this.consecutiveFailures);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenAttempts += 1;
      if (this.halfOpenAttempts >= this.opts.halfOpenAttempts) {
        // 试探成功，回归 CLOSED
        this.state = 'closed';
        this.consecutiveFailures = 0;
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(_err: unknown): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = Date.now();
    if (this.state === 'half-open') {
      // 试探也失败，延长熔断
      this.state = 'open';
    } else if (
      this.consecutiveFailures >= this.opts.failureThreshold
    ) {
      this.state = 'open';
    }
  }

  /** 手动重置（用于运维重置或配置变更时）。 */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureAt = 0;
    this.halfOpenAttempts = 0;
  }

  /** 获取当前统计（用于可观测性）。 */
  snapshot(): {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureAt: number;
  } {
    return {
      state: this.currentState,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
    };
  }
}
