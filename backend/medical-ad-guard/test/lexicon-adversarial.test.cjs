// 中期增强测试：对抗归一化（硬化匹配）+ 词库外置化 + 热更新。
// 独立进程运行（node --test 每文件独立进程），env 在文件内注入并显式 reload。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { checkInput, checkOutput } = require('@agent-harness/core');
const {
  registerMedicalAdGuardrail,
  reloadMedicalAdLexicon,
  medicalAdLexiconInfo,
  screenMedicalAdText,
  medicalAdRules,
} = require('../dist/index.js');

registerMedicalAdGuardrail();

describe('对抗归一化（hardenText 匹配）', () => {
  test('拦截「保~证不留疤」分隔符混淆（此前可绕过）', () => {
    const out = checkOutput('激光祛疤保~证不留疤', { scopes: ['medical-ad'] });
    assert.ok(!out.ok, '分隔符混淆应被硬化匹配拦截');
  });

  test('拦截「保证 不-留-疤」空白/连字符拆词', () => {
    const out = checkOutput('保证 不-留-疤 的祛疤方案', { scopes: ['medical-ad'] });
    assert.ok(!out.ok);
  });

  test('拦截全角「１００％成功」', () => {
    const out = checkOutput('我们手术１００％成功', { scopes: ['medical-ad'] });
    assert.ok(!out.ok, '全角数字/百分号应折叠后命中');
  });

  test('拦截零宽字符夹断「零\u200B风\u200B险」', () => {
    const out = checkOutput('包你零\u200B风\u200B险，保证100%有效', { scopes: ['medical-ad'] });
    assert.ok(!out.ok, '零宽字符应被剥除后命中');
  });

  test('KB 查空后「热-玛-吉」拆词仍被拦截（上下文规则硬化）', () => {
    const ctx = { recentTool: { name: 'ma_lead__project_kb_search', result: JSON.stringify({ found: false }) } };
    const out = checkOutput('推荐做 热-玛-吉 提拉', undefined, ctx);
    assert.strictEqual(out.ok, false, '拆词项目名应被硬化后拦截');
  });

  test('正常话术不因硬化产生新误伤', () => {
    // 区间价 + 电商保证（回归既有放行语义在硬化路径下不变）
    assert.ok(checkOutput('光子嫩肤价格在800-2000元之间', { scopes: ['medical-ad'] }).ok);
    assert.ok(checkInput('我们保证7天无理由退货', { scopes: [] }).ok);
  });

  test('screenMedicalAdText 返回命中原因（插件内自检同源）', () => {
    const hits = screenMedicalAdText('包你零\u3000风\u3000险 保证100%有效');
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((h) => h.reason.includes('100%')));
  });
});

describe('词库外置化 + 热更新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-lex-'));
  const lexPath = join(dir, 'lexicon.json');
  const baseline = medicalAdRules.length;

  before(() => {
    writeFileSync(lexPath, JSON.stringify({
      version: '2026.10-HOTFIX1',
      rules: [
        { id: 'cure-all-claim', pattern: '(包治|根治).{0,6}(百病|牛皮癣|白癜风)', reason: '医疗广告法：不得宣称包治根治' },
      ],
      kb_project_terms: ['少女针'],
    }), 'utf8');
    process.env.MEDICAL_AD_LEXICON_PATH = lexPath;
  });

  after(() => {
    delete process.env.MEDICAL_AD_LEXICON_PATH;
    reloadMedicalAdLexicon(); // 恢复内置词库（不影响同进程后续断言）
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
  });

  test('reload 加载外部词库并生效：新规则命中', () => {
    const meta = reloadMedicalAdLexicon();
    assert.strictEqual(meta.version, '2026.10-HOTFIX1');
    assert.strictEqual(meta.ruleCount, baseline + 1, '默认追加语义：规则数 = 内置 + 外部');
    assert.strictEqual(meta.kbTermCount > 40, true, 'KB 词表应含追加词');
    const out = checkOutput('我们外包治百病', { scopes: ['medical-ad'] });
    assert.ok(!out.ok, '外部词库新规则应即时生效');
    assert.ok(out.reason.includes('包治根治'));
  });

  test('medicalAdRules 稳定引用原位更新（消费方无需重取）', () => {
    assert.ok(medicalAdRules.length === baseline + 1);
    assert.ok(medicalAdRules.some((r) => r.id === 'cure-all-claim'));
  });

  test('追加 KB 项目词后查空拦截覆盖新词', () => {
    const ctx = { recentTool: { name: 'ma_lead__project_kb_search', result: JSON.stringify({ found: false }) } };
    const out = checkOutput('建议直接打少女针', undefined, ctx);
    assert.strictEqual(out.ok, false, '追加项目词应进入查空拦截词表');
  });

  test('非法正则 fail-fast（带规则定位）', () => {
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, JSON.stringify({ rules: [{ pattern: '(未闭合', reason: 'x' }] }), 'utf8');
    process.env.MEDICAL_AD_LEXICON_PATH = badPath;
    assert.throws(() => reloadMedicalAdLexicon(), /正则非法/, '非法 pattern 应显式抛错');
    // 环境已指向坏文件且激活失败 —— 词库保持旧状态（reload 抛错即终止，旧规则仍在 core 生效）
    process.env.MEDICAL_AD_LEXICON_PATH = lexPath;
    reloadMedicalAdLexicon();
  });

  test('信息查询接口返回当前词库元信息', () => {
    const info = medicalAdLexiconInfo();
    assert.strictEqual(info.version, '2026.10-HOTFIX1');
    assert.ok(info.source.endsWith('lexicon.json'));
  });
});
