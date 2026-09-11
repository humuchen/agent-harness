/**
 * IM 适配器工厂：从环境变量装配「已配置且启用」的平台清单。
 *
 * 设计：与仓库既有「接口 + 默认实现 + 组合工厂」范式一致——要新增平台或替换
 * 某个平台的实现，只需改本工厂，桥接主体（bridge.ts）与 server 路由零改动。
 *
 * 启用规则：
 * - `IM_ENABLED=true` 为总开关；未开启时返回空清单（桥接整体 no-op）。
 * - `IM_PROVIDERS` 显式指定平台（逗号分隔）；未配置时自动探测「凭据齐全」的平台。
 * - 任一平台凭据不全 → 跳过并记入 `skipped`（启动期告警），绝不半配置启动。
 */

import { structLog } from '@agent-harness/core';
import type { ImAdapter, ImBridgeConfig, ImProvider } from './types';
import { FeishuAdapter } from './adapter-feishu';
import { DingtalkAdapter } from './adapter-dingtalk';
import { WecomAdapter } from './adapter-wecom';

const ALL_PROVIDERS: ImProvider[] = ['feishu', 'dingtalk', 'wecom'];

/** 装配结果：可用适配器 + 被跳过项（供启动期日志/健康端点展示）。 */
export interface ImRegistryResult {
  config: ImBridgeConfig;
  /** 已启用的平台标识。 */
  enabled: ImProvider[];
  /** 被跳过的平台及原因（未启用 / 缺配置）。 */
  skipped: Array<{ provider: ImProvider; reason: string }>;
}

/** 构造单个平台的适配器（凭据来自传入 env；未配置返回空串，由 isConfigured 判定）。 */
function buildAdapter(provider: ImProvider, env: NodeJS.ProcessEnv): ImAdapter {
  switch (provider) {
    case 'feishu':
      return new FeishuAdapter({
        appId: env.IM_FEISHU_APP_ID ?? '',
        appSecret: env.IM_FEISHU_APP_SECRET ?? '',
        verificationToken: env.IM_FEISHU_VERIFICATION_TOKEN ?? '',
        encryptKey: env.IM_FEISHU_ENCRYPT_KEY || undefined,
        botOpenId: env.IM_FEISHU_BOT_OPEN_ID || undefined
      });
    case 'dingtalk':
      return new DingtalkAdapter({
        clientId: env.IM_DINGTALK_CLIENT_ID ?? '',
        clientSecret: env.IM_DINGTALK_CLIENT_SECRET ?? '',
        robotCode: env.IM_DINGTALK_ROBOT_CODE || undefined
      });
    case 'wecom':
      return new WecomAdapter({
        corpId: env.IM_WECOM_CORP_ID ?? '',
        agentId: env.IM_WECOM_AGENT_ID ?? '',
        secret: env.IM_WECOM_SECRET ?? '',
        token: env.IM_WECOM_TOKEN ?? '',
        aesKey: env.IM_WECOM_AES_KEY ?? ''
      });
  }
}

/**
 * 按环境变量装配 IM 桥接配置。
 * @param env 可注入（便于单测），默认取 process.env。
 */
export function createImRegistry(
  env: NodeJS.ProcessEnv = process.env
): ImRegistryResult {
  const skipped: Array<{ provider: ImProvider; reason: string }> = [];
  const enabledFlag = ['1', 'true', 'on', 'yes'].includes(
    String(env.IM_ENABLED ?? '').toLowerCase()
  );

  const defaultConfig: ImBridgeConfig = {
    adapters: [],
    defaultMode: normalizeMode(env.IM_DEFAULT_MODE),
    maxSteps: toPositiveInt(env.IM_MAX_STEPS, 24),
    timeoutMs: toPositiveInt(env.IM_TIMEOUT_MS, 180_000),
    replyPrefix: env.IM_REPLY_PREFIX ?? '',
    groupRequireMention: env.IM_GROUP_REQUIRE_MENTION !== 'false'
  };

  if (!enabledFlag) {
    return { config: defaultConfig, enabled: [], skipped };
  }

  // 显式清单优先；否则自动探测。
  const explicit = String(env.IM_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as ImProvider[];
  const candidates = explicit.length ? explicit : ALL_PROVIDERS;

  const adapters: ImAdapter[] = [];
  const enabled: ImProvider[] = [];
  for (const p of candidates) {
    if (!ALL_PROVIDERS.includes(p)) {
      skipped.push({ provider: p, reason: 'unknown provider' });
      continue;
    }
    const adapter = buildAdapter(p, env);
    if (!adapter.isConfigured()) {
      // 显式指定却缺配置 → 明确告警；自动探测时属正常跳过。
      if (explicit.length) {
        skipped.push({ provider: p, reason: `missing config: ${adapter.missingConfig().join(', ')}` });
      }
      continue;
    }
    adapters.push(adapter);
    enabled.push(p);
  }

  return {
    config: { ...defaultConfig, adapters },
    enabled,
    skipped
  };
}

/** 启动期日志：把启用/跳过情况结构化输出，便于运维定位「配了但不生效」。 */
export function logImRegistry(result: ImRegistryResult): void {
  if (result.enabled.length) {
    structLog('info', 'im.bridge.enabled', { providers: result.enabled });
  }
  for (const s of result.skipped) {
    structLog('warn', 'im.bridge.skipped', { provider: s.provider, reason: s.reason });
  }
}

function normalizeMode(raw: string | undefined): 'mock' | 'real' | 'real-mcp' {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'mock' || v === 'real' || v === 'real-mcp') return v;
  return 'real';
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
