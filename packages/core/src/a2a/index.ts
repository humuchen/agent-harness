/**
 * A2A（Agent-to-Agent）统一通信协议模块（P1-④）。
 *
 * 用一份可序列化的 TaskEnvelope 桥接 MCP（工具级）与 A2A（agent 级），让异构远端
 * 行业 agent 以标准协议入驻。传输层解耦「派发」与「执行」：local 在进程内 handoff，
 * http 跨主机投递到远端 /api/a2a/tasks。
 */

export * from './types';
export * from './transport';
