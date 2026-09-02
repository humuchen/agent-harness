/**
 * Harness 客户端类型（向后兼容层）。
 *
 * `EphemeralEnvInput` / `EnvHandle` 已上移到 `env-platform.types.ts`（EnvPlatform 共享契约）。
 * 这里 re-export 以兼容旧导入路径，避免破坏既有调用方。
 */
export type { EphemeralEnvInput, EnvHandle } from './env-platform.types';
