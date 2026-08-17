/**
 * 客资生命周期共享存储（文件后端，复刻 customer-service 的原子写 + 扫目录聚合模式）。
 * 目录优先级：MA_DATA_DIR > MEMORY_DIR/plugins/medical-aesthetics-lead > ./data/ma-lead（单实例降级）。
 * 多副本共享同一 RWX 卷时，任意副本写入的 lead 都能被看板聚合看到。
 *
 * 漏斗语义：stage 为「当前阶段」，reached 为「到达过的最远阶段」（单调不回退）。
 * 看板漏斗按 reached 做**累计**统计（qualified >= captured >= booked >= arrived >= deal），
 * 这样即便线索已推进到 booked，仍计入其经过的 qualified/captured，符合转化漏斗直觉。
 * lost 为独立沉淀，不计入到店/成交。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type LeadStage =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'captured'
  | 'booked'
  | 'arrived'
  | 'deal'
  | 'lost';
export type LeadGrade = 'A' | 'B' | 'C' | 'D';

/** 阶段顺序（漏斗单调方向）。lost 为独立沉淀，不在此序列内。 */
const ORDER: LeadStage[] = ['new', 'contacted', 'qualified', 'captured', 'booked', 'arrived', 'deal'];
function rank(s: LeadStage): number {
  const i = ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

export interface LeadRecord {
  leadId: string;
  channel: string; // 抖音/小红书/微信/美团/官网
  source?: string;
  project?: string;
  budget?: string;
  city?: string;
  grade?: LeadGrade;
  /** 当前阶段。 */
  stage: LeadStage;
  /** 到达过的最远阶段（单调不回退），漏斗累计统计依据。 */
  reached?: LeadStage;
  wechat?: string;
  phone?: string;
  name?: string;
  clinic?: string;
  bookingDate?: string;
  bookingTime?: string;
  handedOff?: boolean;
  consultedBy?: string;
  transcript?: { role: string; text: string; t: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface LeadStats {
  total: number;
  funnel: Record<LeadStage, number>;
  channelDist: Record<string, number>;
  gradeDist: Record<string, number>;
  arrived: number;
  deal: number;
  arriveRate: number; // 0-100
  dealRate: number; // 0-100
  followupQueue: LeadRecord[]; // C 级 / 未到店未成交，待唤醒
  handoffQueue: LeadRecord[]; // 已转人工待咨询师认领
}

const DATA_DIR =
  process.env.MA_DATA_DIR ??
  (process.env.MEMORY_DIR
    ? join(process.env.MEMORY_DIR, 'plugins', 'medical-aesthetics-lead')
    : join(process.cwd(), 'data', 'ma-lead'));

// 对话记录（transcript）单独存放在 transcripts/ 子目录，与「客资线索」物理隔离：
// 这样无关对话只落 transcript，不会在 DATA_DIR 根目录生成 .json，从而不会污染客资看板。
const TRANSCRIPT_DIR = join(DATA_DIR, 'transcripts');

// 当前运行上下文（由事件桥接在 run:start / run:end 间维护），用于把「当次对话」的
// transcript 在 lead_qualify 时刻补录到真实线索上。模块级单例，仅用于单租户演示。
let currentRunKey: string | null = null;

function safeFile(key: string): string {
  const cleaned = String(key ?? 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return join(DATA_DIR, `${cleaned || 'anonymous'}.json`);
}

function readRecord(key: string): LeadRecord | null {
  try {
    const d = JSON.parse(readFileSync(safeFile(key), 'utf-8')) as Partial<LeadRecord>;
    const stage = (d.stage ?? 'new') as LeadStage;
    return {
      leadId: key,
      channel: d.channel ?? 'unknown',
      source: d.source,
      project: d.project,
      budget: d.budget,
      city: d.city,
      grade: d.grade,
      stage,
      reached: (d.reached as LeadStage | undefined) ?? stage,
      wechat: d.wechat,
      phone: d.phone,
      name: d.name,
      clinic: d.clinic,
      bookingDate: d.bookingDate,
      bookingTime: d.bookingTime,
      handedOff: !!d.handedOff,
      consultedBy: d.consultedBy,
      transcript: Array.isArray(d.transcript) ? (d.transcript as any) : undefined,
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeRecord(r: LeadRecord): void {
  mkdirSync(dirname(safeFile(r.leadId)), { recursive: true });
  const tmp = `${safeFile(r.leadId)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2)}`;
  writeFileSync(tmp, JSON.stringify(r), 'utf-8');
  renameSync(tmp, safeFile(r.leadId));
}

function mutate(key: string, fn: (r: LeadRecord) => void): void {
  const r = readRecord(key) ?? {
    leadId: key,
    channel: 'unknown',
    stage: 'new' as LeadStage,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fn(r);
  // 单调推进 reached：除 lost 外，reached 取「已达最远」与「当前 stage」的较大者。
  if (r.stage === 'lost') {
    if (!r.reached) r.reached = 'lost';
  } else {
    const cur = r.reached ? rank(r.reached) : rank(r.stage);
    r.reached = ORDER[Math.max(cur, rank(r.stage))];
  }
  r.updatedAt = Date.now();
  writeRecord(r);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export function upsertLead(
  id: string,
  patch: Partial<Omit<LeadRecord, 'leadId' | 'createdAt' | 'updatedAt'>>
): void {
  if (!id) return;
  mutate(id, (r) => Object.assign(r, patch));
}

export function appendMessage(id: string, role: string, text: string): void {
  if (!id) return;
  mutate(id, (r) => {
    const turns = r.transcript ?? [];
    turns.push({ role, text: String(text ?? '').slice(0, 4000), t: Date.now() });
    r.transcript = turns.slice(-50);
  });
}

// ---------------------------------------------------------------------------
// 对话记录（transcript）：独立于「客资线索」存储，绝不创建 lead 记录
// ---------------------------------------------------------------------------

function safeTranscriptFile(runKey: string): string {
  const cleaned = String(runKey ?? 'anon').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return join(TRANSCRIPT_DIR, `${cleaned || 'anon'}.json`);
}

function readTranscript(runKey: string): { role: string; text: string; t: number }[] {
  try {
    const d = JSON.parse(readFileSync(safeTranscriptFile(runKey), 'utf-8')) as { turns?: unknown };
    return Array.isArray(d.turns) ? (d.turns as { role: string; text: string; t: number }[]) : [];
  } catch {
    return [];
  }
}

/** 仅落对话记录到 transcripts/ 子目录，不创建任何客资线索（修复「无关对话污染看板」）。 */
export function appendTranscript(runKey: string, role: string, text: string): void {
  if (!runKey) return;
  const turns = readTranscript(runKey);
  turns.push({ role, text: String(text ?? '').slice(0, 4000), t: Date.now() });
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const tmp = `${safeTranscriptFile(runKey)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2)}`;
  writeFileSync(tmp, JSON.stringify({ runKey, turns: turns.slice(-50) }), 'utf-8');
  renameSync(tmp, safeTranscriptFile(runKey));
}

// 运行上下文维护（事件桥接调用），用于在 lead_qualify 时刻补录当次对话。
export function beginRun(runKey: string): void {
  currentRunKey = runKey;
}
export function endRun(): void {
  currentRunKey = null;
}

/**
 * 把「当前运行」的对话记录补录到真实线索上。仅当该 lead 已存在时才补录，
 * 绝不凭空创建线索——这是与事件桥接解耦、避免污染看板的关键。
 */
export function attachCurrentRunTranscript(leadId: string): void {
  if (!leadId || !currentRunKey) return;
  const turns = readTranscript(currentRunKey);
  if (!turns.length) return;
  const existing = readRecord(leadId);
  if (!existing) return;
  mutate(leadId, (r) => {
    const base = Array.isArray(r.transcript) ? r.transcript : [];
    const seen = new Set(base.map((x) => `${x.role}:${x.text}`));
    for (const t of turns) {
      const sig = `${t.role}:${t.text}`;
      if (!seen.has(sig)) base.push(t);
    }
    r.transcript = base.slice(-50);
  });
}

export function captureLead(
  id: string,
  contact: { wechat?: string; phone?: string; name?: string }
): void {
  mutate(id, (r) => {
    r.wechat = contact.wechat ?? r.wechat;
    r.phone = contact.phone ?? r.phone;
    r.name = contact.name ?? r.name;
    if (r.stage === 'new' || r.stage === 'contacted' || r.stage === 'qualified') r.stage = 'captured';
  });
}

export function bookLead(
  id: string,
  booking: { clinic: string; date: string; time: string }
): void {
  mutate(id, (r) => {
    r.clinic = booking.clinic;
    r.bookingDate = booking.date;
    r.bookingTime = booking.time;
    if (r.stage !== 'arrived' && r.stage !== 'deal') r.stage = 'booked';
  });
}

export function handoffLead(id: string, reason?: string): void {
  mutate(id, (r) => {
    r.handedOff = true;
    // 转人工 = 到店交给咨询师接待：若尚未到店，则至少推进到 arrived；deal/lost 不回退。
    if (r.stage !== 'lost' && r.stage !== 'deal' && rank(r.stage) < rank('arrived')) {
      r.stage = 'arrived';
    }
    if (reason) r.source = r.source ? `${r.source} | handoff:${reason}` : `handoff:${reason}`;
  });
}

export function assignLead(id: string, consultant: string): boolean {
  let ok = false;
  mutate(id, (r) => {
    if (r.handedOff && !r.consultedBy) {
      r.consultedBy = consultant || 'anonymous';
      ok = true;
    }
  });
  return ok;
}

// ---------------------------------------------------------------------------
// 读取 / 聚合（看板消费）
// ---------------------------------------------------------------------------

export function listLeads(): LeadRecord[] {
  try {
    return readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readRecord(f.slice(0, -'.json'.length)))
      .filter((r): r is LeadRecord => r !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function fullStats(): LeadStats {
  const recs = listLeads();
  const funnel = Object.fromEntries(
    (['new', 'contacted', 'qualified', 'captured', 'booked', 'arrived', 'deal', 'lost'] as LeadStage[]).map(
      (s) => [s, 0]
    )
  ) as Record<LeadStage, number>;
  const channelDist: Record<string, number> = {};
  const gradeDist: Record<string, number> = {};

  for (const r of recs) {
    if (r.stage === 'lost') {
      funnel.lost += 1;
      continue;
    }
    // 累计漏斗：当前阶段之前的每一级都 +1
    const rv = rank(r.reached ?? r.stage);
    for (let i = 0; i <= rv; i++) funnel[ORDER[i]] += 1;
    channelDist[r.channel] = (channelDist[r.channel] ?? 0) + 1;
    if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade] ?? 0) + 1;
  }

  const arrived = funnel.arrived; // 累计，已含 deal
  const deal = funnel.deal;
  const base = recs.length;
  return {
    total: base,
    funnel,
    channelDist,
    gradeDist,
    arrived,
    deal,
    arriveRate: base ? Math.round((arrived / base) * 100) : 0,
    dealRate: base ? Math.round((deal / base) * 100) : 0,
    followupQueue: recs.filter((r) => (r.grade === 'C' || r.stage === 'lost') && !r.handedOff),
    handoffQueue: recs.filter((r) => r.handedOff && !r.consultedBy),
  };
}

export function clearLeads(): void {
  try {
    for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        unlinkSync(join(DATA_DIR, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  // 一并清空对话记录（transcripts/ 子目录），保证演示数据彻底重置。
  try {
    for (const f of readdirSync(TRANSCRIPT_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        unlinkSync(join(TRANSCRIPT_DIR, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
