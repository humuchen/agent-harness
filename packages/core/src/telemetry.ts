// 轻量级链路追踪。
//
// OpenTelemetry 是可选的。如果进程中已安装 `@opentelemetry/api` 且注册了 Tracer
// 提供商，则会发出 Span。若未安装，每个 `withSpan` 退化为普通函数调用（无操作），
// 因此 Harness 在运行时不存在任何强制依赖。
//
// 对动态导入使用变量标识符，可避免 TypeScript 在编译时尝试解析
//（可能不存在的）模块。

const OTEL = '@opentelemetry/api';

let tracer: any = null;
let initPromise: Promise<void> | null = null;

async function ensureTracer(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const api: any = await import(OTEL);
        tracer = api.trace.getTracer('agent-harness');
      } catch {
        tracer = null;
      }
    })();
  }
  await initPromise;
}

// OpenTelemetry SpanStatusCode.ERROR 的值为 2
const SPAN_STATUS_ERROR = 2;

export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await ensureTracer();
  if (!tracer) {
    return fn();
  }
  const span = tracer.startSpan(name);
  try {
    return await fn();
  } catch (err: any) {
    if (span.setStatus) {
      span.setStatus({ code: SPAN_STATUS_ERROR, message: err?.message ?? String(err) });
    }
    if (span.recordException) {
      span.recordException(err);
    }
    throw err;
  } finally {
    span.end();
  }
}
