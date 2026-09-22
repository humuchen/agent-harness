#!/usr/bin/env node
/**
 * 最小性能基线（R4：无压测基线的量化补位）。
 *
 * 范围：只压**只读端点**（无 LLM 成本、无状态副作用），建立可对比的延迟/吞吐基线：
 *   - GET /health/live   （极轻：进程存活）
 *   - GET /health/ready  （含 DB SELECT 1 探针）
 *   - GET /api/metrics   （快照聚合 + JSON 序列化）
 *   - GET /api/metrics/prometheus（文本渲染，含直方图）
 *
 * 方法：预热后 顺序 100 次 + 并发 20×50 次，统计 p50/p95/max 与 RPS。
 * 结论写入 docs/perf-baseline.md（含环境说明；每次重大变更后可重跑对比）。
 *
 * 用法：
 *   SMOKE_BASE=http://127.0.0.1:PORT SMOKE_TOKEN=<token> node scripts/perf-baseline.cjs
 */
const http = require('node:http');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4193';
const TOKEN = process.env.SMOKE_TOKEN || 'test-admin-token';
const SEQ_N = Number(process.env.PERF_SEQ_N || 100);
const CONC = Number(process.env.PERF_CONC || 20);
const CONC_N = Number(process.env.PERF_CONC_N || 50);

function once(path) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    http
      .get(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` }, timeout: 10000 }, (res) => {
        res.resume();
        res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.statusCode }));
        res.on('error', reject);
      })
      .on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

function pct(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function bench(name, path, n, concurrency = 1) {
  // 预热
  for (let i = 0; i < 10; i++) await once(path);
  const lat = [];
  let errors = 0;
  const t0 = process.hrtime.bigint();
  if (concurrency === 1) {
    for (let i = 0; i < n; i++) {
      try {
        const r = await once(path);
        if (r.status >= 500) errors++;
        lat.push(r.ms);
      } catch { errors++; }
    }
  } else {
    let remaining = n;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (remaining > 0) {
          remaining--;
          try {
            const r = await once(path);
            if (r.status >= 500) errors++;
            lat.push(r.ms);
          } catch { errors++; }
        }
      })
    );
  }
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  lat.sort((a, b) => a - b);
  const row = {
    endpoint: path,
    n: lat.length,
    errors,
    p50: +pct(lat, 50).toFixed(1),
    p95: +pct(lat, 95).toFixed(1),
    max: +lat[lat.length - 1].toFixed(1),
    rps: +((lat.length / wallMs) * 1000).toFixed(0)
  };
  console.log(
    `${path.padEnd(30)} n=${String(row.n).padStart(4)}  p50=${String(row.p50).padStart(7)}ms  p95=${String(row.p95).padStart(7)}ms  max=${String(row.max).padStart(7)}ms  rps=${row.rps}  err=${errors}`
  );
  return { name, ...row };
}

async function main() {
  console.log(`基线目标：${BASE}（顺序 ${SEQ_N} + 并发 ${CONC}×${CONC_N}，预热 10 次）\n`);
  const rows = [];
  rows.push(await bench('live 顺序', '/health/live', SEQ_N));
  rows.push(await bench('ready 顺序', '/health/ready', SEQ_N));
  rows.push(await bench('metrics 顺序', '/api/metrics', SEQ_N));
  rows.push(await bench('metrics 并发', '/api/metrics', CONC_N, CONC));
  rows.push(await bench('prometheus 并发', '/api/metrics/prometheus', CONC_N, CONC));
  const fs = require('node:fs');
  const out = process.env.PERF_OUT;
  if (out) {
    fs.writeFileSync(
      out,
      JSON.stringify(
        { at: new Date().toISOString(), base: BASE, seqN: SEQ_N, conc: `${CONC}x${CONC_N}`, rows },
        null,
        2
      ) + '\n'
    );
    console.log(`\n结果已写入 ${out}`);
  }
}

main().catch((e) => {
  console.error('perf-baseline 异常终止：', e.message);
  process.exit(1);
});
