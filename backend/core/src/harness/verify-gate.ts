/**
 * 运行期自动验证门禁（P0-2，P1-2：从 harness.ts 拆出）。
 *
 * 职责：产出最终答案后自动校验；未通过时按配置自愈重试或标记失败。
 *   - 每次校验经 buildCtx 构造 VerifyContext（由调用方闭包提供最新 final）；
 *   - 未通过且仍有重试额度时：注入自检提示重跑 runLoop（self-correction）；
 *   - P4.8 重试预算守卫：剩余时间不足以再跑一轮时不重试，保留第一轮产出；
 *   - 仍失败时：软性未通过只告警不改写产出（P4.7）；硬性未通过加
 *     [verify:failed] 前缀。
 *
 * final 同步约定（关键）：调用方的 buildCtx 闭包捕获调用方作用域的 final 变量。
 * 本函数内每次更新 final（重跑 runLoop / 失败标记）都必须同步调用 onFinalUpdate
 * 把新值写回调用方作用域，否则下一次 verify(buildCtx()) 会读到过期 final，
 * 与拆分前「单变量闭包」语义不一致。
 *
 * 事件与副作用顺序与拆分前逐字一致：verify:result 发射点、自检提示注入点、
 * runLoop 重跑点、warn 告警点全部保持原位。
 */
import type { VerifyContext, Verifier } from '../verify';
import type { Memory } from '../memory';
import { logError } from '../telemetry';
import { ERROR_PREFIX, VERIFY_FAILED_PREFIX } from '../workflow/step-output';
import type { HarnessEvent } from './types';

type Emit = (e: HarnessEvent) => void;

export interface VerifyGateParams {
  /** 验证器（调用方已判空：仅当 opts.verify 存在且未中止时进入本门禁）。 */
  verify: Verifier;
  /** 最大自动重试次数。 */
  verifyMaxRetries: number;
  /** 是否注入自检提示重跑。 */
  verifySelfCorrect: boolean;
  /** 构造验证上下文（闭包读取调用方作用域的最新 final/steps/统计）。 */
  buildCtx: () => VerifyContext;
  /** 主循环（重跑复用同一 maxSteps 预算）。 */
  runLoop: () => Promise<string>;
  /** 绝对截止时间（ms；Infinity 表示不限时）。 */
  deadlineAt: number;
  /** run 总超时毫秒（0 = 不限时）。 */
  runTimeoutMs: number;
  emit: Emit;
  /** 记忆实例（自检提示注入）。 */
  memory: Memory;
  /** run 标识（重跑失败时的错误日志上下文）。 */
  runId: string;
  /** 进入门禁时的当前产出（首轮 runLoop 结果）。 */
  initialFinal: string;
  /** final 更新回调：本函数内每次变更 final 都同步写回调用方作用域。 */
  onFinalUpdate: (nextFinal: string) => void;
}

/**
 * 执行验证门禁（含自愈重试与失败标记），返回最终产出。
 * 调用方以 `final = await runVerifyGate({...})` 写回。
 */
export async function runVerifyGate(p: VerifyGateParams): Promise<string> {
  let final = p.initialFinal;
  const { verify, emit, memory } = p;
  let attempt = 0;
  let outcome = await verify(p.buildCtx());
  emit({
    type: 'verify:result',
    attempt,
    passed: outcome.passed,
    score: outcome.score,
    reasons: outcome.reasons,
    ...(outcome.soft ? { soft: true } : {})
  });
  while (!outcome.passed && attempt < p.verifyMaxRetries) {
    attempt += 1;
    if (p.verifySelfCorrect) {
      // P4.8 重试预算守卫：剩余时间不足以跑完一轮时不再重试。
      // 此前无条件重跑：第一轮已耗尽大半预算时，第二轮的硬超时会把**第一轮已经
      // 产出的完整内容整个覆盖**成超时提示 —— 用户等到超时后什么也拿不到。
      // 宁可保留第一轮产出（可能只是验收词未逐字命中），也不做毁灭性的重试。
      const remainMs = Number.isFinite(p.deadlineAt)
        ? p.deadlineAt - Date.now()
        : Infinity;

      // 重试所需的最低剩余预算：缺省 60s，并收敛到总预算的 1/4 以内（与软截止同款
      // 口径）—— 否则「总预算 60s」时任何重试都会被判为「剩余不足」而永不执行。
      const minRetryCfg = Math.max(
        0,
        Number(process.env.AGENT_VERIFY_MIN_RETRY_MS ?? 60_000) || 0
      );
      const minRetryMs =
        p.runTimeoutMs > 0
          ? Math.min(minRetryCfg, Math.floor(p.runTimeoutMs / 4))
          : minRetryCfg;
      if (remainMs <= minRetryMs) {
        emit({
          type: 'warn',
          message: `剩余时间不足（${
            Number.isFinite(remainMs)
              ? Math.max(0, Math.round(remainMs / 1000))
              : '∞'
          }s），跳过自检重试并保留当前产出`
        });
        break;
      }

      // 注入自检提示，让模型根据失败原因修正后重新跑一轮（自动重试 / 自愈）。
      // 软性未通过同样重试一次（定向补齐成本低、收益明确），只是重试后仍不通过时不阻断。
      memory.add({
        role: 'user',
        content:
          '（系统提示）上一轮运行未通过自动验证：' +
          outcome.reasons.join('；') +
          '。请审视并修正你的回答与步骤，然后重新给出最终结果。'
      });
      try {
        final = await p.runLoop();
        p.onFinalUpdate(final);
      } catch (e) {
        logError('agent.run.retry', e, { runId: p.runId });
        final = `${ERROR_PREFIX} ${e instanceof Error ? e.message : String(e)}`;
        p.onFinalUpdate(final);
      }
      outcome = await verify(p.buildCtx());
      emit({
        type: 'verify:result',
        attempt,
        passed: outcome.passed,
        score: outcome.score,
        reasons: outcome.reasons,
        ...(outcome.soft ? { soft: true } : {})
      });
    } else {
      break;
    }
  }
  if (!outcome.passed) {
    if (outcome.soft) {
      // P4.7 软性未通过：只告警、不改写产出。
      // 症状背景：计划模式逐 task 的验收关键词断言是「planner 调用 A 出词 → executor 调用 B
      // 的产出逐字包含」的跨调用匹配，同义改写即未命中；此前会追加 [verify:failed] 前缀，
      // 被引擎出口闸门判为无效产出 → step failed → 整个 run 失败（而单步对话无此门禁，故正常）。
      // 现在保留模型原始产出，让内容正常交付、下游正常消费，验收缺口由 verify:result 事件
      // （soft=true）与调用链路抽屉呈现，不再牺牲整个 run。
      emit({
        type: 'warn',
        message: `验收告警（不影响产出）：${outcome.reasons.join('；')}`
      });
    } else {
      final = `${VERIFY_FAILED_PREFIX} ${outcome.reasons.join(
        '; '
      )}\n\n${final}`;
      p.onFinalUpdate(final);
    }
  }
  return final;
}
