// 运行收尾段（runInner 段 H）：持久化落盘 + 输出侧 PII 脱敏 + 计数/hook/run:end。
// P1#21 自 runInner 迁出，语句顺序与语义逐字等价。
import type { Memory } from '../../memory';
import type { GuardrailPolicy } from '../../guardrails';
import type { HarnessEvent } from '../types';
import { incCounterTenant } from '../../telemetry';
import { redactOutput } from '../../guardrails';
import { hooks } from '../../hooks';

export interface FinalizeInput {
  memory: Memory;
  runId: string;
  tenantId?: string;
  agentId?: string;
  guardrailPolicy?: GuardrailPolicy;
  /** 门禁/收尾处理后的最终产出（本函数内再做 PII 脱敏）。 */
  final: string;
  steps: number;
  /** 装配段（signal-setup）的清理函数：清超时定时器 + 解绑外部 abort。 */
  cleanup: () => void;
  emit: (e: HarnessEvent) => void;
}

/** 返回脱敏后的最终文本（调用方原样 return）。 */
export async function finalizeRun(input: FinalizeInput): Promise<string> {
  const { memory } = input;
  // 运行结束，若有持久化路径则落盘（best-effort）。
  if (memory.hasPersistence) {
    try {
      await memory.save();
    } catch {
      /* 存档失败不应影响已产出的结果 */
    }
  }
  // 输出侧 PII 脱敏：无论正常结束、超时还是异常，最终返回给用户的内容都经过打码。
  const final = redactOutput(input.final, input.guardrailPolicy);
  incCounterTenant('agent.run.end', input.tenantId);
  input.cleanup();
  // Hook: agent.post_run — normal completion
  void hooks.execute('agent.post_run', {
    runId: input.runId,
    sessionKey: input.runId,
    tenantId: input.tenantId,
    final,
    steps: input.steps,
    tokens: undefined,
    cost: undefined,
  });
  input.emit({ type: 'run:end', runId: input.runId, final, steps: input.steps, agentId: input.agentId });
  return final;
}
