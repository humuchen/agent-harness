/**
 * 服务端插件扩展宿主（Phase 1 · 通用扩展点，无业务词）。
 *
 * 实现 core 定义的 ServerExtensionHost：插件经 PluginContext.server.registerExtension
 * 挂载 HTTP 路由与事件钩子。宿主把所有插件路由收敛到统一前缀 `/api/plugins/:pluginId/*`，
 * 既避免与其它端点路径冲突，又把前缀控制权留在平台侧（插件只需声明相对路径）。
 *
 * 本文件不出现任何业务语义（无「客服/退款/FAQ」），是平台通用能力。
 */

import type {
  ServerExtensionHost,
  ServerExtension,
  PluginEventListener,
  PluginEvent,
  PluginRouteHandler,
  PluginRouteUser,
  WebExtensionHost,
  PluginUIView,
} from '@agent-harness/core';
import { publishReminder, publishToRole } from './reminder-bus';

type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;

/** 服务端插件扩展宿主（进程单例）。 */
export class ServerPluginHost implements ServerExtensionHost {
  /** 完整路径 → 处理器。 */
  private routes = new Map<string, PluginRouteHandler>();
  /** 事件钩子集合。 */
  private listeners: PluginEventListener[] = [];

  registerExtension(ext: ServerExtension): () => void {
    const base = `/api/plugins/${ext.id}`;
    const added: string[] = [];
    if (ext.mountRoutes) {
      for (const [rel, h] of Object.entries(ext.mountRoutes)) {
        const full = (base + (rel.startsWith('/') ? rel : '/' + rel)).replace(/\/+$/, '');
        this.routes.set(full || base, h);
        added.push(full || base);
      }
    }
    if (ext.onEvent) this.listeners.push(ext.onEvent);
    return () => {
      for (const f of added) this.routes.delete(f);
      if (ext.onEvent) {
        const i = this.listeners.indexOf(ext.onEvent);
        if (i >= 0) this.listeners.splice(i, 1);
      }
    };
  }

  /**
   * 尝试用插件路由处理给定 path；命中返回 true（已写出响应）。
   * user 为宿主鉴权后的当前用户（插件据此做数据归属绑定）；未鉴权（开放模式）为 undefined。
   */
  async handle(path: string, req: Req, res: Res, user?: PluginRouteUser): Promise<boolean> {
    const h = this.routes.get(path);
    if (!h) return false;
    await h(req, res, user);
    return true;
  }

  /** 向所有插件事件钩子广播一条事件。 */
  emit(e: PluginEvent): void {
    for (const l of this.listeners) {
      try {
        void l(e);
      } catch {
        /* 单个钩子异常不影响其它 */
      }
    }
    // 备忘提醒事件桥接到实时广播总线：前端 /api/events SSE 据此即时弹通知。
    // 事件携带 owner（= 归属用户），reminder-bus 按订阅连接的 owner 过滤后转发。
    if (e.type === 'memo:reminder') {
      publishReminder(e);
    }
    // 客服业务提醒：分析完成事件 → 推送给所有客服角色的在线 SSE 连接
    if (e.type === 'cs:reminder:analysis_complete') {
      publishToRole('service', e);
    }
  }

  /** 调试/可观测：当前已挂载的插件路由数。 */
  get routeCount(): number {
    return this.routes.size;
  }
}

/**
 * 前端插件扩展宿主（Phase 2 · 通用扩展点，无业务词）。
 *
 * 实现 core 定义的 WebExtensionHost：插件经 PluginContext.web.registerView 注册一个视图
 * （tabId / label / 可渲染 HTML 片段）。宿主收集这些视图，`listViews()` 供 server 的
 * `/api/plugins` 端点返回，webapp 拉取后动态渲染成 Tab。宿主不感知任何业务语义。
 */
export class WebPluginHost implements WebExtensionHost {
  private views: PluginUIView[] = [];

  registerView(view: PluginUIView): () => void {
    this.views.push(view);
    return () => {
      const i = this.views.indexOf(view);
      if (i >= 0) this.views.splice(i, 1);
    };
  }

  /**
   * 渲染全部已注册视图（调用各 view.render(user)），返回 Tab 元信息 + HTML 片段。
   * user 为宿主鉴权后的当前用户，插件据此按登录人渲染（数据 owner 绑定）。
   */
  async listViews(user?: PluginRouteUser): Promise<Array<{ tabId: string; label: string; html: string }>> {
    const out: Array<{ tabId: string; label: string; html: string }> = [];
    for (const v of this.views) {
      const html = await v.render(user);
      out.push({ tabId: v.tabId, label: v.label, html });
    }
    return out;
  }

  /** 调试/可观测：当前已注册的前端视图数。 */
  get viewCount(): number {
    return this.views.length;
  }
}
