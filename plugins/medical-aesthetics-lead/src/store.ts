/**
 * 客资生命周期共享存储（文件后端，复刻 customer-service 的原子写 + 扫目录聚合模式）。
 * 目录优先级：CS_DATA_DIR > MEMORY_DIR/plugins/medical-aesthetics-lead > ./data/cs（单实例降级）。
 * 多副本共享同一 RWX 卷时，任意副本写入的 lead 都能被看板聚合看到。
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

export interface LeadRecord {
  leadId: string;
  channel: string; // 抖音/小红书/微信/美团/官网
  source?: string;
  project?: string;
  budget?: string;
  city?: string;
  grade?: LeadGrade;
  stage: LeadStage;
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

function safeFile(key: string): string {
  const cleaned = String(key ?? 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return join(DATA_DIR, `${cleaned || 'anonymous'}.json`);
}

function readRecord(key: string): LeadRecord | null {
  try {
    const d = JSON.parse(readFileSync(safeFile(key), 'utf-8')) as Partial<LeadRecord>;
    return {
      leadId: key,
      channel: d.channel ?? 'unknown',
      source: d.source,
      project: d.project,
      budget: d.budget,
      city: d.city,
      grade: d.grade,
      stage: d.stage ?? 'new',
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
    r.stage = r.stage === 'lost' ? 'lost' : 'arrived';
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

const STAGES: LeadStage[] = [
  'new',
  'contacted',
  'qualified',
  'captured',
  'booked',
  'arrived',
  'deal',
  'lost',
];

export function fullStats(): LeadStats {
  const recs = listLeads();
  const funnel = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<LeadStage, number>;
  const channelDist: Record<string, number> = {};
  const gradeDist: Record<string, number> = {};
  for (const r of recs) {
    funnel[r.stage] = (funnel[r.stage] ?? 0) + 1;
    channelDist[r.channel] = (channelDist[r.channel] ?? 0) + 1;
    if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade] ?? 0) + 1;
  }
  const arrived = funnel.arrived + funnel.deal; // 到店（含已成交）
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
    followupQueue: recs.filter(
      (r) => (r.grade === 'C' || r.stage === 'lost') && !r.handedOff
    ),
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
}
