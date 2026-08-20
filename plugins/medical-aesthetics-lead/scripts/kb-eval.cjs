/**
 * 知识库检索评测门禁（P2 评测闭环）。
 *
 * 载入 knowledge/domain/golden-queries.json，对每条口语 query 跑 searchProjects，
 * 校验是否召回任一期望 projectId，量化：
 *   - 命中率 hitRate = 命中数 / 总数（期望 >= gate.minHitRate）
 *   - 空召回率 emptyRecallRate = 0 结果数 / 总数（期望 <= gate.maxEmptyRecall）
 *
 * 退出码：0 通过；1 低于门禁（或数据/配置异常）。
 * 复用插件编译产物（dist/），与运行时代码一致；支持 MA_DB_FILE 指定库。
 *
 * 用法：
 *   node scripts/kb-eval.cjs                 # 用默认/MA_DB_FILE 库跑评测
 *   node scripts/kb-eval.cjs --db /abs/x.db  # 显式指定库
 *   MA_DB_FILE=./.kb-eval.db node scripts/kb-eval.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
if (dbIdx >= 0 && args[dbIdx + 1]) process.env.MA_DB_FILE = args[dbIdx + 1];

const goldenFile = path.join(ROOT, 'knowledge', 'domain', 'golden-queries.json');
const { getConfig } = require(path.join(ROOT, 'dist', 'config'));
const { getDb, closeDb } = require(path.join(ROOT, 'dist', 'infra', 'db'));
const { searchProjects } = require(path.join(ROOT, 'dist', 'services', 'kb-service'));

const cfg = getConfig();
const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf-8'));
const gate = golden.meta?.gate ?? { minHitRate: 0.9, maxEmptyRecall: 0.1 };

getDb();

(async () => {
  const qs = golden.queries ?? [];
  let hits = 0;
  let empty = 0;
  const failures = [];

  console.log(`\n🔎 知识库检索评测（门禁：命中率≥${gate.minHitRate}，空召回≤${gate.maxEmptyRecall}）\n`);
  console.log('query'.padEnd(22), '命中', 'top1'.padEnd(18), '期望');
  console.log('-'.repeat(64));

  for (const q of qs) {
    const res = await searchProjects(q.query, 5);
    const expect = q.expect ?? [];
    const hit = res.some((r) => expect.includes(r.projectId));
    if (hit) hits++;
    if (res.length === 0) empty++;
    const top1 = res[0] ? res[0].name : '∅ 空召回';
    const flag = hit ? '✅' : '❌';
    if (!hit) failures.push({ query: q.query, expect, got: res.map((r) => r.name) });
    console.log(
      flag,
      q.query.padEnd(20),
      hit ? 'Y' : 'N',
      top1.padEnd(18),
      expect.join('/')
    );
  }

  const total = qs.length;
  const hitRate = total ? hits / total : 0;
  const emptyRate = total ? empty / total : 0;
  console.log('-'.repeat(64));
  console.log(`总计 ${total} 条 | 命中 ${hits} | 命中率 ${(hitRate * 100).toFixed(1)}% | 空召回 ${empty} (${(emptyRate * 100).toFixed(1)}%)`);

  const belowHit = hitRate < gate.minHitRate;
  const aboveEmpty = emptyRate > gate.maxEmptyRecall;
  let ok = true;
  if (belowHit) { ok = false; console.error(`❌ 命中率 ${(hitRate * 100).toFixed(1)}% < 门禁 ${gate.minHitRate * 100}%`); }
  if (aboveEmpty) { ok = false; console.error(`❌ 空召回率 ${(emptyRate * 100).toFixed(1)}% > 门禁 ${gate.maxEmptyRecall * 100}%`); }

  if (!ok && failures.length) {
    console.error('\n未命中明细：');
    for (const f of failures) {
      console.error(`  「${f.query}」 期望[${f.expect.join('/')}] 实际[${f.got.join('/') || '∅'}]`);
    }
  }

  closeDb();
  if (ok) {
    console.log(`\n✅ 评测通过（tenant=${cfg.tenantId}）`);
    process.exit(0);
  } else {
    console.error(`\n❌ 评测未通过`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('❌ kb-eval 异常：', e.message ?? e);
  try { closeDb(); } catch {}
  process.exit(1);
});
