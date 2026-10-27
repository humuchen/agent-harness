// guardrails 聚合门面：`from './guardrails'` 与 `from './guardrails/index.js'` 的导入路径
// 均解析到此处，对外导出面与拆分前完全一致（导出面快照测试锁定，见 test/guardrails-surface.test.cjs）。
//
// 模块依赖方向（无环）：
//   types ← policy/harden/egress/pii/registry/audit/detection ← checks ← engine
//   （configureGuardrails 与 defaultGuardrailsEngine 的双向引用收敛在 engine.ts 单文件内）

// 类型契约
export type {
  GuardrailResult,
  PiiRedactor,
  InjectionSensitivity,
  NetworkPolicy,
  GuardrailPolicy,
  ComplianceProfile,
  GuardrailRuleHit,
  GuardrailAuditSink,
  GuardrailOutputContext,
  ContextualOutputRule,
  InjectionScorer,
} from './types';

// 策略（默认表 / 环境变量解析 / 全局配置入口）
export { resolveDefaultPolicy, configureGuardrails, getGuardrailPolicy } from './engine';

// 出网管控 / 私网判定
export { isPrivateIp, resolveHostIsPrivate, checkEgress, checkEgressAsync } from './egress';

// 注册扩展点（自定义规则 / 语义打分器 / Jev）
export {
  registerInputRule,
  registerOutputRule,
  registerContextualOutputRule,
  registerInjectionScorer,
  enableJevInjection,
} from './registry';

// 命中审计 sink
export { registerGuardrailAuditSink } from './audit';

// 文本硬化（对抗归一化）
export { hardenText } from './harden';

// PII 脱敏
export { registerPiiRedactor, redactPII, redactOutput } from './pii';

// 对外校验接口（同步 + 异步变体）
export {
  checkInput,
  checkOutput,
  checkStructuredOutput,
  checkTaskOutput,
  checkToolArgs,
  checkInputAsync,
  checkOutputAsync,
  checkToolArgsAsync,
} from './checks';

// 引擎类与全局默认引擎
export { GuardrailsEngine, defaultGuardrailsEngine } from './engine';
