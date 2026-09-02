#!/usr/bin/env node
/**
 * 容量与性能基线测试（Go-live 检查项 #10）
 *
 * 测试场景：
 *   1. 单请求延迟基线（/api/state）
 *   2. 并发压力测试（模拟多用户）
 *   3. 持续负载测试（验证稳定性）
 *   4. 错误率统计
 *
 * 用法：
 *   node scripts/capacity-benchmark.cjs
 *   node scripts/capacity-benchmark.cjs --concurrency 50 --requests 1000 --duration 60s
 */

const http = require('node:http');
const { performance } = require('node:perf_hooks');

const CONFIG = {
  baseUrl: process.env.SERVER_URL || 'http://localhost:3100',
  token: process.env.ADMIN_TOKEN || 'test-admin-token',
  concurrency: parseInt(process.env.CONCURRENCY || '10', 10),
  totalRequests: parseInt(process.env.REQUESTS || '100', 10),
  durationSec: parseInt(process.env.DURATION || '0', 10), // 0=按请求数测试
  endpoints: ['/api/state', '/api/v1/runs'],
};

const stats = {
  total: 0,
  success: 0,
  failed: 0,
  errors: new Map(),
  latencies: [],
  startTime: null,
  endTime: null,
  startTimeStamp: 0,
};

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function sendRequest(endpoint) {
  const url = new URL(endpoint, CONFIG.baseUrl);
  const start = performance.now();
  
  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${CONFIG.token}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const latency = performance.now() - start;
        resolve({
          status: res.statusCode,
          latency,
          success: res.statusCode >= 200 && res.statusCode < 300,
          endpoint,
        });
      });
    });

    req.on('error', (err) => {
      const latency = performance.now() - start;
      resolve({
        status: 0,
        latency,
        success: false,
        endpoint,
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        status: 0,
        latency: performance.now() - start,
        success: false,
        endpoint,
        error: 'timeout',
      });
    });

    req.end();
  });
}

async function worker(workerId, requests) {
  for (let i = 0; i < requests; i++) {
    const endpoint = CONFIG.endpoints[i % CONFIG.endpoints.length];
    const result = await sendRequest(endpoint);
    
    stats.total++;
    if (result.success) {
      stats.success++;
    } else {
      stats.failed++;
      const key = `${endpoint} ${result.status || result.error}`;
      stats.errors.set(key, (stats.errors.get(key) || 0) + 1);
    }
    stats.latencies.push(result.latency);
  }
}

function printReport() {
  const durationMs = stats.endTime - stats.startTime;
  const durationSec = durationMs / 1000;
  const rps = stats.success / (durationSec || 1);
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 容量与性能基线报告');
  console.log('='.repeat(70));
  console.log(`测试时间:        ${new Date(stats.startTimeStamp).toISOString()}`);
  console.log(`持续时间:        ${durationSec.toFixed(1)}s`);
  console.log(`目标服务器:      ${CONFIG.baseUrl}`);
  console.log(`并发客户端数:    ${CONFIG.concurrency}`);
  console.log(`每客户端请求数:  ${CONFIG.totalRequests}`);
  console.log(`总请求数:        ${stats.total}`);
  console.log(`成功:            ${stats.success} (${((stats.success / Math.max(1, stats.total)) * 100).toFixed(1)}%)`);
  console.log(`失败:            ${stats.failed} (${((stats.failed / Math.max(1, stats.total)) * 100).toFixed(1)}%)`);
  console.log(`吞吐量:          ${rps.toFixed(2)} req/s`);
  
  if (stats.latencies.length > 0) {
    const p50 = percentile(stats.latencies, 50);
    const p95 = percentile(stats.latencies, 95);
    const p99 = percentile(stats.latencies, 99);
    const avg = stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length;
    
    console.log('-'.repeat(70));
    console.log('延迟统计:');
    console.log(`  平均:          ${avg.toFixed(0)}ms`);
    console.log(`  最小:          ${Math.min(...stats.latencies).toFixed(0)}ms`);
    console.log(`  最大:          ${Math.max(...stats.latencies).toFixed(0)}ms`);
    console.log(`  P50:           ${p50.toFixed(0)}ms`);
    console.log(`  P95:           ${p95.toFixed(0)}ms`);
    console.log(`  P99:           ${p99.toFixed(0)}ms`);
  }
  
  if (stats.errors.size > 0) {
    console.log('-'.repeat(70));
    console.log('错误分布:');
    for (const [key, count] of stats.errors) {
      console.log(`  ${key}: ${count}`);
    }
  }
  
  console.log('='.repeat(70));
  
  // 达标判定
  const passes = [];
  if (rps >= 50) passes.push('吞吐量 >= 50 req/s ✅');
  else passes.push(`吞吐量 ${rps.toFixed(1)} req/s < 50 ❌`);
  
  if (p95 <= 500) passes.push('P95 延迟 <= 500ms ✅');
  else passes.push(`P95 延迟 ${p95.toFixed(0)}ms > 500ms ❌`);
  
  if (stats.failed === 0) passes.push('错误率 0% ✅');
  else passes.push(`错误率 ${((stats.failed / stats.total) * 100).toFixed(1)}% > 0% ❌`);
  
  console.log('\n达标判定:');
  passes.forEach((p) => console.log(`  ${p}`));
}

async function main() {
  console.log(`开始容量基准测试...`);
  console.log(`目标: ${CONFIG.baseUrl}`);
  console.log(`并发: ${CONFIG.concurrency}, 每客户端: ${CONFIG.totalRequests} 请求\n`);
  
  stats.startTimeStamp = Date.now();
  stats.startTime = performance.now();
  
  // 分发请求到各 worker
  const workers = Array.from({ length: CONFIG.concurrency }, () =>
    worker(0, Math.ceil(CONFIG.totalRequests / CONFIG.concurrency))
  );
  
  await Promise.all(workers);
  
  stats.endTime = performance.now();
  
  printReport();
  
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
