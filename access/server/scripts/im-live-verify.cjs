'use strict';
// IM 真实平台「连通性」验证脚本（P0-2 的真实环境验证手段）。
//
// 本脚本不触达任何业务 webhook，仅做两件事：
//   1) 用与 server 相同的工厂（createImRegistry）校验 IM_* 凭据是否齐全、平台是否入列；
//   2) 对每个已启用平台，向真实 API 发起一次「换取令牌」请求（tenant_access_token /
//      accessToken / gettoken），确认凭据有效、网络可达。
//
// 仅做只读的令牌获取，不发送任何 IM 消息。失败（密钥错 / 网络不可达 / 沙箱无外网）
// 会明确区分原因，便于排障。
//
// 用法：
//   node access/server/scripts/im-live-verify.cjs
// 需先在环境变量中配置 IM_ENABLED=true 与各平台凭据（见下方示例）。

const path = require('node:path');
const { createImRegistry } = require(path.join(__dirname, '..', 'dist', 'im', 'index.js'));

const OUT = (s) => process.stdout.write(s + '\n');

async function withTimeout(promise, ms, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } catch (e) {
    return { __error: `${label}: ${e.name === 'AbortError' ? '超时' : e.message}` };
  } finally {
    clearTimeout(t);
  }
}

async function feishuToken(opt) {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: opt.appId, app_secret: opt.appSecret }),
    signal: arguments[1]
  });
  const d = await r.json();
  if (!d.tenant_access_token) throw new Error(d.msg || `HTTP ${r.status}`);
  return d.tenant_access_token;
}

async function dingtalkToken(opt) {
  const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: opt.clientId, appSecret: opt.clientSecret }),
    signal: arguments[1]
  });
  const d = await r.json();
  if (!d.accessToken) throw new Error(d.message || `HTTP ${r.status}`);
  return d.accessToken;
}

async function wecomToken(opt) {
  const url =
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(opt.corpId)}` +
    `&corpsecret=${encodeURIComponent(opt.secret)}`;
  const r = await fetch(url, { signal: arguments[1] });
  const d = await r.json();
  if (!d.access_token) throw new Error(d.errmsg || `HTTP ${r.status}`);
  return d.access_token;
}

function findAdapter(cfg, provider) {
  return cfg.adapters.find((a) => a.provider === provider);
}

async function main() {
  OUT('════════════════════════════════════════════════════');
  OUT('  IM 真实平台连通性验证（P0-2）');
  OUT('════════════════════════════════════════════════════');

  const { config, enabled, skipped } = createImRegistry(process.env);

  if (enabled.length === 0) {
    OUT('\n[!] 未启用任何 IM 平台（IM_ENABLED=true + 各平台凭据齐全才会入列）。');
    if (skipped.length) {
      OUT('    被跳过：');
      for (const s of skipped) OUT(`      - ${s.provider}: ${s.reason}`);
    }
    OUT('\n示例环境变量：');
    OUT('  IM_ENABLED=true');
    OUT('  IM_PROVIDERS=feishu,dingtalk,wecom');
    OUT('  IM_FEISHU_APP_ID=cli_xxx IM_FEISHU_APP_SECRET=xxx IM_FEISHU_VERIFICATION_TOKEN=xxx IM_FEISHU_ENCRYPT_KEY=xxx');
    OUT('  IM_DINGTALK_CLIENT_ID=xxx IM_DINGTALK_CLIENT_SECRET=xxx');
    OUT('  IM_WECOM_CORP_ID=xxx IM_WECOM_AGENT_ID=1 IM_WECOM_SECRET=xxx IM_WECOM_TOKEN=xxx IM_WECOM_AES_KEY=<43位>');
    process.exit(skipped.length ? 0 : 1);
  }

  OUT(`\n[✓] 已启用平台：${enabled.join(', ')}`);

  for (const provider of enabled) {
    const a = findAdapter(config, provider);
    OUT(`\n── ${provider} ───────────────────────────────────────`);
    try {
      const fn = provider === 'feishu' ? feishuToken : provider === 'dingtalk' ? dingtalkToken : wecomToken;
      const res = await withTimeout((sig) => fn(a.opt ?? a, sig), 8000, '令牌获取');
      if (res && res.__error) {
        OUT(`  [✗] 连通性失败：${res.__error}`);
        OUT('      可能原因：密钥错误 / 网络不可达 / 当前环境无外网（沙箱常见）。');
      } else {
        OUT(`  [✓] 凭据有效，成功换取令牌（长度 ${String(res).length}）。`);
      }
    } catch (e) {
      OUT(`  [✗] 异常：${e.message}`);
    }
    // 回调 URL（部署后在各平台控制台配置）
    OUT(`  回调地址（公网可达后配置到平台）：/api/im/${provider}/events`);
  }

  OUT('\n════════════════════════════════════════════════════');
  OUT('  协议级验证见单测：test/im-platform-verify.test.cjs');
  OUT('  （用与真实平台完全一致的加密/签名构造回调，跑通验签→解密→解析→执行）');
  OUT('════════════════════════════════════════════════════');
}

main().catch((e) => {
  OUT(`致命错误：${e.stack || e.message}`);
  process.exit(1);
});
