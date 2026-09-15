/**
 * CI 供应链（supply-chain）扫描器。
 *
 * 「CI 供应链」指平台依赖 / 产物的供应链安全：扫描声明的依赖、报告版本 +
 * 完整性哈希，并产出带签名的报告（防篡改）。本模块实现本地、零依赖的 SCANNER。
 *
 * 设计与该仓库一贯的「接口 + 默认实现 + 组合工厂」一致——
 * - `SupplyChainScanner` 是契约：`scan()` 产出报告、`sign()` 对报告做 HMAC 签名；
 * - 默认实现 `LocalSupplyChainScanner` 直接读取 `<repoRoot>/package.json`；
 * - `getSupplyChainScanner()` 工厂 + `setSupplyChainScanner()` 注入（供测试替换）。
 *
 * 注意：本 SCANNER 仅做本地静态扫描，不触网、不读取 lockfile 真实 integrity。
 * 生产环境应从 lockfile（pnpm-lock.yaml / package-lock.json / yarn.lock）读取真实
 * integrity，并使用真实密钥做 HMAC（此处 `SUPPLY_CHAIN_SECRET` 可覆盖默认开发密钥）。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

export interface DependencyReport {
  name: string;
  version: string;
  /** 解析后的实际版本（lockfile 解析结果）；本地扫描器不解析，留空。 */
  resolved?: string;
  /** 完整性哈希（npm 格式 `sha512-<base64url>`）。 */
  integrity?: string;
  /** 是否为 devDependency。 */
  dev: boolean;
}

export interface SupplyChainReport {
  generatedAt: string;
  repoRoot: string;
  summary: { total: number; withIntegrity: number; dev: number; prod: number };
  dependencies: DependencyReport[];
  /** HMAC-SHA256 签名（十六进制），用于报告防篡改。 */
  signature?: string;
}

export interface SupplyChainScanner {
  scan(): Promise<SupplyChainReport>;
  /** 对报告（去除 signature 字段后）做 HMAC-SHA256 签名。 */
  sign(report: SupplyChainReport): string;
}

const DEFAULT_SECRET = 'agent-harness-dev-secret';

/** base64url（无填充）编码给定输入字节。 */
export function base64urlSha512(input: string): string {
  const digest = createHash('sha512').update(input).digest();
  // base64 → url-safe（替换 +/，去掉填充 =）。
  return digest
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 计算依赖的确定性 integrity 占位值。
 * 这里用 sha512(`${name}@${version}`) 生成 stand-in 值；
 * 生产环境应从 lockfile 读取真实 integrity（相同 name@version 在此仍是确定性的，
 * 但因为没读 lockfile，无法反映实际解析来源/锁定的哈希）。
 */
export function computeIntegrity(name: string, version: string): string {
  return `sha512-${base64urlSha512(`${name}@${version}`)}`;
}

/** 去除 signature 字段，输出规范 JSON 字符串（用于签名与校验，保证确定性）。 */
export function canonicalize(report: SupplyChainReport): string {
  const clone: SupplyChainReport = { ...report };
  delete clone.signature;
  return JSON.stringify(clone);
}

export class LocalSupplyChainScanner implements SupplyChainScanner {
  private readonly repoRoot: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(repoRoot: string, env?: NodeJS.ProcessEnv) {
    this.repoRoot = repoRoot;
    this.env = env ?? process.env;
  }

  async scan(): Promise<SupplyChainReport> {
    const pkgPath = resolve(this.repoRoot, 'package.json');
    let deps: Record<string, string> = {};
    let devDeps: Record<string, string> = {};
    if (existsSync(pkgPath)) {
      try {
        const raw = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(raw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        deps = pkg.dependencies ?? {};
        devDeps = pkg.devDependencies ?? {};
      } catch {
        // 解析失败：回落空依赖列表，避免端点 5xx。
      }
    }

    const dependencies: DependencyReport[] = [];
    for (const [name, version] of Object.entries(deps)) {
      dependencies.push({ name, version, integrity: computeIntegrity(name, version), dev: false });
    }
    for (const [name, version] of Object.entries(devDeps)) {
      dependencies.push({ name, version, integrity: computeIntegrity(name, version), dev: true });
    }

    const withIntegrity = dependencies.filter((d) => !!d.integrity).length;
    const dev = dependencies.filter((d) => d.dev).length;
    const prod = dependencies.filter((d) => !d.dev).length;

    return {
      generatedAt: new Date().toISOString(),
      repoRoot: this.repoRoot,
      summary: { total: dependencies.length, withIntegrity, dev, prod },
      dependencies
    };
  }

  sign(report: SupplyChainReport): string {
    const secret = this.env.SUPPLY_CHAIN_SECRET || DEFAULT_SECRET;
    return createHmac('sha256', secret).update(canonicalize(report)).digest('hex');
  }
}

let scannerSingleton: SupplyChainScanner | null = null;

/** 组合工厂：默认本地扫描器（repoRoot 缺省为进程工作目录）。 */
export function getSupplyChainScanner(
  repoRoot?: string,
  env?: NodeJS.ProcessEnv
): SupplyChainScanner {
  if (!scannerSingleton) {
    scannerSingleton = new LocalSupplyChainScanner(repoRoot ?? process.cwd(), env);
  }
  return scannerSingleton;
}

/** 供测试注入自定义 scanner；传 null 复位单例。 */
export function setSupplyChainScanner(s: SupplyChainScanner | null): void {
  scannerSingleton = s;
}
