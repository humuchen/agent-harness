/**
 * 审计日志（P2 生产化）。
 *
 * 为「谁（actor）/ 在哪个租户（tenantId）/ 对什么（action+target）/ 做了什么结果（outcome）」
 * 提供统一的不可变审计记录，落结构化日志并支持可插拔下沉（如写独立审计库 / 转发 SIEM）。
 * 与 telemetry 的 alert sink 平行：sink 异常被吞，绝不影响主业务流程。
 *
 * 与「合规画像（P2.c）」配合：医疗 / 金融等强合规租户应设 `auditRequired`，调用方在
 * 关键动作（run 开始 / 结束 / 越权拦截 / 配额拒绝）处调用 audit() 即满足审计留痕。
 */
import { scrubFields } from './log-scrub';

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'info';

/** 一条审计记录。全字段可 JSON 序列化。 */
export interface AuditEvent {
  /** 事件时间（ISO 字符串，缺省由实现填充）。 */
  ts?: string;
  /** 租户维度（合规审计的核心维度；空 / anonymous 表示未分租户）。 */
  tenantId?: string | null;
  /** P1：数据分区（合规审计维度，与 TenantContext.dataZone 对应）。 */
  dataZone?: string;
  /** P1：数据驻留约束（与 TenantContext.residency 对应）。 */
  residency?: string;
  /** 操作者身份（如认证后的 userId / apiKey id；未认证为 'anonymous'）。 */
  actor?: string;
  /** 动作名（如 'agent.run.start' / 'agent.run.end' / 'quota.denied' / 'a2a.send'）。 */
  action: string;
  /** 结果。 */
  outcome: AuditOutcome;
  /** 作用对象（如 agentId / jobId / pluginId）。 */
  target?: string;
  /** 任意补充上下文（纵深防御：调用方应尽量自行脱敏，出口处还会过全局 scrubber 兜底）。 */
  detail?: Record<string, unknown>;
}

type AuditSink = (e: AuditEvent) => void | Promise<void>;
let auditSink: AuditSink | null = null;
let auditLogFile: string | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auditFileHandle: any = null;
/** 当前审计文件已写字节数（轮转判定用）。 */
let auditFileBytes = 0;
/** 审计文件写失败连续计数（告警限流用，避免失败风暴刷屏）。 */
let auditWriteFailures = 0;
/** 审计文件单文件大小上限（超过轮转为 <file>.1；0=不限）。 */
const AUDIT_ROTATE_BYTES = Number(process.env.AUDIT_LOG_MAX_BYTES) || 50 * 1024 * 1024;

/** 打开审计日志文件（append 模式）。失败不阻断启动，仅告警。 */
async function openAuditFile(file: string): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    const dir = require('node:path').dirname(file);
    await fs.mkdir(dir, { recursive: true });
    // 记录当前文件大小：进程重启后 append 继续累计，保证轮转阈值语义连续。
    const stat = await fs.stat(file).catch(() => null);
    auditFileBytes = stat?.size ?? 0;
    auditFileHandle = await fs.open(file, 'a');
    structLogAudit('info', 'audit file opened', { file });
  } catch (e: unknown) {
    structLogAudit('warn', 'audit file open failed', { file, error: e instanceof Error ? e.message : String(e) });
  }
}

/** 轮转：关闭当前句柄，<file> 改名为 <file>.1（单代覆盖式），重新打开新文件。 */
async function rotateAuditFile(): Promise<void> {
  const file = auditLogFile;
  if (!file) return;
  try {
    try { await auditFileHandle?.close(); } catch { /* ignore */ }
    auditFileHandle = null;
    const fs = await import('node:fs/promises');
    await fs.rename(file, file + '.1');
    structLogAudit('info', 'audit file rotated', { file, bytes: auditFileBytes });
  } catch (e: unknown) {
    structLogAudit('warn', 'audit file rotate failed', { file, error: e instanceof Error ? e.message : String(e) });
  }
  await openAuditFile(file);
}

/** 注册审计接收器（如独立审计库 / SIEM）。传 null 关闭（默认关闭，仅留结构化日志）。 */
export function setAuditSink(sink: AuditSink | null): void {
  auditSink = sink;
}

/** 仅测试用：注入假文件句柄，模拟写失败 / 轮转路径（不走真实文件系统）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setAuditFileHandleForTest__(handle: any): void {
  auditFileHandle = handle;
  auditFileBytes = 0;
}

/**
 * 启用审计日志文件落盘（生产环境必须调用一次）。路径为空则关闭。
 * 仅支持一次初始化（幂等）；重复调用用最新路径覆盖旧文件句柄。
 */
export async function enableAuditFile(file: string | null): Promise<void> {
  if (auditFileHandle) {
    try { await auditFileHandle.close(); } catch { /* ignore */ }
    auditFileHandle = null;
  }
  auditLogFile = file;
  auditWriteFailures = 0;
  if (file) await openAuditFile(file);
}

/**
 * 写入一条审计记录：始终留一条结构化日志（级别按 outcome 映射），若已注册 sink 则异步转发。
 * sink 抛错只记 warn，不向上传播。
 * 同时写入已配置的审计日志文件（enableAuditFile）；写失败按连续失败次数限流告警
 * （首条 + 每 100 条），不再完全静默——审计丢失至少要可观测。
 */
export async function audit(e: AuditEvent): Promise<void> {
  const entry: AuditEvent = { ts: new Date().toISOString(), ...e };
  const level = e.outcome === 'failure' || e.outcome === 'denied' ? 'warn' : 'info';
  structLogAudit(level, `[audit] ${e.action}: ${e.outcome}`, { ...entry });
  // 落盘审计日志文件（无句柄时静默跳过）。超限先轮转再写。
  if (auditFileHandle) {
    const line = JSON.stringify(scrubFields({ ...entry }) as Record<string, unknown>) + '\n';
    try {
      if (AUDIT_ROTATE_BYTES > 0 && auditFileBytes + line.length > AUDIT_ROTATE_BYTES) {
        await rotateAuditFile();
      }
    } catch { /* 轮转失败不阻断写入尝试 */ }
    if (auditFileHandle) {
      try {
        await auditFileHandle.write(line);
        auditFileBytes += line.length;
        if (auditWriteFailures > 0) auditWriteFailures = 0; // 恢复后重置告警计数
      } catch (err: unknown) {
        auditWriteFailures += 1;
        if (auditWriteFailures === 1 || auditWriteFailures % 100 === 0) {
          structLogAudit('warn', 'audit file write failed', {
            file: auditLogFile,
            consecutiveFailures: auditWriteFailures,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
  }
  if (auditSink) {
    try {
      await Promise.resolve(auditSink(entry)).catch((err: unknown) => {
        structLogAudit('warn', 'audit sink failed', { error: err instanceof Error ? err.message : String(err), action: e.action });
      });
    } catch (err: unknown) {
      structLogAudit('warn', 'audit sink failed', { error: err instanceof Error ? err.message : String(err), action: e.action });
    }
  }
}

// 复用 telemetry 的结构化日志形态，但不在此处 import telemetry 以免循环依赖；
// 这里用与 telemetry.structLog 完全一致的 JSON 行格式。
// 关键修复：此前直接 console.log 绕过全局 scrubber，审计 detail 里的敏感字段
// （调用方漏脱敏时）会明文进 stdout——现在出口统一过 scrubFields 兜底。
function structLogAudit(level: 'info' | 'warn', message: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify(
    scrubFields({ ts: new Date().toISOString(), level, msg: message, ...fields }) as Record<string, unknown>
  );
  if (level === 'warn') console.warn(line);
  else console.log(line);
}
