// 全局策略入口与引擎类化封装（P1 类化 / P1#21 拆分）。
//
// 背景：此前策略是模块级单例（configureGuardrails 全局可变），一个租户收紧会
// 波及全部租户。类化后每个租户可持有独立引擎实例（见 guardrails-tenant.ts 的
// 租户注册表），全局默认行为经 defaultEngine 保持完全向后兼容。
// 注意：自定义规则 / 打分器 / PII 脱敏器仍是模块级注册表（插件全局注册 + scope
// 收窄是设计约定，非租户私有状态）。
import type { GuardrailOutputContext, GuardrailPolicy, GuardrailResult } from './types';
import {
  checkInput,
  checkOutput,
  checkStructuredOutput,
  checkTaskOutput,
  checkToolArgs,
  checkToolArgsAsync,
} from './checks';
import { redactOutput } from './pii';
import { getModulePolicy, resolveDefaultPolicy, setModulePolicy } from './policy';

export { resolveDefaultPolicy } from './policy';

/**
 * 运行时调整护栏策略（例如按租户级别收紧 / 放松）。作用域：全局默认引擎。
 * 同时更新模块级 policy 与 defaultGuardrailsEngine（两处唯一写入口，保持同步）。
 * per-tenant 配置请走 guardrails-tenant.ts 的 getGuardrailsForTenant（互不影响）。
 */
export function configureGuardrails(p: Partial<GuardrailPolicy>): void {
  setModulePolicy({ ...getModulePolicy(), ...p });
  defaultGuardrailsEngine.configure(p);
}

/** 读取当前策略（只读），供 UI / 调试展示。 */
export function getGuardrailPolicy(): Readonly<GuardrailPolicy> {
  return getModulePolicy();
}

export class GuardrailsEngine {
  private pol: GuardrailPolicy;

  constructor(policy: GuardrailPolicy) {
    this.pol = { ...policy };
  }

  /** 只读策略快照。 */
  get policy(): Readonly<GuardrailPolicy> {
    return this.pol;
  }

  /** 运行时调整本引擎策略（合并语义与全局 configureGuardrails 一致）。 */
  configure(p: Partial<GuardrailPolicy>): void {
    this.pol = { ...this.pol, ...p };
  }

  checkInput(text: string, strongOnly = false, isPlanTask = strongOnly): GuardrailResult {
    return checkInput(text, this.pol, strongOnly, isPlanTask);
  }

  checkOutput(text: string, ctx?: GuardrailOutputContext): GuardrailResult {
    return checkOutput(text, this.pol, ctx);
  }

  checkStructuredOutput(text: string): GuardrailResult {
    return checkStructuredOutput(text, this.pol);
  }

  checkTaskOutput(text: string): GuardrailResult {
    return checkTaskOutput(text, this.pol);
  }

  checkToolArgs(name: string, args: Record<string, unknown>): GuardrailResult {
    return checkToolArgs(name, args, this.pol);
  }

  async checkToolArgsAsync(name: string, args: Record<string, unknown>): Promise<GuardrailResult> {
    return checkToolArgsAsync(name, args, this.pol);
  }

  redactOutput(text: string): string {
    return redactOutput(text, this.pol);
  }
}

/** 全局默认引擎：configureGuardrails / getGuardrailPolicy / 未显式传策略的调用方都落到它。 */
export const defaultGuardrailsEngine = new GuardrailsEngine(resolveDefaultPolicy());
