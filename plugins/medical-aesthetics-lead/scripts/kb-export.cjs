/**
 * 知识库导出脚本：把库内 ma_project / ma_project_intent 拉回 JSON，供与母版 diff / 审计。
 *
 * 与 scripts/kb-seed.cjs 方向相反：
 *   kb-seed  : 母版(JSON) → 库(SQLite)
 *   kb-export: 库(SQLite) → 导出 JSON（含 active / updatedAt 等运行态字段）
 *
 * 复用插件编译产物（dist/）。导出的 .export.json 可与 knowledge/domain/*.json 用任意 diff 工具比对，
 * 快速发现「线上库 vs 母版」的漂移（含被软删 active=false 的条目）。
 *
 * 用法：
 *   node scripts/kb-export.cjs                 # 导出到 knowledge/domain/{project-catalog,Intent-map}.export.json
 *   node scripts/kb-export.cjs --db /abs/x.db  # 显式指定库
 *   MA_TENANT_ID=tenant_a node scripts/kb-export.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
if (dbIdx >= 0 && args[dbIdx + 1]) {
  process.env.MA_DB_FILE = args[dbIdx + 1];
}
const { getConfig } = require(path.join(ROOT, 'dist', 'config'));
const { getDb, closeDb } = require(path.join(ROOT, 'dist', 'infra', 'db'));
const { listProjects } = require(path.join(ROOT, 'dist', 'repo', 'kb-repo'));

function projectToJson(p) {
  const out = {
    projectId: p.projectId,
    name: p.name,
    category: p.category ?? undefined,
    aliases: p.aliases ?? [],
    summary: p.summary,
    indications: p.indications,
    contraindications: p.contraindications,
    recovery: p.recovery,
    priceRange: p.priceRange,
    faq: p.faq ?? [],
    source: p.source,
    intentTags: p.intentTags ?? [],
    comboWith: p.comboWith ?? [],
    audience: p.audience,
    seasonality: p.seasonality,
    durationMin: p.durationMin,
    painLevel: p.painLevel,
    downtimeDays: p.downtimeDays,
    courseSessions: p.courseSessions,
    avgPriceTier: p.avgPriceTier,
    compliantCopy: p.compliantCopy,
    complianceReviewed: p.complianceReviewed ?? false,
    active: p.active ?? true,
    updatedAt: p.updatedAt,
  };
  return out;
}

(async () => {
  const cfg = getConfig();
  getDb();
  const db = getDb();

  // 项目
  const projects = listProjects(false, 1000).map(projectToJson);

  // 意图
  const intentRows = db
    .prepare('SELECT intent, project_id, weight, keywords FROM ma_project_intent WHERE tenant_id = ?')
    .all(cfg.tenantId);
  const intents = intentRows.map((r) => ({
    intent: r.intent,
    projectId: r.project_id,
    weight: r.weight ?? 1,
    keywords: (() => { try { return JSON.parse(r.keywords); } catch { return []; } })(),
  }));

  const catalogOut = { meta: { exportedAt: new Date().toISOString(), tenant: cfg.tenantId, source: 'ma_project' }, projects };
  const intentOut = { meta: { exportedAt: new Date().toISOString(), tenant: cfg.tenantId, source: 'ma_project_intent' }, intents };

  const catPath = path.join(ROOT, 'knowledge', 'domain', 'project-catalog.export.json');
  const intPath = path.join(ROOT, 'knowledge', 'domain', 'Intent-map.export.json');
  fs.writeFileSync(catPath, JSON.stringify(catalogOut, null, 2));
  fs.writeFileSync(intPath, JSON.stringify(intentOut, null, 2));

  console.log(`✅ 已导出 ${projects.length} 个项目 → ${catPath}`);
  console.log(`✅ 已导出 ${intents.length} 条意图 → ${intPath}`);
  console.log(`   与母版比对：diff knowledge/domain/project-catalog.json 与 project-catalog.export.json`);
  closeDb();
  process.exit(0);
})().catch((e) => {
  console.error('❌ kb-export 失败：', e.message ?? e);
  try { closeDb(); } catch {}
  process.exit(1);
});
