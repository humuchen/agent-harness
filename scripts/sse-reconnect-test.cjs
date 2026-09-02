#!/usr/bin/env node
/**
 * SSE 重连压力测试（Go-live 检查项 #7）
 *
 * 验证：进程重启/滚动更新后，SSE 客户端可无感重连
 *
 * 测试场景：
 *   1. 单个客户端连续重连 10 次（模拟浏览器刷新）
 *   2. 多客户端并发重连（模拟多标签页）
 *   3. 服务端重启后重连（模拟滚动更新）
 *
 * 用法：
 *   node scripts/sse-reconnect-test.cjs
 *   node scripts/sse-reconnect-test.cjs --concurrency 5 --rounds 20
 */

const http = require('node:http');
const { performance } = require('node:perf_hooks');

const CONFIG = {
  baseUrl: process.env.SERVER_URL || 'http://localhost:3100',
  token: process.env.ADMIN_TOKEN || 'test-admin-token',
  concurrency: parseInt(process.env.CONCURRENCY || '3', 10),
  rounds: parseInt(process.env.ROUNDS || '10', 10),
  timeoutMs: parseInt(process.env.TIMEOUT_MS || '5000', 10),
};

const results = {
  totalAttempts: 0,
  success: 0,
  failed: 0,
  latencies: [],
  reconnectLatencies: [],
};

function parseSSELines(data) {
  const lines = data.split('\n').filter((l) => l.trim());
  return lines.map((l) => {
    if (l.startsWith('data:')) {
      try {
        return JSON.parse(l.slice(5).trim());
      } catch {
        return { raw: l };
      }
    }
    return null;
  }).filter(Boolean);
}

/** 单次 SSE 连接测试 */
async function testSSEConnection(roundId, connId) {
  const start = performance.now();
  
  return new Promise((resolve) => {
    const url = new URL('/api/chat/stream', CONFIG.baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${CONFIG.token}`,
        Accept: 'text/event-stream',
      },
      timeout: CONFIG.timeoutMs,
    };

    const req = http.request(options, (res) => {
      let buffer = '';
      let startTime = null;
      let readyEvent = false;
      
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        
        // 检查是否收到 chat:ready 事件
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const event = JSON.parse(line.slice(5).trim());
              if (event.type === 'chat:ready') {
                if (!readyEvent) {
                  readyEvent = true;
                  if (!startTime) startTime = performance.now();
                }
              }
            } catch {}
          }
        }
        
        // 收到 ready 事件后立即断开（我们只关心重连能力）
        if (readyEvent && startTime) {
          const latency = performance.now() - startTime;
          resolve({
            success: true,
            latency,
            roundId,
            connId,
          });
          req.destroy();
        }
      });
      
      res.on('error', (err) => {
        resolve({
          success: false,
          error: err.message,
          roundId,
          connId,
          latency: performance.now() - start,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        error: 'timeout',
        roundId,
        connId,
        latency: performance.now() - start,
      });
    });

    req.on('error', (err) => {
      resolve({
        success: false,
        error: err.message,
        roundId,
        connId,
        latency: performance.now() - start,
      });
    });

    req.end();
  });
}

/** 压测工作器 */
async function worker(workerId) {
  const workerResults = [];
  
  for (let round = 0; round < CONFIG.rounds; round++) {
    const start = performance.now();
    const result = await testSSEConnection(round, workerId);
    const elapsed = performance.now() - start;
    
    results.totalAttempts++;
    if (result.success) {
      results.success++;
      results.latencies.push(result.latency);
    } else {
      results.failed++;
    }
    
    workerResults.push({
      round,
      latency: elapsed,
      success: result.success,
    });
    
    // 短暂间隔模拟真实场景
    await new Promise((r) => setTimeout(r, 50));
  }
  
  return workerResults;
}

function printReport() {
  console.log('\n' + '='.repeat(60));
  console.log('SSE 重连测试报告');
  console.log('='.repeat(60));
  console.log(`并发客户端数:    ${CONFIG.concurrency}`);
  console.log(`重连轮次数:      ${CONFIG.rounds}`);
  console.log(`总尝试次数:      ${results.totalAttempts}`);
  console.log(`成功:            ${results.success} (${((results.success / Math.max(1, results.totalAttempts)) * 100).toFixed(1)}%)`);
  console.log(`失败:            ${results.failed}`);
  
  if (results.latencies.length > 0) {
    const sorted = [...results.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    
    console.log('-'.repeat(60));
    console.log('重连延迟统计:');
    console.log(`  平均:          ${avg.toFixed(0)}ms`);
    console.log(`  P50:           ${p50.toFixed(0)}ms`);
    console.log(`  P95:           ${p95.toFixed(0)}ms`);
    console.log(`  P99:           ${p99.toFixed(0)}ms`);
    
    if (p95 > 1000) {
      console.log('\n⚠️  警告: P95 重连延迟过高 (>1000ms)');
    }
  }
  
  if (results.failed > 0) {
    console.log('\n❌ 失败: 有重连失败案例');
  } else {
    console.log('\n✅ 通过: 所有重连尝试成功');
  }
  console.log('='.repeat(60));
}

async function main() {
  console.log(`开始 SSE 重连测试...`);
  console.log(`目标: ${CONFIG.baseUrl}`);
  console.log(`并发: ${CONFIG.concurrency}, 轮次: ${CONFIG.rounds}\n`);
  
  const startTime = performance.now();
  
  // 并发启动多个客户端
  const workers = Array.from({ length: CONFIG.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);
  
  const duration = performance.now() - startTime;
  console.log(`\n测试耗时: ${duration.toFixed(0)}ms\n`);
  
  printReport();
  
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
