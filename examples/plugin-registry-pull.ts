/**
 * 外部接入样例 ②：插件市场「拉取 + 签名校验」落地。
 *
 * 演示：从远程 registry 拉取插件清单后，用发布者共享密钥做 HMAC-SHA256 验签，
 * 验签失败则拒绝入驻，防止「投毒」插件拿到路由/执行资格。
 *
 * 为可独立跑通（不依赖真实 registry），本例：
 *   1) 用 signManifest 对一个 PluginManifest 生成 HMAC 签名；
 *   2) 起一个**内存桩 registry**（注入 fetchImpl 给 PluginRegistryClient），
 *      暴露 /plugins/index 与 /plugins/:id/latest；
 *   3) 调 loader.installFromRegistry(..., { verifySecret, scheme:'hmac' })，
 *      验签通过 → install + enable → 注册 AgentCard；
 *   4) 反向演示：篡改签名（tamper）后再次尝试，应抛 "signature verification failed"。
 *
 * 运行：
 *   pnpm -r build
 *   pnpm --filter @agent-harness/examples run registry-pull
 */

import {
  PluginLoader,
  PluginRegistryClient,
  getAgentRegistry,
  signManifest,
  type PluginManifest,
  type RegistryEntry,
} from '@agent-harness/core';

const SHARED_SECRET = 'demo-publisher-secret';

const manifest: PluginManifest = {
  id: 'market-weather',
  version: '1.2.0',
  name: '天气插件',
  description: '从插件市场分发的天气查询 agent。',
  domain: 'generic',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [{ id: 'weather' }],
};

/** 内存桩 registry + 注入 fetchImpl 给客户端（不触网）。 */
function buildStubRegistry(signature: string): PluginRegistryClient {
  const entry: RegistryEntry = {
    id: manifest.id,
    version: manifest.version,
    manifest,
    signature,
    publishedAt: new Date().toISOString(),
  };
  const base = 'http://registry.local';
  const routes: Record<string, () => unknown> = {
    [`${base}/plugins`]: () => ({ plugins: [entry] }),
    [`${base}/plugins/${manifest.id}`]: () => entry,
    [`${base}/plugins/${manifest.id}/latest`]: () => entry,
  };
  const fetcher = async (url: string | URL) => {
    const u = String(url);
    const body = routes[u];
    if (!body) return { ok: false, status: 404, json: async () => ({}) } as never;
    return {
      ok: true,
      status: 200,
      json: async () => body(),
    } as never;
  };
  return new PluginRegistryClient(fetcher as unknown as typeof fetch);
}

async function main(): Promise<void> {
  const goodSig = signManifest(manifest, SHARED_SECRET);
  const loader = new PluginLoader({ registry: getAgentRegistry() });

  // 1) 验签通过 → 拉取并启用。
  const client = buildStubRegistry(goodSig);
  const rec = await loader.installFromRegistry(
    client,
    'http://registry.local',
    manifest.id,
    'latest',
    { verifySecret: SHARED_SECRET, scheme: 'hmac', autoEnable: true }
  );
  console.log('[registry] 验签通过，已入驻：', rec.manifest.id, rec.state);
  console.log('[registry] AgentCard 已注册：', !!getAgentRegistry().get('market-weather'));

  // 清理，便于反向演示。
  await loader.uninstall('market-weather');

  // 2) 验签失败 → 拒绝入驻。
  let rejected = false;
  try {
    const badClient = buildStubRegistry(goodSig + 'TAMPER');
    await loader.installFromRegistry(badClient, 'http://registry.local', manifest.id, 'latest', {
      verifySecret: SHARED_SECRET,
      scheme: 'hmac',
      autoEnable: true,
    });
  } catch (e) {
    rejected = true;
    console.log('[registry] 验签失败被正确拒绝：', (e as Error).message);
  }
  console.log('[registry] 投毒插件是否被拒：', rejected ? '是 ✓' : '否 ✗');

  if (!rejected) process.exit(1);
  console.log('[registry] 演示结束。');
}

main().catch((e) => {
  console.error('[registry] 失败：', e);
  process.exit(1);
});
