#!/usr/bin/env node
/**
 * knowledge → RAG 迁移脚本（一次性）。
 *
 * 把 plugins/medical-aesthetics-lead/knowledge/ 下的领域知识母版灌入外部 RAG 服务
 * （services/rag），并持久化到 JSON 向量库（RAG_DATA_FILE）。
 *
 * ⚠️ 注意：本脚本是「一次性迁移工具」，其数据源 knowledge/ 已在迁移完成后下线删除。
 *   因此脚本现在直接运行会判定 knowledge/ 不存在并安全退出（exit 0），不再可重跑。
 *   迁移产物 rag-store.json（默认 MA_DATA_DIR/rag-store.json，gitignored）是
 *   运行时唯一的持久化知识源——要重建新环境，请复制该 store 文件，或保留 knowledge/ 母版后再迁移。
 *
 * 设计要点：
 * - 复用 services/rag 的编译产物（dist/）：MemoryVectorStore + createEmbedder + ingestDocument，
 *   与运行期 RAG 服务使用同一套向量化代码 → 入库向量与查询向量维度/算法一致。
 * - 向量化提供方由 env 决定（同 RAG 服务）：设 RAG_EMBEDDING_API_KEY 走真实远程 embedding，
 *   否则默认 HashEmbedding(dim=RAG_EMBED_DIM=256) 零依赖演示。服务端与脚本用同一 env 即可对齐。
 * - project-catalog.json 不整篇灌入，而是**逐项目拆成结构化 doc**，元数据携带
 *   complianceReviewed / compliantCopy / summary 等字段，使 `project_kb_search` 在 RAG 上仍能
 *   重建「合规文案闸门」（compliantCopy 优先、未过审退回 summary 且不带疗效 FAQ）。
 * - 其余 md / json 作为 reference doc 灌入，带 category / confidence 元数据，供通用检索引用。
 *
 * 用法：
 *   node scripts/rag-ingest.cjs
 *   MA_RAG_DATA_FILE=/abs/rag-store.json node scripts/rag-ingest.cjs
 *   RAG_EMBEDDING_API_KEY=sk-... RAG_EMBED_DIM=1536 node scripts/rag-ingest.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const RAG_DIST = path.resolve(PLUGIN_ROOT, '..', '..', 'services', 'rag', 'dist');

// ── 复用 RAG 编译产物 ──────────────────────────────────────────────
const { MemoryVectorStore } = require(path.join(RAG_DIST, 'store'));
const { createEmbedder } = require(path.join(RAG_DIST, 'embed'));
const { ingestDocument } = require(path.join(RAG_DIST, 'ingest'));

const KNOWLEDGE_DIR = path.join(PLUGIN_ROOT, 'knowledge');

// 数据文件落地：MA_RAG_DATA_FILE > MA_DATA_DIR/rag-store.json > ./data/ma-lead/rag-store.json
function resolveDataFile() {
  if (process.env.MA_RAG_DATA_FILE) return path.resolve(process.env.MA_RAG_DATA_FILE);
  const dataDir = process.env.MA_DATA_DIR
    ? path.resolve(process.env.MA_DATA_DIR)
    : path.join(PLUGIN_ROOT, 'data', 'ma-lead');
  return path.join(dataDir, 'rag-store.json');
}
const DATA_FILE = resolveDataFile();

/** 从 markdown 头部 frontmatter 抽出 confidence（若有）。 */
function readConfidence(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return 'unknown';
  const cm = /confidence:\s*(\w+)/.exec(m[1]);
  return cm ? cm[1] : 'unknown';
}

/** 递归收集 knowledge/ 下的 .md / .json。 */
function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(md|json)$/.test(name)) out.push(full);
  }
  return out;
}

/** 逐项目拆成结构化 doc。 */
function projectDocs(catalog) {
  const projects = Array.isArray(catalog.projects) ? catalog.projects : [];
  return projects.map((p) => {
    const name = String(p.name ?? p.projectId ?? '');
    const aliases = Array.isArray(p.aliases) ? p.aliases.join('、') : '';
    const intentTags = Array.isArray(p.intentTags) ? p.intentTags.join('、') : '';
    const faq = Array.isArray(p.faq)
      ? p.faq.map((f) => (f && f.q ? (f.a ? `Q:${f.q} A:${f.a}` : `Q:${f.q}`) : '')).filter(Boolean).join('\n')
      : '';
    const text = [
      p.compliantCopy || p.summary || '',
      p.indications || '',
      p.contraindications || '',
      p.recovery || '',
      p.priceRange || '',
      aliases ? `别名：${aliases}` : '',
      intentTags ? `意图：${intentTags}` : '',
      p.audience || '',
      p.seasonality || '',
      faq ? `常见问题：\n${faq}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {
      doc_id: `project:${String(p.projectId ?? name)}`,
      title: name,
      text,
      tags: [String(p.category ?? '项目'), 'project'],
      metadata: {
        source: 'medical-aesthetics-lead/knowledge',
        type: 'project',
        category: p.category,
        name,
        projectId: p.projectId,
        aliases: p.aliases,
        intentTags: p.intentTags,
        complianceReviewed: p.complianceReviewed === true,
        compliantCopy: p.compliantCopy || '',
        summary: p.summary || '',
        indications: p.indications,
        contraindications: p.contraindications,
        recovery: p.recovery,
        priceRange: p.priceRange,
        faq: p.faq || [],
        audience: p.audience,
        seasonality: p.seasonality,
      },
    };
  });
}

/** 通用 reference doc（md / json，除 project-catalog 与若干忽略项）。 */
function referenceDoc(file) {
  const rel = path.relative(KNOWLEDGE_DIR, file).split(path.sep).join('/');
  const raw = fs.readFileSync(file, 'utf8');
  const isJson = file.endsWith('.json');
  const category = rel.split('/')[0] || 'reference';
  const base = path.basename(file);
  // 跳过：评测专用、说明文档
  if (base === 'golden-queries.json') return null;
  if (base.endsWith('.README.md')) return null;
  let text = raw;
  let confidence = 'unknown';
  if (!isJson) {
    confidence = readConfidence(raw);
    text = raw.replace(/^---\n[\s\S]*?\n---/, '').trim(); // 去 frontmatter
  }
  return {
    doc_id: `ref:${rel.replace(/\.(md|json)$/, '').replace(/[/\\]/g, '_')}`,
    title: base,
    text,
    tags: [category, 'reference'],
    metadata: {
      source: 'medical-aesthetics-lead/knowledge',
      type: 'reference',
      category,
      file: rel,
      confidence,
    },
  };
}

async function main() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.error(`[rag-ingest] knowledge/ 不存在：${KNOWLEDGE_DIR}（已迁移？）`);
    process.exit(0);
  }
  const provider = createEmbedder();
  const store = new MemoryVectorStore(provider.dim);

  const docs = [];
  for (const file of walk(KNOWLEDGE_DIR)) {
    if (path.basename(file) === 'project-catalog.json') {
      try {
        const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
        docs.push(...projectDocs(catalog));
      } catch (e) {
        console.warn(`[rag-ingest] 跳过 project-catalog.json（解析失败）：${e.message}`);
      }
    } else {
      const d = referenceDoc(file);
      if (d) docs.push(d);
    }
  }

  if (!docs.length) {
    console.error('[rag-ingest] 未读取到任何知识文档');
    process.exit(1);
  }

  let nProject = 0;
  let nRef = 0;
  for (const d of docs) {
    await ingestDocument(store, provider, {
      doc_id: d.doc_id,
      tenant_id: process.env.RAG_TENANT_ID || process.env.MA_TENANT_ID || 'default',
      title: d.title,
      text: d.text,
      tags: d.tags,
      metadata: d.metadata,
    });
    if (d.metadata.type === 'project') nProject++;
    else nRef++;
  }

  store.persist(DATA_FILE, (process.env.RAG_SHARD_BY_TENANT || '').toLowerCase() === 'true');

  console.log(
    `[rag-ingest] 完成：project=${nProject} reference=${nRef} 总 chunk→落盘 ${DATA_FILE}（dim=${store.dim}, tenant=${
      process.env.RAG_TENANT_ID || process.env.MA_TENANT_ID || 'default'
    }）`,
  );
  console.log('[rag-ingest] 启动 RAG 服务载入该库：');
  console.log(
    `  RAG_TRANSPORT=http RAG_DATA_FILE=${DATA_FILE} node ../../services/rag/dist/index.js`,
  );
}

main().catch((e) => {
  console.error('[rag-ingest] 失败：', e);
  process.exit(1);
});
