import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 最小化的零依赖 .env 加载器（兼容 CommonJS）。
 *
 * 从 `file`（默认为项目根目录下的 `.env`）读取 KEY=VALUE 格式的行，
 * 并填充到 `process.env` 中——但仅填充尚未设置的键，因此显式设置的
 * 环境变量（如 `export OPENROUTER_API_KEY=...`）始终优先。文件不存在时不执行任何操作。
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
