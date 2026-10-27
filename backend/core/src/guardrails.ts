// 内容安全护栏（企业级可配置策略引擎）—— P1#21 拆分门面。
//
// 本文件此前承载全部护栏实现（52KB / 37 导出，策略/注入检测/PII/出网/注册扩展点/
// 审计六职责混杂，三个同步 check 结构雷同）。现按职责拆分为 guardrails/ 子模块：
//   types / policy / harden / egress / pii / registry / audit / detection / checks / engine
// 依赖方向无环；对外导出面与拆分前完全一致（本文件 re-export + index.ts 双路径等价）。
// 行为与签名零变化——checkInput / checkOutput / checkToolArgs 等签名不变。

export * from './guardrails/index';
