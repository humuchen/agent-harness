/**
 * 前端插件视图注册表（Phase 2 · 通用扩展点，无业务词）。
 *
 * 与 core 的 PluginUIView 契约对齐：webapp 不感知任何插件业务语义，只按
 * tabId / label / html 三段式渲染动态 Tab。视图 HTML 由服务端 /api/plugins
 * 端点返回（插件在 server 侧调用 view.render() 生成），webapp 仅注入。
 */

/** 插件视图契约（与 core PluginUIView 对齐，此处为前端自洽副本，避免强依赖 core 类型）。 */
export interface PluginUIViewContract {
  /** Tab 唯一 id。 */
  tabId: string;
  /** Tab 展示名。 */
  label: string;
  /** 可直接注入内容区的 HTML 片段（由插件服务端生成）。 */
  html: string;
}

/** 进程内插件视图注册表（单例）。 */
export class PluginUIRegistry {
  private views = new Map<string, PluginUIViewContract>();

  /** 注册一个插件视图（来自 /api/plugins 的 views 列表）。 */
  register(view: PluginUIViewContract): void {
    this.views.set(view.tabId, view);
  }

  /** 清空（重新拉取时调用）。 */
  reset(): void {
    this.views.clear();
  }

  /** 当前已注册视图（用于渲染动态 Tab 导航）。 */
  list(): PluginUIViewContract[] {
    return [...this.views.values()];
  }

  /** 取某 Tab 的 HTML 片段（注入到内容区）。 */
  getHtml(tabId: string): string {
    return this.views.get(tabId)?.html ?? '';
  }

  /** 是否已注册某 Tab。 */
  has(tabId: string): boolean {
    return this.views.has(tabId);
  }
}

/** 全局单例（与 server 注入的视图生命周期一致）。 */
export const pluginUIRegistry = new PluginUIRegistry();
