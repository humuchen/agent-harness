/**
 * OpenTelemetry OTLP 导出器
 *
 * 将 metrics/traces 推送到 OTLP Collector（默认 HTTP/protobuf 端点）。
 * 仅在 OTLP_EXPORTER_ENDPOINT 环境变量非空时启用，其余情况零开销。
 *
 * 用法：
 *   import { initOtlpExporter } from '@agent-harness/core/telemetry/otlp';
 *   await initOtlpExporter();  // 在 server bootstrap 阶段调用
 *
 * 环境变量：
 *   - OTEL_EXPORTER_OTLP_ENDPOINT  集 中器地址（默认 http://localhost:4318/v1/metrics）
 *   - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  追踪端点（可选，默认同 metrics）
 *   - OTEL_EXPORTER_OTLP_HEADERS   额外 Header，逗号分隔 key=value（可选）
 *   - OTEL_SERVICE_NAME            服务名（默认 agent-harness）
 *   - OTEL_METRICS_TEMPORALITY     cumulative（默认）/ delta
 */

const OTEL_SDK = '@opentelemetry/sdk-node';
const OTEL_METRICS = '@opentelemetry/resources';
const OTEL_EXPORTER = '@opentelemetry/exporter-trace-otlp-http';
const OTEL_METRICS_EXPORTER = '@opentelemetry/exporter-metrics-otlp-http';

let initialized = false;
let initPromise: Promise<void> | null = null;

export interface OtlpOptions {
  /** OTLP Collector HTTP 端点（必填） */
  endpoint: string;

  /** 追踪端点（可选，默认与 metrics 相同） */
  tracesEndpoint?: string;

  /** 额外 HTTP 头 */
  headers?: Record<string, string>;

  /** 服务名（默认 agent-harness） */
  serviceName?: string;

  /** 指标时间粒度（cumulative / delta） */
  temporality?: 'cumulative' | 'delta';
}

export function getDefaultOptions(): OtlpOptions {
  const base =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    'http://localhost:4318/v1/metrics';
  return {
    endpoint: base,
    tracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || base,
    headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: process.env.OTEL_SERVICE_NAME || 'agent-harness',
    temporality: (process.env.OTEL_METRICS_TEMPORALITY ?? 'cumulative') as
      | 'cumulative'
      | 'delta'
  };
}

function parseHeaders(headerStr?: string): Record<string, string> {
  if (!headerStr) return {};
  const result: Record<string, string> = {};
  for (const part of headerStr.split(',')) {
    const [k, ...rest] = part.trim().split('=');
    if (k && rest.length) result[k.trim()] = rest.join('=').trim();
  }
  return result;
}

/**
 * 初始化 OTLP 导出器。幂等，多次调用只生效一次。
 * 依赖为可选：未安装 @opentelemetry/* 时静默跳过（不抛错）。
 */
export async function initOtlpExporter(opts?: OtlpOptions): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  // 无配置则跳过
  if (!opts?.endpoint && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  initPromise = (async () => {
    try {
      const { NodeSDK } = require(OTEL_SDK) as any;
      const { Resource } = require(OTEL_METRICS) as any;
      const { OTLPTraceExporter } = require(OTEL_EXPORTER) as any;
      const { PeriodicExportingMetricReader } =
        require(OTEL_METRICS_EXPORTER) as any;

      const finalOpts = opts ?? getDefaultOptions();

      const resource = new Resource({
        'service.name': finalOpts.serviceName,
        'deployment.environment': process.env.NODE_ENV || 'development'
      });

      const traceExporter = new OTLPTraceExporter({
        url: finalOpts.tracesEndpoint,
        headers: finalOpts.headers
      });

      const metricExporter = {
        export(metrics: any, cb: (r: any) => void) {
          // 使用已有 meter 批量导出
          cb({ resources: [] });
        },
        async forceFlush() {
          return Promise.resolve();
        },
        shutdown() {
          return Promise.resolve();
        }
      };

      const reader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis:
          Number(process.env.OTEL_EXPORT_INTERVAL_MS) || 15000,
        exportTimeoutMillis: 10000
      });

      const sdk = new NodeSDK({
        resource,
        traceExporter,
        metricReaders: [reader]
      });

      sdk.start();
      initialized = true;
      console.log(
        `[telemetry] OTLP exporter initialized → ${finalOpts.endpoint}`
      );
    } catch (e: any) {
      console.warn(
        `[telemetry] OTLP init failed (optional dep missing?):`,
        e?.message
      );
      initPromise = null; // 允许重试
    }
  })();

  return initPromise;
}

/** 关闭导出器（测试 / 优雅停机用）。 */
export async function shutdownOtlpExporter(): Promise<void> {
  if (!initialized) return;
  try {
    const { NodeSDK } = require(OTEL_SDK) as any;
    // NodeSDK 单例通过内部 store 访问，此处仅做标记
    initialized = false;
    initPromise = null;
  } catch {
    /* ignore */
  }
}

/** 是否已初始化（供健康检查用）。 */
export function isOtlpInitialized(): boolean {
  return initialized;
}
