// 增强：A/B 统计显著性检验测试（两比例 z 检验 + Wilson 区间 + 报表接线）。
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  twoProportionZTest,
  wilsonInterval,
} = require('../dist/services/ab-service');

describe('twoProportionZTest（两比例 z 检验）', () => {
  test('已知显著差异：A 10% vs B 25%（n=100/100）→ p < 0.01', () => {
    const r = twoProportionZTest(10, 100, 25, 100);
    assert.ok(r);
    // 合并 p=0.175，se≈0.0537，z≈(0.10-0.25)/0.0537≈-2.79 → p≈0.005
    assert.ok(Math.abs(r.z) > 2.5 && Math.abs(r.z) < 3.0, `z 应在 2.5~3.0，实际 ${r.z}`);
    assert.ok(r.pValue < 0.01, `p 应 < 0.01，实际 ${r.pValue}`);
  });

  test('无差异：同比例两组 → p 接近 1', () => {
    const r = twoProportionZTest(10, 100, 20, 200);
    assert.ok(r);
    assert.ok(r.pValue > 0.3, `同比例 p 应大，实际 ${r.pValue}`);
  });

  test('零方差防护：双侧全 0/全 1 → z=0, p=1；n=0 → null', () => {
    assert.deepEqual(twoProportionZTest(0, 50, 0, 50), { z: 0, pValue: 1 });
    assert.deepEqual(twoProportionZTest(50, 50, 50, 50), { z: 0, pValue: 1 });
    assert.equal(twoProportionZTest(1, 0, 1, 10), null);
  });

  test('p 值单调性：差异越大 p 越小', () => {
    const small = twoProportionZTest(20, 200, 30, 200);
    const large = twoProportionZTest(10, 200, 40, 200);
    assert.ok(small && large && large.pValue < small.pValue);
  });
});

describe('wilsonInterval（Wilson 95% 区间）', () => {
  test('50% @ n=100 → 区间约 [0.40, 0.60]', () => {
    const [lo, hi] = wilsonInterval(50, 100);
    assert.ok(lo > 0.39 && lo < 0.41, `下界应≈0.40，实际 ${lo}`);
    assert.ok(hi > 0.59 && hi < 0.61, `上界应≈0.60，实际 ${hi}`);
  });

  test('区间包含点估计；0/1 边界不出界；n=0 → null', () => {
    const p = 0.3;
    const [lo, hi] = wilsonInterval(30, 100);
    assert.ok(lo <= p && p <= hi);
    assert.deepEqual(wilsonInterval(0, 10), [0, wilsonInterval(0, 10)[1]]);
    assert.ok(wilsonInterval(0, 10)[0] === 0);
    assert.ok(wilsonInterval(10, 10)[1] <= 1);
    assert.equal(wilsonInterval(0, 0), null);
  });

  test('小样本区间更宽（诚实性）', () => {
    const [, hiSmall] = wilsonInterval(1, 10);
    const [, hiBig] = wilsonInterval(100, 1000);
    assert.ok(hiSmall - 0.1 > hiBig - 0.1, 'n=10 的上界应远高于 n=1000');
  });
});
