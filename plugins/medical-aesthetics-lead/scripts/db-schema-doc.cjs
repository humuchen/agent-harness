#!/usr/bin/env node
/**
 * db-schema-doc.cjs — 通用 SQLite 表结构文档生成器
 *
 * 功能：连接任意 SQLite 数据库（本项目用 node:sqlite），读取所有表结构
 *      （表名 / 字段名 / 数据类型 / 是否可空 / 默认值 / 主键 / 注释），
 *      自动生成 Markdown 文档，按表分组，字段含注释（缺失则按字段名+上下文推断并标注）。
 *
 * 用法：
 *   node db-schema-doc.cjs [dbFile] [outFile]
 *   或环境变量：
 *     MA_DB_FILE     数据库文件路径（优先）
 *     MA_DOC_OUT     输出 .md 路径
 *     MA_SCHEMA_SRC  当数据库不存在时用于初始化的 schema 源文件（默认 src/infra/db.ts）
 *
 * 说明：
 *   - 若数据库文件不存在，会自动从 MA_SCHEMA_SRC 提取 `const SCHEMA = \`...\`` 并初始化，
 *     随后对真实库做 PRAGMA 内省，保证文档与代码 schema 同源。
 *   - SQLite 本身不存储列注释，故注释全部来自本脚本内置的领域字典；未覆盖字段走通用推断，
 *     并在文档中标注「（推断）」以便人工复核。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const scriptDir = __dirname;
const pluginRoot = path.resolve(scriptDir, '..');
const schemaSrc = process.env.MA_SCHEMA_SRC || path.join(pluginRoot, 'src', 'infra', 'db.ts');
const argDb = process.argv[2];
const argOut = process.argv[3];
const envDb = process.env.MA_DB_FILE;
const outFile =
  argOut || process.env.MA_DOC_OUT || path.join(pluginRoot, 'docs', 'DATABASE_SCHEMA.md');

// ---------------------------------------------------------------------------
// 领域注释字典（键：表名.字段名）。覆盖不到的走通用推断。
// ---------------------------------------------------------------------------
const COMMENTS = {
  'ma_lead.lead_id': '线索唯一标识（业务主键，由系统生成或外部渠道提供）',
  'ma_lead.tenant_id': '租户ID（多租户隔离字段，默认 default）',
  'ma_lead.channel': '获客渠道（wechat / douyin / xiaohongshu / meituan 等）',
  'ma_lead.intent': '客户意向诉求（自由文本，对话中提取）',
  'ma_lead.project': '归一化后的意向医美项目名',
  'ma_lead.budget': '预算区间（客户自述，文本）',
  'ma_lead.city': '客户所在城市（用于就近匹配院区）',
  'ma_lead.grade': '线索等级 A-D（由意图分类与资质评估得出）',
  'ma_lead.stage': '线索阶段（new→reach→qualify→book→consult→deal / lost）',
  'ma_lead.reached': '触达状态（new/contacted…，单调推进）',
  'ma_lead.name': '客户姓名',
  'ma_lead.phone': '客户手机号',
  'ma_lead.wechat': '客户微信号',
  'ma_lead.consent_at': '授权同意时间戳（留资合规：采集前需取得同意）',
  'ma_lead.clinic_id': '关联院区ID → ma_clinic.clinic_id',
  'ma_lead.clinic_name': '院区名称（冗余存储，便于前端直接展示）',
  'ma_lead.booking_date': '预约日期（YYYY-MM-DD）',
  'ma_lead.booking_time': '预约时段（HH:MM）',
  'ma_lead.appointment_id': '关联预约单ID → ma_appointment.appointment_id',
  'ma_lead.handed_off': '是否已转交人工（0/1）',
  'ma_lead.handoff_reason': '转交人工的原因说明',
  'ma_lead.consulted_by': '接诊咨询师（工号/姓名）',
  'ma_lead.crm_id': '外部 CRM 系统回写的客户ID',
  'ma_lead.crm_sync_state': 'CRM 同步状态（pending/synced/failed/disabled）',
  'ma_lead.crm_synced_at': 'CRM 同步完成时间戳',
  'ma_lead.created_at': '记录创建时间戳（Unix 毫秒）',
  'ma_lead.updated_at': '记录更新时间戳（Unix 毫秒）',

  'ma_lead_message.id': '自增主键',
  'ma_lead_message.lead_id': '归属线索ID → ma_lead.lead_id',
  'ma_lead_message.run_id': '运行实例ID（对话会话标识）',
  'ma_lead_message.role': '消息角色（user / assistant / system）',
  'ma_lead_message.text': '消息文本内容',
  'ma_lead_message.created_at': '创建时间戳（Unix 毫秒）',

  'ma_transcript.id': '自增主键',
  'ma_transcript.run_key': '运行会话键（尚未归属线索时暂存对话）',
  'ma_transcript.role': '消息角色（user / assistant / system）',
  'ma_transcript.text': '消息文本内容',
  'ma_transcript.created_at': '创建时间戳（Unix 毫秒）',

  'ma_project.project_id': '项目ID（主键）',
  'ma_project.tenant_id': '租户ID（多租户隔离）',
  'ma_project.name': '项目名称',
  'ma_project.category': '项目分类（如 光电 / 注射 / 手术）',
  'ma_project.aliases': '别名（逗号分隔，用于检索匹配）',
  'ma_project.summary': '项目简介',
  'ma_project.indications': '适应症',
  'ma_project.contraindications': '禁忌症',
  'ma_project.recovery': '恢复期说明',
  'ma_project.price_range': '价格区间',
  'ma_project.faq': '常见问题（JSON 数组）',
  'ma_project.source': '数据来源（db / 外部 KB 服务名）',
  'ma_project.active': '是否启用（1=是 / 0=否）',
  'ma_project.updated_at': '更新时间戳（Unix 毫秒）',

  'ma_clinic.clinic_id': '院区ID（主键）',
  'ma_clinic.tenant_id': '租户ID（多租户隔离）',
  'ma_clinic.name': '院区名称',
  'ma_clinic.city': '院区所在城市',
  'ma_clinic.address': '院区地址',
  'ma_clinic.phone': '院区联系电话',
  'ma_clinic.active': '是否启用（1=是 / 0=否）',
  'ma_clinic.updated_at': '更新时间戳（Unix 毫秒）',

  'ma_slot.slot_id': '号源ID（主键）',
  'ma_slot.tenant_id': '租户ID（多租户隔离）',
  'ma_slot.clinic_id': '关联院区ID → ma_clinic.clinic_id',
  'ma_slot.slot_date': '号源日期（YYYY-MM-DD）',
  'ma_slot.slot_time': '号源时段（HH:MM）',
  'ma_slot.capacity': '该时段可预约上限',
  'ma_slot.booked': '已占用数量（capacity - booked = 剩余）',
  'ma_slot.status': '号源状态（open / closed）',
  'ma_slot.doctor': '接诊医生',
  'ma_slot.updated_at': '更新时间戳（Unix 毫秒）',

  'ma_appointment.appointment_id': '预约单ID（主键）',
  'ma_appointment.tenant_id': '租户ID（多租户隔离）',
  'ma_appointment.lead_id': '关联线索ID → ma_lead.lead_id',
  'ma_appointment.clinic_id': '关联院区ID → ma_clinic.clinic_id',
  'ma_appointment.slot_id': '关联号源ID → ma_slot.slot_id',
  'ma_appointment.slot_date': '预约日期（冗余自号源，便于查询）',
  'ma_appointment.slot_time': '预约时段（冗余自号源，便于查询）',
  'ma_appointment.status': '预约状态（booked / cancelled / arrived / completed）',
  'ma_appointment.external_id': '外部 HIS 回写的预约单号',
  'ma_appointment.external_status': '外部 HIS 回写的预约状态',
  'ma_appointment.created_at': '创建时间戳（Unix 毫秒）',
  'ma_appointment.updated_at': '更新时间戳（Unix 毫秒）',

  'ma_outbox.id': '自增主键',
  'ma_outbox.tenant_id': '租户ID（多租户隔离）',
  'ma_outbox.topic': '事件主题（lead.upsert / appt.create）',
  'ma_outbox.idempotency_key': '幂等键（UNIQUE，去重，保证至少一次投递）',
  'ma_outbox.payload': '事件载荷（JSON 字符串）',
  'ma_outbox.state': '投递状态（pending / sent / failed）',
  'ma_outbox.attempts': '已投递尝试次数',
  'ma_outbox.last_error': '最近一次投递错误',
  'ma_outbox.next_retry_at': '下次重试时间戳（Unix 毫秒）',
  'ma_outbox.created_at': '创建时间戳（Unix 毫秒）',
  'ma_outbox.updated_at': '更新时间戳（Unix 毫秒）',

  'ma_inbound_message.id': '自增主键',
  'ma_inbound_message.tenant_id': '租户ID（多租户隔离）',
  'ma_inbound_message.channel': '来源渠道',
  'ma_inbound_message.external_id': '渠道侧消息ID（去重键组成部分）',
  'ma_inbound_message.lead_key': '线索关联键（用于归并到同一客户）',
  'ma_inbound_message.text': '入站消息文本',
  'ma_inbound_message.state': '处理状态（received / dispatched / processed / error）',
  'ma_inbound_message.run_id': '关联运行实例ID',
  'ma_inbound_message.error': '处理失败时的错误信息',
  'ma_inbound_message.received_at': '接收时间戳（Unix 毫秒）',
  'ma_inbound_message.processed_at': '处理完成时间戳（Unix 毫秒）',
};

const TABLE_PURPOSES = {
  ma_lead: '客资线索主表（业务系统记录，system of record）',
  ma_lead_message: '线索对话消息明细（已归属线索的对话记录）',
  ma_transcript: '运行期对话暂存（尚未归属线索，qualify 时按 run_key 归集）',
  ma_project: '项目知识库（运营导入或外部 KB 同步，源码不内置语料）',
  ma_clinic: '院区信息（HIS 权威副本，查询用）',
  ma_slot: '号源（capacity/booked 支持并发占用，事务防超卖）',
  ma_appointment: '预约单（占用号源后生成）',
  ma_outbox: 'CRM/HIS 同步发件箱（至少一次投递，避免抖动丢客资）',
  ma_inbound_message: '渠道入站消息（webhook 落库，去重 + 可重放）',
};

// ---------------------------------------------------------------------------
// 通用注释推断（字段字典未覆盖时启用），返回 { text, inferred }
// ---------------------------------------------------------------------------
function genericInfer(col) {
  const c = col.toLowerCase();
  if (col === 'id' || c.endsWith('_id'))
    return { text: '关联ID（外键，指向对应主表记录）', inferred: true };
  if (c.endsWith('_at')) return { text: '时间戳（Unix 毫秒）', inferred: true };
  if (c === 'status' || c.endsWith('_status')) return { text: '状态标识', inferred: true };
  if (c.endsWith('_state')) return { text: '状态标识', inferred: true };
  if (c.endsWith('_count')) return { text: '计数', inferred: true };
  if (c === 'created_at') return { text: '创建时间戳（Unix 毫秒）', inferred: true };
  if (c === 'updated_at') return { text: '更新时间戳（Unix 毫秒）', inferred: true };
  if (c === 'tenant_id') return { text: '租户ID（多租户隔离）', inferred: true };
  if (c === 'name') return { text: '名称', inferred: true };
  if (c === 'phone') return { text: '联系电话', inferred: true };
  if (c === 'active') return { text: '是否启用（1=是 / 0=否）', inferred: true };
  if (c.endsWith('_key')) return { text: '键（用于去重或关联）', inferred: true };
  if (c.endsWith('_error')) return { text: '错误信息', inferred: true };
  if (c.endsWith('_by')) return { text: '操作人', inferred: true };
  if (c.endsWith('_reason')) return { text: '原因说明', inferred: true };
  if (c === 'text' || c.endsWith('_text')) return { text: '文本字段', inferred: true };
  if (c === 'type') return { text: '类型标识', inferred: true };
  return { text: '（待补充：字段含义需结合业务确认）', inferred: true };
}

function commentFor(table, col) {
  const key = `${table}.${col}`;
  if (COMMENTS[key]) return { text: COMMENTS[key], inferred: false };
  return genericInfer(col);
}

// ---------------------------------------------------------------------------
// 从 db.ts 提取 SCHEMA 模板字面量（用于数据库尚未存在时的初始化）
// ---------------------------------------------------------------------------
function extractSchema(srcFile) {
  const src = fs.readFileSync(srcFile, 'utf8');
  // SCHEMA 以 `const SCHEMA = \`` 开头、以 `` ` `` 紧跟可选空白与 `;` 结尾；
  // 其内部不含反引号，故可安全用非贪婪匹配。
  const m = src.match(/const SCHEMA = `([\s\S]*?)`\s*;/);
  if (!m) throw new Error(`无法从 ${srcFile} 提取 SCHEMA 模板字面量`);
  return m[1];
}

function bootstrap(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const conn = new DatabaseSync(dbFile);
  conn.exec('PRAGMA journal_mode = WAL;');
  conn.exec(extractSchema(schemaSrc));
  // 兼容旧库：补 external_status 列（与 db.ts 的 runMigrations 一致）
  const cols = conn
    .prepare('PRAGMA table_info(ma_appointment)')
    .all()
    .map((r) => r.name);
  if (!cols.includes('external_status')) {
    conn.exec('ALTER TABLE ma_appointment ADD COLUMN external_status TEXT;');
  }
  conn.close();
  console.error(`[bootstrap] 已从 ${schemaSrc} 初始化数据库：${dbFile}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function resolveDbFile() {
  const cands = [];
  if (envDb) cands.push(envDb);
  if (argDb) cands.push(argDb);
  cands.push(path.join(pluginRoot, 'data', 'ma-lead', 'ma-lead.sqlite'));
  const existing = cands.find((f) => fs.existsSync(f));
  if (existing) return { file: existing, bootstrapped: false };
  const target = cands[cands.length - 1];
  bootstrap(target);
  return { file: target, bootstrapped: true };
}

function main() {
  const { file: dbFile, bootstrapped } = resolveDbFile();
  const conn = new DatabaseSync(dbFile);

  const tables = conn
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name);

  // 收集所有表的主键集合，用于 FK 推断
  const pkMap = {};
  for (const t of tables) {
    pkMap[t] = conn
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .filter((r) => r.pk > 0)
      .map((r) => r.name);
  }

  // 推断外键关系：列名以 _id 结尾，且存在某张表以该列名作为主键（排除自引用）
  const relations = [];
  for (const t of tables) {
    const cols = conn.prepare(`PRAGMA table_info(${t})`).all();
    for (const c of cols) {
      if (!c.name.endsWith('_id')) continue;
      const refTable = tables.find((T) => T !== t && pkMap[T] && pkMap[T].includes(c.name));
      if (refTable) relations.push(`- \`${t}.${c.name}\` → \`${refTable}.${c.name}\``);
    }
  }

  const lines = [];
  lines.push('# 医美客资插件 · 数据库表结构文档');
  lines.push('');
  lines.push(`> 自动生成时间：${new Date().toISOString()}`);
  lines.push(`> 数据库文件：\`${dbFile}\``);
  if (bootstrapped) lines.push('> 说明：数据库文件初始不存在，已由 `src/infra/db.ts` 的 SCHEMA 自动初始化后内省生成。');
  lines.push(
    '> 注释来源：本脚本内置领域字典。标注 **（推断）** 的字段为按字段名/上下文自动推断，需人工复核。'
  );
  lines.push('');
  lines.push(`共 **${tables.length}** 张表。`);
  lines.push('');

  // 表关系总览
  lines.push('## 表关系总览');
  lines.push('');
  if (relations.length) {
    relations.forEach((r) => lines.push(r));
  } else {
    lines.push('_未检测到基于命名的外键关系。_');
  }
  lines.push('');

  // 逐表
  for (const t of tables) {
    const cols = conn.prepare(`PRAGMA table_info(${t})`).all();
    const indexes = conn.prepare(`PRAGMA index_list(${t})`).all().map((r) => r.name);
    lines.push(`## ${t}`);
    lines.push('');
    lines.push(`**用途**：${TABLE_PURPOSES[t] || '（未在用途字典中登记，请补充）'}`);
    lines.push('');
    lines.push('| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of cols) {
      const nullable = c.notnull === 1 ? '否 (NOT NULL)' : '是';
      const dflt = c.dflt_value === null || c.dflt_value === undefined ? '—' : `\`${c.dflt_value}\``;
      const pk = c.pk > 0 ? '是 (PK)' : '—';
      const cm = commentFor(t, c.name);
      const comment = cm.inferred ? `${cm.text} **（推断）**` : cm.text;
      lines.push(`| \`${c.name}\` | ${c.type || '—'} | ${nullable} | ${dflt} | ${pk} | ${comment} |`);
    }
    if (indexes.length) {
      lines.push('');
      lines.push(`**索引**：${indexes.map((i) => `\`${i}\``).join('、')}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  conn.close();

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.error(`[done] 已生成结构文档：${outFile}（${tables.length} 张表）`);
}

main();
