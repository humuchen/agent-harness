/**
 * 知识库种子脚本：把项目知识母版 + 意图映射灌入 ma_project / ma_project_intent。
 *
 * 数据源（二选一）：
 * - 默认：knowledge/domain/project-catalog.json（JSON 母版，单一事实源，推荐）
 * - --csv：data/kb-template.csv（运营表格模板，简易 CSV 解析）
 *
 * 意图映射：knowledge/domain/Intent-map.json → ma_project_intent（先清空再写入，避免重复累积）。
 *
 * 可选 embedding（--embed，须 MA_EMBED_BASE_URL 已配）：
 *   对每个项目摘要实时嵌入并写回 embedding 列，供 hybrid 检索使用。
 *   未配或失败则跳过（embedding 保持 NULL），不伪造向量、不影响主流程。
 *
 * 复用插件编译产物（dist/），与运行时代码完全一致：自动幂等 DDL、WAL、tenant 隔离、ON CONFLICT upsert。
 *
 * 用法：
 *   node scripts/kb-seed.cjs                       # JSON 母版 + 意图 → 默认库
 *   node scripts/kb-seed.cjs --csv                 # 读 kb-template.csv（仅项目，不导入意图）
 *   node scripts/kb-seed.cjs --embed              # 额外生成 embedding（须配 MA_EMBED_*）
 *   node scripts/kb-seed.cjs --db /abs/x.db       # 显式指定库
 *   MA_TENANT_ID=tenant_a node scripts/kb-seed.cjs
 *
 * 幂等：重复执行只更新已有行，不产生重复。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const useCsv = args.includes('--csv');
const doEmbed = args.includes('--embed');
const dbIdx = args.indexOf('--db');
if (dbIdx >= 0 && args[dbIdx + 1]) {
  process.env.MA_DB_FILE = args[dbIdx + 1];
}
// 复用插件配置解析（懒解析：首次 getConfig() 时读 env）
const { getConfig } = require(path.join(ROOT, 'dist', 'config'));
const { getDb, closeDb } = require(path.join(ROOT, 'dist', 'infra', 'db'));
const { upsertProject, clearIntents, upsertIntent } = require(path.join(ROOT, 'dist', 'repo', 'kb-repo'));
const { embedText } = require(path.join(ROOT, 'dist', 'infra', 'embed'));

/** 简易 CSV 解析（支持引号包裹字段与字段内逗号）。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(field.trim()); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field.trim()); if (row.some((c) => c.length)) rows.push(row); }
  return rows;
}

/** 从 kb-template.csv 提取项目（10 列）。CSV 无新字段，仅输出基础字段。 */
function fromCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows.slice(1).filter((r) => r[idx['项目名']]).map((r) => {
    const name = r[idx['项目名']].trim();
    const faqText = (r[idx['常见问题']] ?? '').trim();
    return {
      projectId: name,
      name,
      category: (r[idx['分类']] ?? '').trim() || undefined,
      aliases: (r[idx['别名']] ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      summary: (r[idx['简介']] ?? '').trim(),
      indications: (r[idx['适应症']] ?? '').trim() || undefined,
      contraindications: (r[idx['禁忌']] ?? '').trim() || undefined,
      recovery: (r[idx['恢复期']] ?? '').trim() || undefined,
      priceRange: (r[idx['价格区间']] ?? '').trim() || undefined,
      faq: faqText ? [{ q: faqText }] : [],
      source: (r[idx['来源']] ?? 'import').trim() || 'import',
    };
  });
}

/** 从 project-catalog.json 提取项目（含 P0/P1 全部字段）。 */
function fromJson(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return doc.projects.map((p) => ({
    projectId: p.projectId,
    name: p.name,
    category: p.category,
    aliases: p.aliases ?? [],
    summary: p.summary,
    indications: p.indications,
    contraindications: p.contraindications,
    recovery: p.recovery,
    priceRange: p.priceRange,
    faq: p.faq ?? [],
    source: p.source ?? 'import',
    // —— P0 结构化扩编 ——
    intentTags: p.intentTags ?? [],
    comboWith: p.comboWith ?? [],
    audience: p.audience,
    seasonality: p.seasonality,
    durationMin: p.durationMin,
    painLevel: p.painLevel,
    downtimeDays: p.downtimeDays,
    courseSessions: p.courseSessions,
    avgPriceTier: p.avgPriceTier,
    // —— P1 合规内建 ——
    compliantCopy: p.compliantCopy,
    complianceReviewed: p.complianceReviewed,
  }));
}

/** 从 Intent-map.json 提取意图映射。 */
function fromIntentMap(file) {
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return (doc.intents ?? []).map((m) => ({
    intent: m.intent,
    projectId: m.projectId,
    weight: m.weight ?? 1,
    keywords: m.keywords ?? [],
  }));
}

/** 可选：实时嵌入单段文本（复用 src/infra/embed.ts，仅 MA_EMBED_BASE_URL 已配；失败返回 null，绝不伪造）。 */
async function embedProjectText(text) {
  return embedText(text);
}

(async () => {
  const src = useCsv
    ? fromCsv(path.join(ROOT, 'data', 'kb-template.csv'))
    : fromJson(path.join(ROOT, 'knowledge', 'domain', 'project-catalog.json'));
  if (!src.length) {
    console.error('❌ 未读取到任何项目（数据源为空）。');
    process.exit(1);
  }
  const cfg = getConfig();
  getDb(); // 初始化（幂等 DDL + WAL）

  // 1) 项目主表
  let imported = 0;
  let embedded = 0;
  for (const p of src) {
    let embedding = null;
    if (doEmbed) {
      embedding = await embedProjectText(`${p.name}。${p.summary} ${p.indications ?? ''}`);
      if (embedding) embedded++;
    }
    upsertProject({ ...p, active: true, updatedAt: Date.now(), embedding });
    imported++;
  }

  // 2) 意图映射（仅 JSON 母版模式导入；CSV 模式不含意图）
  let intentCount = 0;
  if (!useCsv) {
    const intents = fromIntentMap(path.join(ROOT, 'knowledge', 'domain', 'Intent-map.json'));
    if (intents.length) {
      clearIntents();
      for (const m of intents) {
        upsertIntent(m);
        intentCount++;
      }
    }
  }

  // 3) 校验：真实检索命中
  const { searchProjects } = require(path.join(ROOT, 'dist', 'services', 'kb-service'));
  const probe = await searchProjects(src[0].aliases[0] || src[0].name, 3);
  console.log(`✅ 已导入 ${imported} 个项目 → ${cfg.db.file}`);
  if (doEmbed) console.log(`   embedding：${embedded}/${imported} 条生成（未配 MA_EMBED_BASE_URL 则跳过）`);
  console.log(`   意图映射：${intentCount} 条`);
  console.log(`   tenant_id=${cfg.tenantId}  源=${useCsv ? 'kb-template.csv' : 'project-catalog.json+Intent-map'}`);
  console.log(`   ✅ 检索探针「${src[0].name}」命中 ${probe.length} 条${probe.length ? `（top: ${probe[0].name}）` : ''}`);
  closeDb();
  process.exit(0);
})().catch((e) => {
  console.error('❌ kb-seed 失败：', e.message ?? e);
  try { closeDb(); } catch {}
  process.exit(1);
});
