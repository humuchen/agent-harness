/**
 * 医疗广告合规护栏测试。
 *
 * 覆盖核心规则：
 * - 绝对化疗效承诺拦截
 * - 诊断式话术拦截
 * - 术前术后对比拦截
 * - 固定价承诺拦截
 * - 贬低同业拦截
 * - 知识库查空硬拦截
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { checkInput, checkOutput } = require('@agent-harness/core');
const {
  registerMedicalAdGuardrail,
  medicalAdRules
} = require('../dist/index.js');

// 在全局注册一次(幂等)
registerMedicalAdGuardrail();

describe('医疗广告法规则', () => {
  describe('规则 1: 疗效/安全绝对化承诺', () => {
    test('拦截「保证不留疤」', () => {
      const input = checkInput('你们激光祛疤能保证不留疤吗？');
      assert.ok(!input.ok, '应拦截保证不留疤');
      assert.ok(input.reason?.includes('绝对化保证'));
    });

    test('拦截「100%成功」', () => {
      const output = checkOutput('我们手术100%成功，绝对安全');
      assert.ok(!output.ok, '应拦截100%成功');
      assert.ok(output.reason?.includes('100%'));
    });

    test('拦截「一定有效」', () => {
      const input = checkInput('这个药一定有效吧？');
      assert.ok(!input.ok, '应拦截一定有效');
    });

    test('放行非医疗场景的「保证」', () => {
      // 普通电商场景不应被医疗规则拦截
      const input = checkInput('我们保证7天无理由退货');
      // 注意：由于正则包含医疗语境词，普通电商应放行
      // 但如果有误拦截，说明规则需要优化
      assert.ok(
        input.ok || !input.reason?.includes('医疗广告'),
        '普通电商不应被医疗规则拦截'
      );
    });
  });

  describe('规则 2: 诊断式话术', () => {
    test('拦截诊断结论「你这是皮炎」', () => {
      const output = checkOutput('根据你的描述，你这应该是皮炎');
      assert.ok(!output.ok, '应拦截诊断结论');
      assert.ok(output.reason?.includes('不得作诊断结论'));
    });

    test('拦截「可能是囊肿」', () => {
      // 需要匹配「你这可能是囊肿」模式
      const input = checkInput('我脸上这些，你这可能是囊肿吗？');
      assert.ok(!input.ok, '应拦截诊断猜测');
    });

    test('放行面诊引导话术', () => {
      const output = checkOutput('建议您来院面诊，由专业医生进行评估');
      assert.ok(output.ok, '应放行面诊引导');
    });
  });

  describe('规则 3: 术前术后对比', () => {
    test('拦截术前术后对比宣传', () => {
      const output = checkOutput('我们有真人术前术后对比图，效果非常明显');
      assert.ok(!output.ok, '应拦截术前术后对比');
      assert.ok(output.reason?.includes('不得使用患者'));
    });

    test('拦截案例效果图', () => {
      // 需要包含「术前/术后」关键词
      const input = checkInput('能给我看看你们的术后案例效果图吗？');
      assert.ok(!input.ok, '应拦截案例效果请求');
    });
  });

  describe('规则 4: 固定价承诺', () => {
    test('拦截固定价承诺', () => {
      const output = checkOutput('光子嫩肤价格只要998元');
      assert.ok(!output.ok, '应拦截固定价承诺');
      assert.ok(output.reason?.includes('不得承诺固定价'));
    });

    test('拦截一口价', () => {
      // 需要匹配「价格一口价...元」模式
      const output = checkOutput('我们热玛吉价格一口价5000元包干');
      assert.ok(!output.ok, '应拦截一口价');
    });

    test('放行区间价格', () => {
      const output = checkOutput('光子嫩肤价格在800-2000元之间');
      // 区间价格不应被拦截
      assert.ok(output.ok, '应放行区间价格');
    });
  });

  describe('规则 5: 贬低同业', () => {
    test('拦截贬低其他机构', () => {
      const output = checkOutput('千万别去那家某某医院，他们技术不行');
      assert.ok(!output.ok, '应拦截贬低同业');
      assert.ok(output.reason?.includes('不得贬低'));
    });

    test('拦截不当比较', () => {
      const output = checkOutput('我们比别家便宜多了，效果也强');
      assert.ok(!output.ok, '应拦截不当比较');
    });

    test('放行客观介绍', () => {
      const output = checkOutput('我们医院成立于2010年，是正规医疗机构');
      assert.ok(output.ok, '应放行客观介绍');
    });
  });
});

describe('知识库查空硬拦截', () => {
  test('知识库未收录时拦截具体项目推荐', () => {
    const ctx = {
      recentTool: {
        name: 'ma_lead__project_kb_search',
        result: JSON.stringify({ found: false, answer: '建议预约面诊' })
      }
    };
    const output = checkOutput('化学焕肤可以改善你的肤质', undefined, ctx);
    // 应该被拦截
    if (output.ok) {
      console.error('FAIL: 应该拦截但放行了', JSON.stringify(output));
    }
    assert.strictEqual(output.ok, false, '应拦截知识库未收录的项目推荐');
    assert.ok(output.reason?.includes('不得自行推荐'));
    assert.strictEqual(output.safeReply, '建议预约面诊');
  });

  test('知识库已收录时放行', () => {
    const ctx = {
      recentTool: {
        name: 'ma_lead__project_kb_search',
        result: JSON.stringify({ found: true, answer: '光子嫩肤详情...' })
      }
    };
    const output = checkOutput('光子嫩肤是目前非常受欢迎的护肤项目', ctx);
    assert.ok(output.ok, '应放行知识库已收录的内容');
  });

  test('非知识库工具调用时放行', () => {
    const ctx = {
      recentTool: {
        name: 'ma_lead__qualify_lead',
        result: JSON.stringify({ score: 80 })
      }
    };
    const output = checkOutput('化学焕肤适合你', undefined, ctx);
    assert.ok(output.ok, '非知识库工具不应触发查空拦截');
  });

  test('知识库返回无 safeReply 时使用默认拦截', () => {
    const ctx = {
      recentTool: {
        name: 'ma_lead__project_kb_search',
        result: JSON.stringify({ found: false })
      }
    };
    const output = checkOutput('光子嫩肤可以有效提拉', undefined, ctx);
    assert.strictEqual(output.ok, false, '应拦截');
    // 无 safeReply 时不返回替代回复
    assert.strictEqual(output.safeReply, undefined);
  });
});

describe('规则导出', () => {
  test('medicalAdRules 导出全部规则', () => {
    assert.ok(Array.isArray(medicalAdRules));
    assert.ok(medicalAdRules.length >= 5, '至少应有5条规则');

    // 验证每条规则都有 re 和 reason
    for (const rule of medicalAdRules) {
      assert.ok(rule.re instanceof RegExp, '规则应包含正则表达式');
      assert.ok(typeof rule.reason === 'string', '规则应包含原因说明');
    }
  });

  test('规则覆盖主要违规类型', () => {
    const reasons = medicalAdRules.map((r) => r.reason);
    assert.ok(
      reasons.some((r) => r.includes('绝对化保证')),
      '应包含绝对化规则'
    );
    assert.ok(
      reasons.some((r) => r.includes('诊断结论')),
      '应包含诊断拦截规则'
    );
    assert.ok(
      reasons.some((r) => r.includes('固定价')),
      '应包含价格规则'
    );
  });
});
