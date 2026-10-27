// 护栏命中审计 sink（长期：命中留痕 → 人审闭环的基础设施）。P1#21 拆分自 guardrails.ts。
// 纯回调透传：core 不落库、不做业务判定；fire-and-forget，单 sink 异常不影响判定路径。
// 消费方（领域库/插件）据此把命中落审计表、进人审队列。
import type { GuardrailAuditSink, GuardrailRuleHit } from './types';

const guardrailAuditSinks = new Set<GuardrailAuditSink>();

/** 注册护栏命中审计 sink，返回注销函数。 */
export function registerGuardrailAuditSink(fn: GuardrailAuditSink): () => void {
  guardrailAuditSinks.add(fn);
  return () => {
    guardrailAuditSinks.delete(fn);
  };
}

/** 提取命中片段并广播（内部使用；/g 正则的 lastIndex 复位防跨请求漏配）。 */
export function emitRuleHit(
  side: 'input' | 'output',
  scope: string | undefined,
  re: RegExp,
  target: string,
  reason: string,
): void {
  if (guardrailAuditSinks.size === 0) return;
  const m = re.exec(target);
  const matched = m?.[0] ?? '';
  if (re.lastIndex !== 0) re.lastIndex = 0;
  const hit: GuardrailRuleHit = {
    side,
    ...(scope ? { scope } : {}),
    matched: matched.slice(0, 200),
    reason,
    hitAt: Date.now(),
  };
  for (const fn of [...guardrailAuditSinks]) {
    try {
      fn(hit);
    } catch {
      /* 单 sink 异常不影响判定 */
    }
  }
}

/** 审计 sink 数量（checks.ts 判定「有 sink 才 emit」用，避免无谓的 exec）。 */
export function hasAuditSinks(): boolean {
  return guardrailAuditSinks.size > 0;
}
