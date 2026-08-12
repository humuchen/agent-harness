/**
 * 密钥外部化加载器（零依赖）。
 *
 * 设计目标：让服务在**不提交任何真实密钥**的前提下，从多种来源装配 `process.env`，
 * 使既有 `process.env.X` 读取逻辑零改动即可工作。
 *
 * 加载优先级（高 → 低，且均不会覆盖更高优先级的来源）：
 *   1. 进程启动时平台注入的 env（Render / K8s / Docker / systemd 等）—— 最高
 *   2. `SECRETS_FILE` 指向的 JSON 文件（K8s Secret 挂载、Docker secret、Render Secret Files）
 *   3. 本地 `.env`（仅开发便利，已被 .gitignore 忽略，生产不存在）
 *
 * 关键约束：
 * - 绝不覆盖平台注入的 env（避免外部密钥被本地文件意外覆盖）。
 * - 任何来源解析失败只告警、不中断启动（降级可用）。
 * - 同步执行：在 `server.ts` 模块顶部、任何 `process.env` 读取之前调用一次。
 */

import { existsSync, readFileSync } from 'node:fs';

export interface LoadSecretsOptions {
  /** 是否加载本地 `.env`（默认 true，仅开发便利）。生产无此文件即跳过。 */
  dotenv?: boolean;
}

let loaded = false;

/** 极简 `.env` 解析：支持 `KEY=VALUE`、注释(#)、空行、首尾引号剥离。不做变量插值。 */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** 解析单文件为键值对；JSON 文件按 JSON 解析，其余按 `.env` 解析。 */
function readSource(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8');
  const parsed = file.endsWith('.json') ? JSON.parse(text) : parseDotenv(text);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * 装配密钥到 `process.env`。幂等：多次调用仅首次生效。
 * 必须在读取任何密钥（如 `UI_AUTH_TOKEN`）之前调用。
 */
export function loadSecrets(opts: LoadSecretsOptions = {}): void {
  if (loaded) return;
  loaded = true;

  // 平台注入的 env 视为锁定，任何来源都不得覆盖。
  const locked = new Set(Object.keys(process.env));

  const sources: string[] = [];
  if (process.env.SECRETS_FILE) sources.push(process.env.SECRETS_FILE);
  if ((opts.dotenv ?? true) && existsSync('.env')) sources.push('.env');

  for (const file of sources) {
    try {
      const parsed = readSource(file);
      let applied = 0;
      for (const [k, v] of Object.entries(parsed)) {
        if (locked.has(k)) continue; // 不覆盖平台注入
        if (process.env[k] !== undefined) continue; // 不覆盖已应用的更高优先级来源
        process.env[k] = v;
        applied++;
      }
      console.log(`[secrets] 已从 ${file} 载入 ${applied}/${Object.keys(parsed).length} 个变量`);
    } catch (e) {
      console.warn(`[secrets] 载入 ${file} 失败（已忽略）: ${(e as Error).message}`);
    }
  }
}

/** 统一读取密钥/配置，带默认值。等价于 `process.env[name] ?? fallback`，供调用方显式取用。 */
export function getSecret(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
