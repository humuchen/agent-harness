/**
 * 告警接收器工厂与装配（P0-2：从 server.ts 抽出）。
 *
 * 告警下沉是可插拔的：默认关闭，按环境变量装配。
 * - ALERT_WEBHOOK_URL：将告警 JSON POST 到该地址（如 Slack/飞书/钉钉 入站 Webhook、自研告警网关）。
 * - ALERT_LOG_PATH：将告警以 JSON 逐行追加到指定文件（便于被 Filebeat/Loki 采集）。
 * 多个 sink 会依次触发；单个 sink 失败仅告警日志，不影响其它 sink 与主流程。
 *
 * 从 server.ts 抽出的目的：
 *   1) 让告警装配逻辑可独立测试（此前与 server.ts 的 2297 行代码耦合，无法单测）；
 *   2) server.ts 聚焦 HTTP 路由编排，告警是横切关注点。
 */
import { appendFile } from 'node:fs/promises';
import {
  structLog,
  setAlertSink,
  emitAlert,
  startTokenCacheAggregation,
  setTokenCacheAlertSink,
} from '@agent-harness/core';

/** 创建一个 webhook 告警 sink：POST JSON 到指定 URL。 */
export function createWebhookAlertSink(url: string) {
  return async (a: unknown) => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a),
      });
    } catch (e) {
      structLog('warn', 'alert webhook failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
}

/** 创建一个文件告警 sink：JSON 逐行追加到指定文件。 */
export function createFileAlertSink(filePath: string) {
  return async (a: unknown) => {
    try {
      await appendFile(filePath, JSON.stringify(a) + '\n');
    } catch {
      /* 告警落盘失败不向上传播 */
    }
  };
}

/**
 * 装配告警通道：读 env 变量，按配置创建 webhook / file sink，
 * 注入到 core 的 setAlertSink。同时接线 token 缓存命中率告警。
 */
export function setupAlerting(): void {
  const url = process.env.ALERT_WEBHOOK_URL;
  const file = process.env.ALERT_LOG_PATH;
  const sinks: Array<(a: unknown) => void | Promise<void>> = [];
  if (url) {
    sinks.push(createWebhookAlertSink(url));
    structLog('info', 'alerting enabled', { sink: 'webhook', url });
  }
  if (file) {
    sinks.push(createFileAlertSink(file));
    structLog('info', 'alerting enabled', { sink: 'file', path: file });
  }
  if (sinks.length) {
    setAlertSink(async (a: unknown) => {
      for (const s of sinks) await s(a);
    });
  }

  // Token 缓存命中率统计：复用同一套告警通道（webhook / 文件），并启动周期聚合。
  setTokenCacheAlertSink(emitAlert);
  startTokenCacheAggregation();
}
