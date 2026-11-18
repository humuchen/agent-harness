import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 最小化的零依赖 .env 加载器（兼容 CommonJS）。
 *
 * 从 `file`（默认为项目根目录下的 `.env`）读取 KEY=VALUE 格式的行，
 * 并填充到 `process.env` 中——但仅填充尚未设置的键，因此显式设置的
 * 环境变量（如 `export OPEN_API_KEY=...`）始终优先。文件不存在时不执行任何操作。
 *
 * 将真实密钥保存在 `.env` 文件中（已添加到 gitignore）；`.env.example` 仅作为模板。
 *
 * @param file - .env 文件路径（相对于当前工作目录），默认为 '.env'
 * @returns void - 直接修改 process.env 对象，无返回值
 */
export function loadEnv(file = '.env'): void {
  let txt: string;
  try {
    txt = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return; // no .env present — nothing to do
  }
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// ── 类型化 env 读取辅助（P1-6 配置集中化：core 侧）──────────────────────────
//
// 背景：全代码库有 20+ 处 `Number(process.env.X ?? d) || d` 模式。该模式对 0 值
// 有 falsy 陷阱——`Number("0") || d` = `0 || d` = d，导致 AUDIT_LOG_MAX_BYTES=0
// （禁用轮转）、ALERT_DEDUP_WINDOW_MS=0（禁用去重）等合法 0 值被静默覆盖为默认值。
// envNum 用 Number.isFinite 守卫替代 `|| d`，正确处理 0 为合法值。
//
// 与 access/server 的 cfgNum 同语义但独立实现（core 不能 import server 方向）。
// 后续 core 内新增的数值 env 读取应统一经 envNum，存量 `|| d` 模式按需逐步迁移。

/**
 * 读取数值 env：未设/空 → fallback；非法（NaN/Infinity）→ fallback；
 * **0 视为合法值**（不因 falsy 被覆盖）。
 */
export function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 读取字符串 env：未设/空 → fallback。
 * 与 `process.env.X || fallback` 的差异：空字符串 `''` 也回落（而非透传）。
 */
export function envStr(key: string, fallback = ''): string {
  const v = process.env[key];
  return v != null && v !== '' ? v : fallback;
}

/**
 * 读取布尔 env：true/1/on → true；其余 → false；未设 → fallback。
 */
export function envBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return ['true', '1', 'on'].includes(v.trim().toLowerCase());
}
