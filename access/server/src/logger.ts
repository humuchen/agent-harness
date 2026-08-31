/**
 * 接入层结构化日志封装。
 *
 * 统一收口 server 的运维日志（启动横幅、降级告警、自检结论），底层复用
 * core 的 structLog（JSON 行 + 级别 + 字段，可被 Loki/Filebeat 采集）。
 * 目的：
 *  - 消除散落的 console.log/console.warn 风格不一致问题，全部经统一入口；
 *  - 关键「安全降级 / 配置错配」以 warn/error 级别 + 结构化字段输出，便于告警；
 *  - 启动横幅用纯 info，不污染结构化字段（人类可读即可）。
 */
import { structLog, type LogLevel } from '@agent-harness/core';

export type Logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

function make(level: LogLevel) {
  return (msg: string, fields?: Record<string, unknown>) => structLog(level, msg, fields);
}

export const log: Logger = {
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error')
};

/**
 * 启动横幅：仅对人类可读的控制台输出，不进入结构化日志字段。
 * 关键安全/配置结论（如沙箱降级、多副本自检）应改用 log.warn/log.error 输出，
 * 以便被采集与告警。
 */
export function banner(line: string): void {
  console.log(line);
}
