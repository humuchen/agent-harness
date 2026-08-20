/**
 * P0 检索冒烟探针：验证「词面 + 意图归一」检索对口语诉求的召回。
 * 仅依赖编译产物 dist/，不写任何数据。
 *
 * 用法：MA_DB_FILE=./.kb-smoke.db node scripts/kb-smoke.cjs
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { getDb, closeDb } = require(path.join(ROOT, 'dist', 'infra', 'db'));
const { searchProjects } = require(path.join(ROOT, 'dist', 'services', 'kb-service'));

// 口语诉求 → 期望能召回的项目（用于人工核对召回质量）
const QUERIES = [
  '脸大',        // → 瘦脸/下颌缘/面部吸脂
  '显老',        // → 面部年轻化
  '毛孔粗',      // → 光子嫩肤/果酸/水光
  '想变白',      // → 光子/果酸/水光
  '脱发严重',    // → 植发
  '肚子肉多',    // → 腹部吸脂/酷塑
  '法令纹深',    // → 玻尿酸/胶原/超声炮
  '眼睛无神',    // → 双眼皮/提眉/上睑
];

(async () => {
  getDb();
  let total = 0;
  let hit = 0;
  for (const q of QUERIES) {
    const r = await searchProjects(q, 3);
    total++;
    if (r.length) hit++;
    const top = r.map((p) => `${p.name}(${p.category ?? '-'})`).join(' / ') || '∅ 空召回';
    console.log(`「${q}」→ ${top}`);
  }
  console.log(`\n召回率：${hit}/${total} = ${Math.round((hit / total) * 100)}%`);
  closeDb();
  process.exit(0);
})().catch((e) => {
  console.error('❌ 冒烟失败：', e.message ?? e);
  try { closeDb(); } catch {}
  process.exit(1);
});
