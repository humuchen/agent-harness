/**
 * 可观测指标路由（自 server.ts 外迁，P2 模块化第七批）。
 *
 * 覆盖：GET /api/metrics（JSON 快照 + 队列/错误明细）、
 *       GET /api/metrics/prometheus（文本格式 + 延迟直方图）。
 * 鉴权说明：两者由 server.ts 主分发器的 readAction 预检（metrics:read）统一守卫，
 * 本模块不再重复鉴权——与外迁前行为一致。
 * 拆分约定见 docs/01-architecture/server-modularization-plan.md。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getMetricsSnapshot,
  getTokenCacheStats,
  getTokenCacheHistory,
  getErrorSummary,
  getErrorLog,
  LATENCY_BUCKETS_MS
} from '@agent-harness/core';
import { runQueue } from '../run-queue';
import { getMemoryStore } from '../runner';
import { sendJson } from '../http-helpers';

export async function handleMetricsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<boolean> {
  if (path !== '/api/metrics' && path !== '/api/metrics/prometheus') {
    return false;
  }

  if (req.method === 'GET' && path === '/api/metrics') {
    // 可观测性指标（token 用量 / 延迟 / 错误率 / 工具调用数 / 成本 / 队列 / token 缓存命中率）。受保护，需令牌。
    const store = getMemoryStore();
    const snapshot = getMetricsSnapshot();
    // 队列深度 Prometheus 友好指标：queue.pending / queue.processing / queue.concurrency
    const qstats = runQueue.stats();
    sendJson(
      res,
      {
        ...snapshot,
        queue: qstats,
        prometheus: {
          harness_queue_pending: qstats.pending ?? 0,
          harness_queue_processing: qstats.running ?? 0,
          harness_queue_concurrency_limit: qstats.concurrency ?? 4,
          harness_run_success_total: snapshot.counters['run.success'] ?? 0,
          harness_run_failed_total: snapshot.counters['run.failed'] ?? 0,
          harness_guardrail_blocked_total:
            snapshot.counters['guardrail.blocked'] ?? 0,
          harness_os_sandbox_degraded_total:
            snapshot.counters['os_sandbox.degraded'] ?? 0,
          harness_errors_total: snapshot.counters['errors'] ?? 0,
          harness_tokens_total: snapshot.tokens.total,
          harness_cost_total: snapshot.cost
        },
        memory: { backend: store.kind },
        tokenCache: getTokenCacheStats(),
        tokenCacheHistory: getTokenCacheHistory(),
        errors: getErrorSummary(),
        recentErrors: getErrorLog({ limit: 20 })
      },
      req
    );
    return true;
  }
  if (req.method === 'GET' && path === '/api/metrics/prometheus') {
    // Prometheus scrape 端点：返回文本格式的 key=value 指标（供 Prometheus node_exporter/textfile 采集）。
    const qstats = runQueue.stats();
    const snapshot = getMetricsSnapshot();
    const lines = [
      '# HELP harness_queue_pending 当前排队中（pending）的任务数',
      '# TYPE harness_queue_pending gauge',
      `harness_queue_pending ${qstats.pending ?? 0}`,
      '# HELP harness_queue_processing 当前正在执行的任务数',
      '# TYPE harness_queue_processing gauge',
      `harness_queue_processing ${qstats.running ?? 0}`,
      '# HELP harness_run_success_total 累计成功完成的 run 次数',
      '# TYPE harness_run_success_total counter',
      `harness_run_success_total ${snapshot.counters['run.success'] ?? 0}`,
      '# HELP harness_run_failed_total 累计失败的 run 次数',
      '# TYPE harness_run_failed_total counter',
      `harness_run_failed_total ${snapshot.counters['run.failed'] ?? 0}`,
      '# HELP harness_guardrail_blocked_total 护栏拦截次数',
      '# TYPE harness_guardrail_blocked_total counter',
      `harness_guardrail_blocked_total ${
        snapshot.counters['guardrail.blocked'] ?? 0
      }`,
      '# HELP harness_os_sandbox_degraded_total OS 沙箱降级为 local 的次数',
      '# TYPE harness_os_sandbox_degraded_total counter',
      `harness_os_sandbox_degraded_total ${
        snapshot.counters['os_sandbox.degraded'] ?? 0
      }`,
      '# HELP harness_errors_total 累计错误数',
      '# TYPE harness_errors_total counter',
      `harness_errors_total ${snapshot.counters['errors'] ?? 0}`,
      '# HELP harness_tokens_total 累计 token 用量',
      '# TYPE harness_tokens_total counter',
      `harness_tokens_total ${snapshot.tokens.total}`,
      '# HELP harness_cost_total 累计 LLM 调用成本（货币单位与模型定价一致）',
      '# TYPE harness_cost_total gauge',
      `harness_cost_total ${Number(snapshot.cost).toFixed(6)}`
    ];
    // P2：延迟直方图（Prometheus histogram，供 histogram_quantile 计算延迟分位数）。
    // 桶为累计口径（cumulative），+Inf 桶 = 总计数。
    const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_');
    for (const [name, h] of Object.entries(snapshot.latency)) {
      const metric = `harness_latency_${sanitize(name)}_ms`;
      lines.push(
        `# HELP ${metric} 延迟直方图（毫秒）：${name}`,
        `# TYPE ${metric} histogram`
      );
      let cumulative = 0;
      LATENCY_BUCKETS_MS.forEach((le, i) => {
        cumulative += h.buckets?.[i] ?? 0;
        lines.push(`${metric}_bucket{le="${le}"} ${cumulative}`);
      });
      lines.push(
        `${metric}_bucket{le="+Inf"} ${h.count}`,
        `${metric}_sum ${h.sumMs}`,
        `${metric}_count ${h.count}`
      );
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(lines.join('\n') + '\n');
    return true;
  }
  return false;
}
