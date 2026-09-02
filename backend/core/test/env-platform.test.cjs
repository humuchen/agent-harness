'use strict';
// 环境平台（EnvPlatform）可插拔契约测试：
// 1) 工厂按 ENV_PLATFORM 选择后端；
// 2) LocalEnvPlatform 真正起一个预览服务（create → URL 可访问 → destroy → URL 下线），
//    验证"自助环境闭环"无需 Harness 即可真实运行。
const test = require('node:test');
const assert = require('node:assert');

const { createEnvPlatform } = require('../dist/integrations/env-platform.js');
const { LocalEnvPlatform } = require('../dist/integrations/local-env-platform.js');
const { HarnessClient } = require('../dist/integrations/harness-client.js');

test('createEnvPlatform 默认返回 HarnessClient 且 dry-run', () => {
  delete process.env.ENV_PLATFORM;
  delete process.env.HARNESS_API_KEY;
  const p = createEnvPlatform();
  assert.ok(p instanceof HarnessClient);
  assert.strictEqual(p.kind, 'harness');
  assert.strictEqual(p.dryRun, true);
});

test('createEnvPlatform(local) 返回 LocalEnvPlatform 且非 dry-run', () => {
  const p = createEnvPlatform('local');
  assert.ok(p instanceof LocalEnvPlatform);
  assert.strictEqual(p.kind, 'local');
  assert.strictEqual(p.dryRun, false);
});

test('createEnvPlatform(k8s) 在未装依赖时构造即抛错（清晰报错，不静默降级）', () => {
  // 本机已安装 @kubernetes/client-node（CI/Linux 生产镜像标配），故构造不抛错。
  // 仅验证：若无依赖，抛错信息中包含 '@kubernetes/client-node' 字样——通过动态
  // require 检查；若依赖存在则跳过断言（保持跨平台一致）。
  let mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('@kubernetes/client-node');
  } catch (e) {
    // 依赖缺失：构造时应抛错且错误信息含 '@kubernetes/client-node'
    assert.throws(() => createEnvPlatform('k8s'), /@kubernetes\/client-node/);
    return;
  }
  // 依赖存在：验证实例化成功（不会抛错），且 kind 为 'k8s'。
  // 由于本机很可能无 kubeconfig，构造后 getStatus 可能失败，但构造本身应成功。
  const p = createEnvPlatform('k8s');
  assert.strictEqual(p.kind, 'k8s');
});

test('LocalEnvPlatform：真实起服 → 可访问 → 销毁 → 下线', async () => {
  const platform = new LocalEnvPlatform({ root: require('node:os').tmpdir() + '/local-env-test' });
  const envId = 'test-env-' + Date.now();
  const handle = await platform.createEphemeralEnvironment({
    envId,
    envType: 'preview',
    branch: 'feature/login',
    owner: 'alice',
    ttlHours: 1,
  });
  assert.strictEqual(handle.envId, envId);
  assert.strictEqual(handle.status, 'ready');
  assert.match(handle.envUrl, /^http:\/\/localhost:\d+$/);

  // 访问预览 URL 应 200 且含环境信息
  const res = await fetch(handle.envUrl);
  assert.strictEqual(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes(envId));
  assert.ok(body.includes('feature/login'));

  // 状态查询
  const status = await platform.getStatus(envId);
  assert.strictEqual(status, 'ready');

  // 销毁后 URL 应不可达
  const destroyed = await platform.destroyEnvironment({ envId });
  assert.strictEqual(destroyed.status, 'destroyed');
  const statusAfter = await platform.getStatus(envId);
  assert.strictEqual(statusAfter, undefined);
  await assert.rejects(() => fetch(handle.envUrl), /fetch failed|ECONNREFUSED|connection refused/i);
});

test('LocalEnvPlatform：withEvents 流式状态机 PROVISIONING→RUNNING→READY', async () => {
  const platform = new LocalEnvPlatform({ root: require('node:os').tmpdir() + '/local-env-test2' });
  const envId = 'test-env-evt-' + Date.now();
  const stages = [];
  const handle = await platform.createEphemeralEnvironmentWithEvents(
    { envId, envType: 'preview', branch: 'main', ttlHours: 1 },
    (s) => stages.push(s)
  );
  assert.strictEqual(handle.status, 'ready');
  assert.deepStrictEqual(stages, ['PROVISIONING', 'RUNNING', 'READY']);
  await platform.destroyEnvironment({ envId });
});
