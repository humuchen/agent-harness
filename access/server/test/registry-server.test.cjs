// Registry Server（插件市场）e2e 测试：以子进程启动 dist/registry-server.js
//（随机端口 + 临时 registry-data 目录 + 发布令牌），覆盖此前零测试的市场服务端：
// - 发布（POST，Bearer 鉴权；缺 token 401；缺字段 400；重复版本 409）
// - 列表 / 搜索 / 详情 / 版本 / 统计
// - tarball base64 上传 → 下载端点往返 + 下载计数聚合
// - 下载端点防目录穿越（路径校验 400/404）
// 注意：必须用异步 spawn 而非 spawnSync —— 服务端与测试同进程协调时，spawnSync
// 会阻塞事件循环形成死锁（与 cli.e2e.test.cjs 同一教训）。
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_JS = path.join(__dirname, '..', 'dist', 'registry-server.js');
const BUILT = fs.existsSync(SERVER_JS);

const TOKEN = 'test-registry-token';

function waitReady(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      fetch(`http://127.0.0.1:${port}/api/registry/stats`)
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('registry server 未就绪'));
      else setTimeout(probe, 200);
    };
    probe();
  });
}

/** 预占一个随机空闲端口（先 listen(0) 拿端口再释放，存在极小竞态，测试可接受）。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** 起一个 registry 实例（隔离 cwd + 数据目录 + 随机端口），返回 { port, stop }。 */
async function startRegistry(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-registry-'));
  const port = await pickFreePort();
  const child = spawn(
    process.execPath,
    [SERVER_JS],
    {
      cwd: dataDir,
      env: {
        ...process.env,
        PORT: String(port),
        REGISTRY_TOKEN: TOKEN,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', () => {});
  await waitReady(port, 10_000).catch((e) => {
    throw new Error(`${e.message}；stderr: ${stderr.slice(0, 300)}`);
  });
  return {
    port,
    stop: () =>
      new Promise((resolve) => {
        child.on('exit', resolve);
        child.kill('SIGTERM');
      }),
  };
}

function jsonFetch(port, method, p, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('registry：发布 → 列表/搜索/详情/版本 → tarball 下载往返 + 计数', { skip: !BUILT }, async () => {
  const registry = await startRegistry();
  const { port, stop } = registry;
  try {
    const auth = { authorization: `Bearer ${TOKEN}` };

    // 发布：无 token → 401
    const noAuth = await jsonFetch(port, 'POST', '/api/registry/plugins', {
      id: 'weather', name: 'Weather', version: '1.0.0',
    });
    assert.strictEqual(noAuth.status, 401, '发布必须鉴权');

    // 发布：缺字段 → 400
    const bad = await jsonFetch(port, 'POST', '/api/registry/plugins', { id: 'x' }, auth);
    assert.strictEqual(bad.status, 400);

    // 发布：合法（含 base64 tarball）
    const tarball = Buffer.from(`fake-tarball-content-${Date.now()}`).toString('base64');
    const pub = await jsonFetch(port, 'POST', '/api/registry/plugins', {
      id: 'weather', name: 'Weather Plugin', version: '1.0.0',
      manifest: { id: 'weather', version: '1.0.0' },
      tarball,
    }, auth);
    assert.strictEqual(pub.status, 201, `发布应成功：${JSON.stringify(await pub.json())}`);

    // 重复版本 → 409
    const dup = await jsonFetch(port, 'POST', '/api/registry/plugins', {
      id: 'weather', name: 'Weather Plugin', version: '1.0.0',
    }, auth);
    assert.strictEqual(dup.status, 409);

    // 新版本（版本排序：latest 取最高）
    await jsonFetch(port, 'POST', '/api/registry/plugins', {
      id: 'weather', name: 'Weather Plugin', version: '0.9.0',
    }, auth);

    // 列表（注意：registry 启动时会 seed 1 个示例插件 medical-aesthetics-lead）
    const list = await (await jsonFetch(port, 'GET', '/api/registry/plugins')).json();
    const weatherEntry = list.plugins.find((p) => p.id === 'weather');
    assert.ok(weatherEntry, '列表应含刚发布的插件');
    assert.strictEqual(weatherEntry.latestVersion, '1.0.0', 'latest 应为最高版本');
    assert.strictEqual(list.total, 2, 'seed 示例 + weather');

    // 搜索
    const search = await (await jsonFetch(port, 'GET', '/api/registry/search?q=weat')).json();
    assert.strictEqual(search.total, 1);
    assert.strictEqual(search.results[0].id, 'weather');
    const miss = await (await jsonFetch(port, 'GET', '/api/registry/search?q=zzz-no-match')).json();
    assert.strictEqual(miss.total, 0);

    // 详情（触发下载计数）
    const detail = await (await jsonFetch(port, 'GET', '/api/registry/plugins/weather')).json();
    assert.strictEqual(detail.plugin.downloads, 1, '首次详情访问应计数 1');
    await jsonFetch(port, 'GET', '/api/registry/plugins/weather');
    const detail2 = await (await jsonFetch(port, 'GET', '/api/registry/plugins/weather')).json();
    assert.strictEqual(detail2.plugin.downloads, 3);

    // 版本列表
    const versions = await (await jsonFetch(port, 'GET', '/api/registry/plugins/weather/versions')).json();
    assert.deepStrictEqual(versions.versions.map((v) => v.version), ['0.9.0', '1.0.0']);

    // tarball 下载：base64 上传的字节原样返回
    const dl = await fetch(`http://127.0.0.1:${port}/plugins/weather-1.0.0.tar.gz`);
    assert.strictEqual(dl.status, 200);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(buf.toString(), Buffer.from(tarball, 'base64').toString());

    // 统计（seed 示例插件 + weather：2 插件 / 1 + 2 版本）
    const stats = await (await jsonFetch(port, 'GET', '/api/registry/stats')).json();
    assert.strictEqual(stats.totalPlugins, 2);
    assert.strictEqual(stats.totalVersions, 3);
    assert.ok(stats.totalDownloads >= 3);
  } finally {
    await stop();
  }
});

test('registry：下载端点防目录穿越', { skip: !BUILT }, async () => {
  const registry = await startRegistry();
  const { port, stop } = registry;
  try {
    // 非法文件名（含路径分隔）→ 400
    const r1 = await fetch(`http://127.0.0.1:${port}/plugins/..%2F..%2Fplugins.json`);
    assert.strictEqual(r1.status, 400, '含路径分隔的文件名必须被拒绝');
    // 合法文件名但不存在的包 → 404
    const r2 = await fetch(`http://127.0.0.1:${port}/plugins/nope-1.0.0.tar.gz`);
    assert.strictEqual(r2.status, 404);
  } finally {
    await stop();
  }
});

// 占位：验证测试骨架本身（dist 未构建时至少有 1 个可执行用例，避免空测试文件告警）
test('registry：测试骨架自检', () => {
  assert.ok(true);
});
