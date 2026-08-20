/**
 * 性能/负载测试脚本。
 *
 * 用途:
 * - 验证多实例并发处理能力
 * - 测试 Redis 队列性能
 * - 测量 API 响应延迟
 *
 * 使用:
 *   node scripts/load-test.cjs
 *   node scripts/load-test.cjs --concurrency 50 --requests 500
 */
const http = require('node:http');
const { performance } = require('node:perf_hooks');

// 配置
const CONFIG = {
  baseUrl: process.env.SERVER_URL || 'http://localhost:3100',
  token: process.env.ADMIN_TOKEN || 'test-admin-token',
  concurrency: parseInt(process.env.CONCURRENCY || '10', 10),
  totalRequests: parseInt(process.env.REQUESTS || '100', 10),
  endpoint: process.env.ENDPOINT || '/api/state',
  method: process.env.METHOD || 'GET'
};

// 统计信息
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  latencies: [],
  p50: 0,
  p95: 0,
  p99: 0,
  avg: 0,
  min: Infinity,
  max: 0
};

/**
 * 发送单个HTTP请求
 */
function sendRequest() {
  return new Promise((resolve) => {
    const start = performance.now();
    const url = new URL(CONFIG.endpoint, CONFIG.baseUrl);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: CONFIG.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.token}`
      },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const latency = performance.now() - start;
        resolve({
          status: res.statusCode,
          latency,
          success: res.statusCode >= 200 && res.statusCode < 300
        });
      });
    });

    req.on('error', (err) => {
      const latency = performance.now() - start;
      resolve({ status: 0, latency, success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      const latency = performance.now() - start;
      resolve({ status: 0, latency, success: false, error: 'timeout' });
    });

    if (CONFIG.method === 'POST' || CONFIG.method === 'PUT') {
      req.write(JSON.stringify({ prompt: 'load test', model: 'test' }));
    }
    req.end();
  });
}

/**
 * 计算百分位数
 */
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * 打印统计报告
 */
function printReport(duration) {
  const rps = stats.success / (duration / 1000);

  console.log('\n' + '='.repeat(60));
  console.log('📊 负载测试报告');
  console.log('='.repeat(60));
  console.log(`端点:          ${CONFIG.method} ${CONFIG.endpoint}`);
  console.log(`并发数:        ${CONFIG.concurrency}`);
  console.log(`总请求数:      ${stats.total}`);
  console.log(
    `成功:          ${stats.success} (${((stats.success / stats.total) * 100).toFixed(1)}%)`
  );
  console.log(
    `失败:          ${stats.failed} (${((stats.failed / stats.total) * 100).toFixed(1)}%)`
  );
  console.log(`总耗时:        ${duration.toFixed(0)}ms`);
  console.log(`吞吐量:        ${rps.toFixed(2)} req/s`);
  console.log('-'.repeat(60));
  console.log('延迟统计:');
  console.log(`  平均:        ${stats.avg.toFixed(2)}ms`);
  console.log(`  最小:        ${stats.min.toFixed(2)}ms`);
  console.log(`  最大:        ${stats.max.toFixed(2)}ms`);
  console.log(`  P50:         ${stats.p50.toFixed(2)}ms`);
  console.log(`  P95:         ${stats.p95.toFixed(2)}ms`);
  console.log(`  P99:         ${stats.p99.toFixed(2)}ms`);
  console.log('='.repeat(60));

  // 警告
  if (stats.failed > 0) {
    console.log(`\n⚠️  警告: ${stats.failed} 个请求失败`);
  }
  if (stats.p95 > 1000) {
    console.log(
      `\n⚠️  警告: P95 延迟过高 (${stats.p95.toFixed(0)}ms > 1000ms)`
    );
  }
  if (rps < 10) {
    console.log(`\n⚠️  警告: 吞吐量过低 (${rps.toFixed(1)} req/s < 10 req/s)`);
  }
}

/**
 * 工作器:处理一批请求
 */
async function worker(workerId, batchSize) {
  const results = [];
  for (let i = 0; i < batchSize; i++) {
    const result = await sendRequest();
    results.push(result);

    // 更新统计
    stats.total++;
    if (result.success) {
      stats.success++;
    } else {
      stats.failed++;
    }
    stats.latencies.push(result.latency);
    stats.min = Math.min(stats.min, result.latency);
    stats.max = Math.max(stats.max, result.latency);
  }
  return results;
}

/**
 * 主函数
 */
async function runLoadTest() {
  console.log('🚀 开始负载测试...');
  console.log(`配置: 并发=${CONFIG.concurrency}, 请求=${CONFIG.totalRequests}`);
  console.log(`端点: ${CONFIG.method} ${CONFIG.baseUrl}${CONFIG.endpoint}\n`);

  const startTime = performance.now();

  // 分配工作
  const workers = [];
  const requestsPerWorker = Math.floor(
    CONFIG.totalRequests / CONFIG.concurrency
  );
  const remainder = CONFIG.totalRequests % CONFIG.concurrency;

  for (let i = 0; i < CONFIG.concurrency; i++) {
    const count = requestsPerWorker + (i < remainder ? 1 : 0);
    workers.push(worker(i, count));
  }

  // 等待所有工作器完成
  await Promise.all(workers);

  const endTime = performance.now();
  const duration = endTime - startTime;

  // 计算统计
  if (stats.latencies.length > 0) {
    stats.avg =
      stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length;
    stats.p50 = percentile(stats.latencies, 50);
    stats.p95 = percentile(stats.latencies, 95);
    stats.p99 = percentile(stats.latencies, 99);
  }

  // 打印报告
  printReport(duration);

  // 退出码
  process.exit(stats.failed > 0 ? 1 : 0);
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--concurrency':
      case '-c':
        CONFIG.concurrency = parseInt(args[++i], 10);
        break;
      case '--requests':
      case '-r':
        CONFIG.totalRequests = parseInt(args[++i], 10);
        break;
      case '--endpoint':
      case '-e':
        CONFIG.endpoint = args[++i];
        break;
      case '--method':
      case '-m':
        CONFIG.method = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
用法: node load-test.cjs [选项]

选项:
  -c, --concurrency <N>   并发数 (默认: 10)
  -r, --requests <N>      总请求数 (默认: 100)
  -e, --endpoint <PATH>   测试端点 (默认: /api/state)
  -m, --method <METHOD>   HTTP方法 (默认: GET)
  -h, --help              显示帮助

环境变量:
  SERVER_URL              服务器地址 (默认: http://localhost:3100)
  ADMIN_TOKEN             认证令牌
  CONCURRENCY             并发数
  REQUESTS                总请求数
  ENDPOINT                测试端点
  METHOD                  HTTP方法

示例:
  node load-test.cjs
  node load-test.cjs -c 50 -r 500
  node load-test.cjs -e /api/v1/run -m POST -c 20 -r 200
        `);
        process.exit(0);
    }
  }
}

// 运行
parseArgs();
runLoadTest().catch((err) => {
  console.error('❌ 负载测试失败:', err);
  process.exit(1);
});
