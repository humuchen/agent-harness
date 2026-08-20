/**
 * 知识库母版校验脚本（静态，无需打包 / 无需数据库）。
 *
 * 检查项：
 * 1. schema：project-catalog.json 每个项目必填字段与类型；projectId 唯一。
 * 2. 引用：Intent-map.json 的 projectId 必须存在于 catalog；comboWith 引用必须存在。
 * 3. 合规 lint：复用 knowledge/compliance/risk-lexicon.json，对对外文案
 *    （compliantCopy / summary / FAQ 答案）逐条匹配风险词。
 *    - high 命中 → error（对外文案须干净；complianceReviewed=true 却含高危词视为不一致）；
 *    - medium 命中 → warning。
 *
 * 用法：
 *   node scripts/kb-validate.cjs
 *   node scripts/kb-validate.cjs --strict    # warning 也计为失败（exit 1）
 *
 * 退出码：0 通过；1 有 error（或 --strict 下有 warning）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');
const catalogFile = path.join(ROOT, 'knowledge', 'domain', 'project-catalog.json');
const intentFile = path.join(ROOT, 'knowledge', 'domain', 'Intent-map.json');
const lexiconFile = path.join(ROOT, 'knowledge', 'compliance', 'risk-lexicon.json');

let errors = 0;
let warnings = 0;
const err = (msg) => { errors++; console.error(`  ❌ ${msg}`); };
const warn = (msg) => { warnings++; console.warn(`  ⚠️  ${msg}`); };

/**
 * 逐条匹配风险词；返回所有命中位置（含上下文安全例外）。
 * 安全例外：'永久' 出现在 '半永久'（半永久纹眉/化妆，专有名词）中属良性，跳过。
 */
function riskHits(text) {
  const hits = [];
  for (const rule of lexicon.rules) {
    let from = 0;
    let idx;
    while ((idx = text.indexOf(rule.term, from)) >= 0) {
      const prev = text[idx - 1];
      const isSafeHarbor = rule.term === '永久' && prev === '半'; // 半永久 = 良性专有名词
      if (!isSafeHarbor) hits.push({ rule, at: idx });
      from = idx + rule.term.length;
    }
  }
  return hits;
}

function lint(text, where, projectId, reviewed) {
  if (!text || typeof text !== 'string') return;
  const hits = riskHits(text);
  if (!hits.length) return;
  const isCompliantCopy = where.includes('compliantCopy');
  for (const { rule } of hits) {
    if (rule.severity === 'high') {
      err(`[${projectId}] ${where} 含高危风险词「${rule.term}」（${rule.category}）→ ${rule.suggestion}`);
    } else {
      warn(`[${projectId}] ${where} 含风险词「${rule.term}」（${rule.category}，${rule.severity}）→ ${rule.suggestion}`);
    }
    if (isCompliantCopy && reviewed) {
      err(`[${projectId}] complianceReviewed=true 但 compliantCopy 仍含高危词「${rule.term}」，复核不一致`);
    }
  }
}

// —— 加载词表 ——
let lexicon = { rules: [] };
if (fs.existsSync(lexiconFile)) {
  lexicon = JSON.parse(fs.readFileSync(lexiconFile, 'utf-8'));
}

// —— 1) 校验 catalog ——
console.log('🔍 校验 project-catalog.json ...');
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf-8'));
const ids = new Set();
for (const p of catalog.projects) {
  const id = p.projectId;
  if (!id || typeof id !== 'string') { err(`项目缺失 projectId`); continue; }
  if (ids.has(id)) err(`projectId 重复：${id}`);
  ids.add(id);

  if (!p.name || typeof p.name !== 'string') err(`[${id}] name 缺失/类型错`);
  if (!p.summary || typeof p.summary !== 'string') err(`[${id}] summary 缺失/类型错`);
  if (!p.priceRange || typeof p.priceRange !== 'string') err(`[${id}] priceRange 缺失/类型错`);
  if (!Array.isArray(p.aliases)) err(`[${id}] aliases 须为数组`);
  if (p.faq != null && !Array.isArray(p.faq)) err(`[${id}] faq 须为数组`);
  if (p.durationMin != null && typeof p.durationMin !== 'number') err(`[${id}] durationMin 须为数字`);
  if (p.painLevel != null && !(p.painLevel >= 1 && p.painLevel <= 5)) err(`[${id}] painLevel 须为 1-5`);
  if (p.complianceReviewed != null && typeof p.complianceReviewed !== 'boolean')
    err(`[${id}] complianceReviewed 须为布尔`);
  if (p.comboWith != null && !Array.isArray(p.comboWith)) err(`[${id}] comboWith 须为数组`);
  if (p.compliantCopy == null) warn(`[${id}] 缺少 compliantCopy（建议补齐对外合规文案）`);

  // 合规 lint（对客文案）
  const reviewed = p.complianceReviewed === true;
  lint(p.compliantCopy, 'compliantCopy', id, reviewed);
  lint(p.summary, 'summary', id, reviewed);
  if (Array.isArray(p.faq)) for (const f of p.faq) if (f.a) lint(f.a, 'faq.a', id, reviewed);
}

// 二次复核 comboWith（确保被引用项存在）
for (const p of catalog.projects) {
  for (const c of p.comboWith ?? []) if (c !== p.projectId && !ids.has(c)) err(`[${p.projectId}] comboWith 引用不存在的项目「${c}」`);
}

// —— 2) 校验意图映射 ——
console.log('🔍 校验 Intent-map.json ...');
const intents = JSON.parse(fs.readFileSync(intentFile, 'utf-8'));
const seen = new Set();
for (const m of intents.intents) {
  if (!m.intent || typeof m.intent !== 'string') err(`意图条目缺失 intent`);
  if (!m.projectId || !ids.has(m.projectId)) err(`意图「${m.intent}」引用未知 projectId「${m.projectId}」`);
  if (typeof m.weight !== 'number') err(`意图「${m.intent}→${m.projectId}」weight 须为数字`);
  if (!Array.isArray(m.keywords) || !m.keywords.every((k) => typeof k === 'string'))
    err(`意图「${m.intent}→${m.projectId}」keywords 须为字符串数组`);
  const key = `${m.intent}|${m.projectId}`;
  if (seen.has(key)) err(`意图映射重复：${key}`);
  seen.add(key);
}

// —— 汇总 ——
console.log(`\n📊 项目 ${catalog.projects.length} 个，意图条目 ${intents.intents.length} 条`);
if (errors === 0 && (warnings === 0 || !strict)) {
  console.log(`✅ 校验通过（error=${errors}, warning=${warnings}）`);
  process.exit(0);
} else {
  console.error(`❌ 校验未通过（error=${errors}, warning=${warnings}${strict ? '，--strict 下 warning 计为失败' : ''}）`);
  process.exit(1);
}
