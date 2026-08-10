import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal zero-dependency .env loader (CommonJS-safe).
 *
 * Reads KEY=VALUE lines from `file` (default `.env` at the project root) and
 * populates `process.env` — but only for keys that are not already set, so an
 * explicit `export OPENROUTER_API_KEY=...` always wins. Missing file = no-op.
 *
 * Keep real secrets in `.env` (git-ignored); `.env.example` stays a template.
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
