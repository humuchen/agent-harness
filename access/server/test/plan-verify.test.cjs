// 零依赖测试（node:test + node:assert）：P4.5 计划桥默认验证门禁的纯决策
// （plan-verify.resolvePlanVerify / parsePlanVerifyRetries，无副作用可独立单测）。
// 覆盖：
// - 非 plan 路径：优先级链与旧版逐字一致（body.verify / autoVerify / env），planOutputChecks=false
// - plan 路径默认：未显式指定 → 确定性门禁（auto + 结果断言 + 逐 task 断言 + 重试预算）
// - plan 路径显式 autoVerify:false → 用户选择退出，回落关闭（verifyConfig undefined）
// - plan 路径显式 body.verify → 原样采用，重试预算不覆盖（保持 AGENT_VERIFY_MAX_RETRIES 语义）
// - parsePlanVerifyRetries：缺省 1 / 显式值 / 非法值兜底
//
// 运行：pnpm --filter @agent-harness/server... build && node --test access/server/test/plan-verify.test.cjs

const test = require('node:test');
const assert = require('node:assert');

const {
  resolvePlanVerify,
  parsePlanVerifyRetries,
  PLAN_DEFAULT_ASSERTIONS
} = require('../dist/plan-verify.js');
const {
  GUARDRAIL_FALLBACK_PREFIX,
  PARTIAL_NOTICE
} = require('@agent-harness/core');

const base = {
  bodyVerify: undefined,
  bodyAutoVerify: undefined,
  envAutoVerify: false,
  planVerifyRetries: 1
};

test('非 plan 路径：未指定 verify → 全关（零回归）', () => {
  const r = resolvePlanVerify({ ...base, isPlan: false });
  assert.strictEqual(r.verifyConfig, undefined);
  assert.strictEqual(r.verifyMaxRetries, undefined);
  assert.strictEqual(r.planOutputChecks, false);
});

test('非 plan 路径：body.verify / autoVerify / env 优先级链逐字不变', () => {
  const v = { auto: true, assertions: [{ contains: 'x' }] };
  assert.deepStrictEqual(
    resolvePlanVerify({ ...base, isPlan: false, bodyVerify: v }).verifyConfig,
    v,
    'body.verify 原样采用'
  );
  assert.strictEqual(
    resolvePlanVerify({ ...base, isPlan: false, bodyAutoVerify: true }).verifyConfig.auto,
    true,
    'autoVerify:true'
  );
  assert.strictEqual(
    resolvePlanVerify({ ...base, isPlan: false, bodyAutoVerify: false }).verifyConfig,
    undefined,
    'autoVerify:false 显式关闭'
  );
  assert.strictEqual(
    resolvePlanVerify({ ...base, isPlan: false, envAutoVerify: true }).verifyConfig.auto,
    true,
    'env AGENT_AUTO_VERIFY 兜底'
  );
});

test('plan 默认：未显式指定 → 确定性门禁（auto + 结果断言 + 逐 task + 重试预算）', () => {
  const r = resolvePlanVerify({ ...base, isPlan: true });
  assert.strictEqual(r.verifyConfig.auto, true);
  assert.deepStrictEqual(
    r.verifyConfig.assertions.map((a) => a.notContains).filter(Boolean),
    [GUARDRAIL_FALLBACK_PREFIX, PARTIAL_NOTICE],
    '结果断言含护栏兜底 / 中断标记两条 notContains'
  );
  assert.ok(r.verifyConfig.assertions.some((a) => a.minLength === 20), '最小体量断言');
  assert.strictEqual(r.planOutputChecks, true, '逐 task 结果断言开关');
  assert.strictEqual(r.verifyMaxRetries, 1, '重试预算注入');
});

test('plan 默认：envAutoVerify 开启时优先 env（确定性断言不再叠加，保持存量语义）', () => {
  const r = resolvePlanVerify({ ...base, isPlan: true, envAutoVerify: true });
  // env 命中走存量 env 分支（verifyConfig={auto:true}，非显式）→ plan 默认回落同样命中
  // （env 分支未置 verifyExplicit，与 autoVerify:false 的「用户退出」区分开）。
  assert.ok(r.verifyConfig, '门禁开启');
  assert.strictEqual(r.planOutputChecks, true);
});

test('plan 显式 autoVerify:false → 用户选择退出（门禁关、逐 task 断言保留）', () => {
  const r = resolvePlanVerify({ ...base, isPlan: true, bodyAutoVerify: false });
  assert.strictEqual(r.verifyConfig, undefined);
  assert.strictEqual(r.verifyMaxRetries, undefined);
  assert.strictEqual(r.planOutputChecks, true, '结果断言正交于过程门禁，保留');
});

test('plan 显式 body.verify → 原样采用且重试预算不覆盖（存量 AGENT_VERIFY_MAX_RETRIES 语义）', () => {
  const v = { assertions: [{ contains: 'custom' }] };
  const r = resolvePlanVerify({ ...base, isPlan: true, bodyVerify: v });
  assert.deepStrictEqual(r.verifyConfig, v);
  assert.strictEqual(r.verifyMaxRetries, undefined, '显式配置不注入 plan 重试预算');
});

test('PLAN_DEFAULT_ASSERTIONS：三条确定性断言（兜底 / 截断 / 体量）', () => {
  assert.strictEqual(PLAN_DEFAULT_ASSERTIONS.length, 3);
});

test('parsePlanVerifyRetries：缺省 1 / 合法值 / 非法兜底 0', () => {
  assert.strictEqual(parsePlanVerifyRetries(undefined), 1);
  assert.strictEqual(parsePlanVerifyRetries('3'), 3);
  assert.strictEqual(parsePlanVerifyRetries('0'), 0);
  assert.strictEqual(parsePlanVerifyRetries('abc'), 0);
  assert.strictEqual(parsePlanVerifyRetries('-2'), 0, '负数兜底 0');
  assert.strictEqual(parsePlanVerifyRetries('2.7'), 2, '向下取整');
});
