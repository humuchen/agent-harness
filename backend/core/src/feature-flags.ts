/**
 * 特性开关框架 - 集中管理功能开关
 *
 * 支持:
 * - 环境变量配置
 * - 运行时查询
 * - 默认值
 * - 类型安全
 *
 * 使用方式:
 *   import { features } from './feature-flags';
 *
 *   if (features.isEnabled('contextCompression')) {
 *     // 使用压缩功能
 *   }
 *
 *   // 获取所有特性
 *   const allFeatures = features.getAll();
 */

export interface FeatureFlag {
  key: string;
  description: string;
  enabled: boolean;
  defaultValue: boolean;
  envVar: string;
  category: 'performance' | 'security' | 'experimental' | 'deprecated';
}

// 特性定义
const FEATURE_FLAGS: Record<string, Omit<FeatureFlag, 'key' | 'enabled'>> = {
  // 性能相关
  contextCompression: {
    description: '上下文压缩 - 自动压缩长对话历史以减少token消耗',
    defaultValue: false,
    envVar: 'CONTEXT_COMPRESSION',
    category: 'performance'
  },

  tokenCache: {
    description: 'Token缓存 - 缓存LLM响应以减少API调用',
    defaultValue: false,
    envVar: 'TOKEN_CACHE_ENABLED',
    category: 'performance'
  },

  responseCompression: {
    description: '响应压缩 - 压缩SSE响应数据',
    defaultValue: false,
    envVar: 'RESPONSE_COMPRESSION',
    category: 'performance'
  },

  // 安全相关
  requireTenant: {
    description: '租户隔离 - 强制要求tenantId',
    defaultValue: false,
    envVar: 'REQUIRE_TENANT',
    category: 'security'
  },

  shellApproval: {
    description: 'Shell审批 - Shell命令需要人工审批',
    defaultValue: true,
    envVar: 'SHELL_APPROVAL_ENABLED',
    category: 'security'
  },

  strictPluginIsolation: {
    description: '插件隔离 - 严格隔离插件运行环境',
    defaultValue: true,
    envVar: 'STRICT_PLUGIN_ISOLATION',
    category: 'security'
  },

  // 实验性功能
  workflowEngine: {
    description: '工作流引擎 - 支持复杂业务工作流',
    defaultValue: false,
    envVar: 'WORKFLOW_ENGINE_ENABLED',
    category: 'experimental'
  },

  a2aProtocol: {
    description: 'A2A协议 - Agent到Agent通信协议',
    defaultValue: false,
    envVar: 'A2A_PROTOCOL_ENABLED',
    category: 'experimental'
  },

  pluginMarketplace: {
    description: '插件市场 - 在线安装插件',
    defaultValue: false,
    envVar: 'PLUGIN_MARKETPLACE_ENABLED',
    category: 'experimental'
  },

  // 已弃用
  legacyAuth: {
    description: '旧版认证 - 使用API Key而非JWT',
    defaultValue: false,
    envVar: 'LEGACY_AUTH',
    category: 'deprecated'
  },

  oldMemoryStore: {
    description: '旧版内存存储 - 使用文件系统而非SQLite',
    defaultValue: false,
    envVar: 'OLD_MEMORY_STORE',
    category: 'deprecated'
  }
};

// 运行时状态
let runtimeOverrides: Record<string, boolean> = {};

/**
 * 特性标志管理器
 */
export class FeatureFlagManager {
  /**
   * 检查特性是否启用
   */
  isEnabled(key: string): boolean {
    const flag = FEATURE_FLAGS[key];
    if (!flag) {
      console.warn(`[FeatureFlags] 未知特性: ${key}`);
      return false;
    }

    // 运行时覆盖
    if (key in runtimeOverrides) {
      return runtimeOverrides[key];
    }

    // 环境变量
    const envValue = process.env[flag.envVar];
    if (envValue !== undefined) {
      return envValue === 'true' || envValue === '1';
    }

    // 默认值
    return flag.defaultValue;
  }

  /**
   * 获取特性信息
   */
  getFlag(key: string): FeatureFlag | null {
    const flag = FEATURE_FLAGS[key];
    if (!flag) return null;

    return {
      ...flag,
      key,
      enabled: this.isEnabled(key)
    };
  }

  /**
   * 获取所有特性
   */
  getAll(): FeatureFlag[] {
    return Object.keys(FEATURE_FLAGS).map((key) => this.getFlag(key)!);
  }

  /**
   * 按分类获取特性
   */
  getByCategory(category: FeatureFlag['category']): FeatureFlag[] {
    return this.getAll().filter((f) => f.category === category);
  }

  /**
   * 运行时设置特性(仅本次进程有效)
   */
  setOverride(key: string, enabled: boolean): void {
    if (!FEATURE_FLAGS[key]) {
      throw new Error(`未知特性: ${key}`);
    }
    runtimeOverrides[key] = enabled;
    console.log(`[FeatureFlags] 运行时覆盖: ${key} = ${enabled}`);
  }

  /**
   * 清除运行时覆盖
   */
  clearOverride(key?: string): void {
    if (key) {
      delete runtimeOverrides[key];
    } else {
      runtimeOverrides = {};
    }
  }

  /**
   * 获取特性统计
   */
  getStats(): {
    total: number;
    enabled: number;
    disabled: number;
    byCategory: Record<string, { total: number; enabled: number }>;
  } {
    const all = this.getAll();
    const byCategory: Record<string, { total: number; enabled: number }> = {};

    for (const flag of all) {
      if (!byCategory[flag.category]) {
        byCategory[flag.category] = { total: 0, enabled: 0 };
      }
      byCategory[flag.category].total++;
      if (flag.enabled) {
        byCategory[flag.category].enabled++;
      }
    }

    return {
      total: all.length,
      enabled: all.filter((f) => f.enabled).length,
      disabled: all.filter((f) => !f.enabled).length,
      byCategory
    };
  }
}

// 导出单例
export const features = new FeatureFlagManager();

// 导出便捷函数
export function isEnabled(key: string): boolean {
  return features.isEnabled(key);
}

export function requireFeature(key: string, message?: string): void {
  if (!features.isEnabled(key)) {
    throw new Error(
      message || `特性未启用: ${key} (环境变量: ${FEATURE_FLAGS[key]?.envVar})`
    );
  }
}

export function optionalFeature(
  key: string,
  fallback: () => void = () => {}
): boolean {
  const enabled = features.isEnabled(key);
  if (!enabled) {
    fallback();
  }
  return enabled;
}
