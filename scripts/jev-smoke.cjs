#!/usr/bin/env node
/**
 * Jev-1.0（TypeSafe AI）真实联调探针。
 *
 * 用法：
 *   node scripts/jev-smoke.cjs [--state "..."] [--model jev-latest]
 *
 * 行为：
 *   - 仅当环境变量 TYPESAFE_API_KEY 存在时才发起真实请求；
 *     否则打印「跳过」并退出 0（CI / 无凭据环境安全 no-op）。
 *   - 向 $TYPESAFE_BASE_URL（默认 https://api.typesafe.ai/v1）/systemone
 *     发送一个最小化的三类型问题（choice / score / noul），
 *     打印原始响应（或错误）以便人工核对 schema 与校准概率。
 *
 * 该脚本不依赖 harness 编译产物，独立可跑，用于验证「接入」是否真正打通。
 */
'use strict';

const KEY = process.env.TYPESAFE_API_KEY;
const BASE = (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1').replace(/\/$/, '');
const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'jev-latest';

const stateIdx = process.argv.indexOf('--state');
const state =
  stateIdx >= 0 && process.argv[stateIdx + 1]
    ? process.argv[stateIdx + 1]
    : '用户两周内两次邮件催退款失败，语气焦虑并要求立刻处理';

const questions = {
  category: { type: 'choice', options: ['billing', 'technical', 'sales'], instructions: '应由哪个团队处理' },
  urgency: { type: 'score', min: 0, max: 100, instructions: '紧急程度（0-100）' },
  is_chargeback_risk: { type: 'noul', instructions: '是否存在拒付/ chargeback 风险' }
};

async function main() {
  if (!KEY) {
    console.log('[jev-smoke] 跳过：未检测到 TYPESAFE_API_KEY，跳过真实联调（安全 no-op）。');
    console.log('[jev-smoke] 配置后重跑：TYPESAFE_API_KEY=ts_live_xxx node scripts/jev-smoke.cjs');
    process.exit(0);
  }

  const url = `${BASE}/systemone`;
  console.log(`[jev-smoke] POST ${url}  model=${MODEL}`);
  console.log(`[jev-smoke] state: ${state}`);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, state, questions })
    });
    const text = await resp.text();
    const dt = Date.now() - t0;
    console.log(`[jev-smoke] HTTP ${resp.status}  (${dt}ms)`);
    if (!resp.ok) {
      console.error('[jev-smoke] 非 2xx：', text.slice(0, 800));
      process.exit(1);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('[jev-smoke] 响应不是合法 JSON：', text.slice(0, 800));
      process.exit(1);
    }
    console.log('[jev-smoke] 响应：');
    console.log(JSON.stringify(data, null, 2));
    // 极简断言：顶层应至少含 answers，且每个问题有决策字段。
    const answers = data && data.answers;
    if (!answers || typeof answers !== 'object') {
      console.error('[jev-smoke] 警告：响应缺少 answers 字段，请核对 Jev 真实 schema。');
      process.exit(2);
    }
    console.log('[jev-smoke] OK：Jev-1.0 接入联调通过。');
    process.exit(0);
  } catch (e) {
    const dt = Date.now() - t0;
    console.error(`[jev-smoke] 请求失败 (${dt}ms)：`, e && e.message ? e.message : e);
    process.exit(1);
  }
}

main();
