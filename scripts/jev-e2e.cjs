#!/usr/bin/env node
/**
 * Jev（TypeSafe AI 决策模型）端到端链路验证脚本。
 *
 * 目的：回答「Jev 在整个系统里到底有没有被使用」。在真实编译产物（dist）上
 * 分阶段验证，每阶段输出 PASS/FAIL，最后给出人可读总结：
 *   阶段 0  环境自检：凭据来源 / 三个子系统开关 / 运行期状态
 *   阶段 1  工具注册：registerBuiltinTools 是否真的注册了 builtin__jev_decide
 *   阶段 2  直调链路（mock fetch）：工具调用 / 门禁语义层 / 路由分类，并核对调用统计
 *   阶段 3  真实联调（可选）：存在真实 TYPESAFE_API_KEY 时直连 /systemone 打一次样
 *
 * 用法：
 *   node scripts/jev-e2e.cjs                 # 阶段 0-2（不依赖真实 Key，fetch 全 mock）
 *   TYPESAFE_API_KEY=ts_live_xxx node scripts/jev-e2e.cjs   # 额外执行阶段 3 真实联调
 *
 * 退出码：0 = 全部阶段通过；1 = 任一阶段失败。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

// 定位 backend/core/dist（脚本可能从仓库根或其他 cwd 调起）。
const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_DIST = path.join(REPO_ROOT, 'backend', 'core', 'dist');
if (!fs.existsSync(path.join(CORE_DIST, 'builtins', 'typesafe-jev.js'))) {
  console.error('[FAIL] 未找到 backend/core/dist 编译产物，请先: pnpm --filter @agent-harness/core run build');
  process.exit(1);
}

const {
  ToolRegistry,
  registerBuiltinTools,
  jevDecide,
  jevClassifyDomain,
  getJevStats,
  resetJevStats,
  checkInputAsync,
  enableJevInjection
} = require(path.join(CORE_DIST, 'index.js'));

const results = [];
function report(stage, ok, detail) {
  results.push({ stage, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${stage}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== Jev 端到端链路验证 ===\n');

// ── 阶段 0：环境自检 ──────────────────────────────────────────────────────
console.log('阶段 0：环境自检');
const envKey = process.env.TYPESAFE_API_KEY;
const sw = (v) => (v || 'off').toLowerCase() === 'on';
const switches = {
  injectionGate: sw(process.env.JEV_INJECTION_GATE),
  routing: sw(process.env.JEV_ROUTING),
  contextCompress: sw(process.env.JEV_CONTEXT_COMPRESS)
};
console.log(`  凭据来源: ${envKey ? 'env (TYPESAFE_API_KEY 已设置)' : '未配置（工具不注册、自动层全兜底）'}`);
console.log(`  子系统开关: injectionGate=${switches.injectionGate} routing=${switches.routing} contextCompress=${switches.contextCompress}`);
report(
  '阶段0 环境自检',
  true,
  envKey
    ? '已配置 Key，可进入真实联调'
    : '未配置 Key —— 这正是「系统里测不到 Jev 被调用」的最常见原因'
);

// ── 阶段 1：工具注册 ──────────────────────────────────────────────────────
console.log('\n阶段 1：工具注册（builtin__jev_decide）');
{
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'e2e_mock_key';
  try {
    const r = new ToolRegistry();
    registerBuiltinTools(r, { fsEnabled: false, webEnabled: false, ragEnabled: false, shellEnabled: false });
    const names = r.schemas().map((s) => s.name);
    const has = names.includes('builtin__jev_decide');
    report(
      '阶段1 registerBuiltinTools 注册 Jev 工具',
      has,
      has ? 'schemas 中含 builtin__jev_decide' : `schemas=${names.join(',')}`
    );
    // 对照：删 Key 后不应注册。
    delete process.env.TYPESAFE_API_KEY;
    const r2 = new ToolRegistry();
    registerBuiltinTools(r2, { fsEnabled: false, webEnabled: false, ragEnabled: false, shellEnabled: false });
    const has2 = r2.schemas().some((s) => s.name === 'builtin__jev_decide');
    report('阶段1 未配置 Key 时不注册（降级可用）', !has2);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    else delete process.env.TYPESAFE_API_KEY;
  }
}

// ── 阶段 2：直调链路（mock fetch）＋调用统计 ─────────────────────────────
async function stage2() {
  console.log('\n阶段 2：直调链路（mock fetch，不访问外网）');
  resetJevStats();
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'e2e_mock_key';
  const origFetch = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url, init) => {
    hits.push({ url: String(url), auth: init?.headers?.Authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          is_injection: { noul: 0.03, confidence: 0.9 },
          domain: { choice: 'legal', confidence: 0.88 }
        }
      })
    };
  };
  try {
    // 2a. LLM 工具路径：注册表里直接调用。
    const r = new ToolRegistry();
    registerBuiltinTools(r, { fsEnabled: false, webEnabled: false, ragEnabled: false, shellEnabled: false });
    const out = JSON.parse(
      await r.call('builtin__jev_decide', {
        state: '用户催退款失败，语气焦虑',
        questions: { urgency: { type: 'score', min: 0, max: 100 } }
      })
    );
    report('阶段2a 工具路径（builtin__jev_decide 经 ToolRegistry.call）', !out.error, out.error ? JSON.stringify(out) : undefined);
    report('阶段2a 请求打到 /systemone 且带 Bearer', hits[0]?.url.endsWith('/systemone') && hits[0]?.auth === 'Bearer e2e_mock_key');

    // 2b. 门禁语义层：enableJevInjection 后 checkInputAsync 走 Jev 打分（良性文本应放行）。
    enableJevInjection();
    const g = await checkInputAsync('普通输入，不含注入。');
    report('阶段2b 门禁语义层（checkInputAsync 走 Jev 打分后放行）', g.ok === true, g.ok ? undefined : g.reason);

    // 2c. 路由分类。
    const d = await jevClassifyDomain('帮我写份合同', ['legal', 'finance']);
    report('阶段2c 路由分类（jevClassifyDomain）', d?.domain === 'legal', d ? `domain=${d.domain} conf=${d.confidence}` : '返回 null');

    // 2d. 调用统计：证明「系统层面 Jev 真的被调用过」，且 caller 归属正确。
    const stats = getJevStats();
    report(
      '阶段2d 调用统计（getJevStats）',
      stats.calls === 3 && stats.lastCalledAt !== null,
      `calls=${stats.calls} lastCaller=${stats.lastCaller} lastLatencyMs=${stats.lastLatencyMs}`
    );
  } finally {
    globalThis.fetch = origFetch;
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    else delete process.env.TYPESAFE_API_KEY;
  }
}

// ── 阶段 3 + 总结（包进 async main：CJS 无顶层 await）────────────────────
async function main() {
  await stage2();

  console.log('\n阶段 3：真实联调（仅当配置了真实 TYPESAFE_API_KEY）');
  if (!envKey || envKey.startsWith('e2e_mock')) {
    console.log('  [SKIP] 未配置真实 Key。启用方式：.env 写 TYPESAFE_API_KEY=ts_live_xxx（或前端「模型与密钥」按用户存 Key）。');
  } else {
    const t0 = Date.now();
    try {
      const d = await jevDecide(
        '用户两周内两次催退款失败，语气焦虑并要求立刻处理',
        {
          category: { type: 'choice', options: ['billing', 'technical', 'sales'], instructions: '应由哪个团队处理' },
          urgency: { type: 'score', min: 0, max: 100, instructions: '紧急程度' }
        },
        { caller: 'e2e-real' }
      );
      const cat = d.answers.category;
      const urg = d.answers.urgency;
      report(
        '阶段3 真实 /systemone 调用',
        true,
        `category=${cat?.choice}(${cat?.confidence}) urgency=${urg?.score} latency=${Date.now() - t0}ms`
      );
    } catch (e) {
      report('阶段3 真实 /systemone 调用', false, e.message);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== 总结 ===');
  if (failed.length === 0) {
    console.log(`全部 ${results.length} 项通过：Jev 接线在编译产物上验证有效。`);
    if (!envKey) {
      console.log('\n下一步（让系统真正用上 Jev）：');
      console.log('  1. .env 写入 TYPESAFE_API_KEY=ts_live_xxx（服务端级），或在 Web「设置→模型与密钥」按用户存 TypeSafe Key；');
      console.log('  2. 按需开启自动层开关：JEV_INJECTION_GATE=on（门禁）/ JEV_ROUTING=on（路由）/ JEV_CONTEXT_COMPRESS=on（压缩）；');
      console.log('  3. 重启服务后访问 GET /api/jev/status 查看凭据来源、开关与调用统计（calls/lastCaller）。');
    }
    process.exit(0);
  } else {
    console.log(`${failed.length}/${results.length} 项失败：`);
    for (const f of failed) console.log(`  - ${f.stage}`);
    process.exit(1);
  }
}

main();
