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

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'info';

/** 一条审计记录。全字段可 JSON 序列化。 */
export interface AuditEvent {
  /** 事件时间（ISO 字符串，缺省由实现填充）。 */
  ts?: string;
  /** 租户维度（合规审计的核心维度；空 / anonymous 表示未分租户）。 */
  tenantId?: string | null;
  /** 操作者身份（如认证后的 userId / apiKey id；未认证为 'anonymous'）。 */
  actor?: string;
  /** 动作名（如 'agent.run.start' / 'agent.run.end' / 'quota.denied' / 'a2a.send'）。 */
  action: string;
  /** 结果。 */
  outcome: AuditOutcome;
  /** 作用对象（如 agentId / jobId / pluginId）。 */
  target?: string;
  /** 任意补充上下文（不得含密钥；调用方负责脱敏）。 */
  detail?: Record<string, unknown>;
}

type AuditSink = (e: AuditEvent) => void | Promise<void>;
let auditSink: AuditSink | null = null;
let auditLogFile: string | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auditFileHandle: any = null;

/** 打开审计日志文件（append 模式）。失败不阻断启动，仅告警。 */
async function openAuditFile(file: string): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    const dir = require('node:path').dirname(file);
    await fs.mkdir(dir, { recursive: true });
    auditFileHandle = await fs.open(file, 'a');
    structLogAudit('info', 'audit file opened', { file });
  } catch (e: unknown) {
    structLogAudit('warn', 'audit file open failed', { file, error: e instanceof Error ? e.message : String(e) });
  }
}

/** 注册审计接收器（如独立审计库 / SIEM）。传 null 关闭（默认关闭，仅留结构化日志）。 */
export function setAuditSink(sink: AuditSink | null): void {
  auditSink = sink;
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
  if (file) await openAuditFile(file);
}

/**
 * 写入一条审计记录：始终留一条结构化日志（级别按 outcome 映射），若已注册 sink 则异步转发。
 * sink 抛错只记 warn，不向上传播。
 * 同时写入已配置的审计日志文件（enableAuditFile）。
 */
export async function audit(e: AuditEvent): Promise<void> {
  const entry: AuditEvent = { ts: new Date().toISOString(), ...e };
  const level = e.outcome === 'failure' || e.outcome === 'denied' ? 'warn' : 'info';
  structLogAudit(level, `[audit] ${e.action}: ${e.outcome}`, { ...entry });
  // 落盘审计日志文件（无句柄时静默跳过）。
  if (auditFileHandle) {
    try {
      await auditFileHandle.write(JSON.stringify(entry) + '\n');
    } catch { /* ignore write errors */ }
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
function structLogAudit(level: 'info' | 'warn', message: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields });
  if (level === 'warn') console.warn(line);
  else console.log(line);
}
