/**
 * 品牌位配置（P3-1）。
 *
 * 将「平台名称 / Logo / 主题色 / 登录页标语 / 页脚」从业务代码中解耦出来，
 * 支持企业白标（white-label）。
 *
 * 来源优先级：
 *   1. 运行时 GET /api/brand（来自 .data/brand.json 或 BRAND_* 环境变量）
 *   2. 编译默认 (BRAND_DEFAULT)
 *
 * 架构遵循「接口 + 默认实现 + 组合工厂」范式。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 品牌清单。 */
export interface BrandConfig {
  /** 产品名称（页面标题、sidebar 标题）。 */
  productName: string;
  /** Logo URL（必须同源或白名单域名）。 */
  logoUrl?: string;
  /** Favicon URL（必须同源或白名单域名）。 */
  faviconUrl?: string;
  /** 主题色（CSS 变量 --ah-accent）。 */
  primaryColor?: string;
  /** 登录页标语。 */
  loginTagline?: string;
  /** 页脚文案。 */
  footer?: string;
}

/** 编译默认值。 */
export const BRAND_DEFAULT: BrandConfig = {
  productName: 'Agent Harness',
  primaryColor: '#2997FF',
  loginTagline: '编排、运行、观测 — 你的每一个 AI Agent',
  footer: 'Agent Harness 2026 · 私有化部署就绪'
};

/** Logo/Favicon 安全白名单：同源或显式列出的域名。 */
const ALLOWED_ORIGINS: string[] = [
  '', // 同源（相对路径）
  'localhost',
  '127.0.0.1'
];

/** 环境变量白名单域名（逗号分隔）。 */
function allowedDomains(env: NodeJS.ProcessEnv): string[] {
  const raw = env.BRAND_ALLOWED_DOMAINS;
  if (!raw) return [];
  return raw.split(',').map((d) => d.trim()).filter(Boolean);
}

/** 校验 URL 是否安全（同源或白名单）。 */
export function isBrandUrlSafe(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!url) return false;
  if (url.startsWith('/')) return true; // 相对路径 → 同源
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (ALLOWED_ORIGINS.includes(host) || allowedDomains(env).includes(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/** 从环境变量解析品牌配置。 */
function fromEnv(env: NodeJS.ProcessEnv): Partial<BrandConfig> {
  const cfg: Partial<BrandConfig> = {};
  if (env.BRAND_PRODUCT_NAME) cfg.productName = env.BRAND_PRODUCT_NAME;
  if (env.BRAND_LOGO_URL) cfg.logoUrl = env.BRAND_LOGO_URL;
  if (env.BRAND_FAVICON_URL) cfg.faviconUrl = env.BRAND_FAVICON_URL;
  if (env.BRAND_PRIMARY_COLOR) cfg.primaryColor = env.BRAND_PRIMARY_COLOR;
  if (env.BRAND_LOGIN_TAGLINE) cfg.loginTagline = env.BRAND_LOGIN_TAGLINE;
  if (env.BRAND_FOOTER) cfg.footer = env.BRAND_FOOTER;
  return cfg;
}

/** 读取 .data/brand.json（若存在）。 */
function fromFile(dir: string): Partial<BrandConfig> | null {
  const file = resolve(dir, 'brand.json');
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw) as Partial<BrandConfig>;
  } catch {
    return null;
  }
}

/** 合并来源：默认 < env < file。 */
export function resolveBrand(fileCfg: Partial<BrandConfig> | null, envCfg: Partial<BrandConfig>, env: NodeJS.ProcessEnv = process.env): BrandConfig {
  const merged: BrandConfig = { ...BRAND_DEFAULT, ...envCfg, ...fileCfg };
  // 安全校验：logoUrl / faviconUrl 必须通过检查
  if (merged.logoUrl && !isBrandUrlSafe(merged.logoUrl, env)) {
    delete merged.logoUrl;
  }
  if (merged.faviconUrl && !isBrandUrlSafe(merged.faviconUrl, env)) {
    delete merged.faviconUrl;
  }
  return merged;
}

/** 组合工厂：读取文件 + 环境变量，缓存结果。 */
let singleton: BrandConfig | null = null;

/** 重置单例（供测试注入）。 */
export function setBrandConfig(cfg: BrandConfig | null): void {
  singleton = cfg;
}

/** 获取品牌配置（单例缓存）。 */
export function getBrandConfig(env: NodeJS.ProcessEnv = process.env): BrandConfig {
  if (singleton) return singleton;
  const dir = env.BRAND_STORE_DIR || '.data';
  const fileCfg = fromFile(dir);
  const envCfg = fromEnv(env);
  singleton = resolveBrand(fileCfg, envCfg, env);
  return singleton;
}

/** 写入品牌配置文件（供运维 / 管理 API 调用）。 */
export function saveBrandConfig(cfg: BrandConfig, dir: string = '.data', env: NodeJS.ProcessEnv = process.env): void {
  // 安全校验
  if (cfg.logoUrl && !isBrandUrlSafe(cfg.logoUrl, env)) {
    throw new Error('logoUrl is not in the allowed origins');
  }
  if (cfg.faviconUrl && !isBrandUrlSafe(cfg.faviconUrl, env)) {
    throw new Error('faviconUrl is not in the allowed origins');
  }
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'brand.json');
  writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8');
  singleton = cfg; // 更新缓存
}