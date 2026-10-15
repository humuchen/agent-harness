/**
 * 入口（Svelte 5 迁移版）
 * ----------------------------------------------------------------
 * 先装好主题样式与全局样式（注入 <head> 并落到 <html data-theme>），
 * 再挂载应用。应用根（App / Login）不预置在 index.html，
 * 而是由本文件按鉴权状态在运行时挂载（无 token → 全屏登录页拦截）。
 * 所有面板消费 @agent-harness/client 单例（见 ./api.ts），不再手写 fetch / SSE。
 *
 * 与 Lit 版的差异：
 *  - 自定义元素注册 → Svelte 组件 mount/unmount（svelte 的 mount API）；
 *  - 通知宿主常驻挂载（原为首次 notify 时懒创建，状态机已在模块级，无行为差异）；
 *  - mac-ui 自定义元素库保留（库自带 lit），在此做一次副作用注册。
 */
import { mount, unmount } from 'svelte';
import '@humuchen/mac-ui';

import { initTheme, initBrand } from './theme/tokens';
import { installGlobalStyles } from './styles-global';
// 触感反馈：启动时预热开关缓存（读 Preferences/localStorage），
// 避免首次交互时才异步加载偏好（那一下会按默认「开」放行，可能绕过关闭设置）。
// 同时安装全局委托监听：全站按钮类点击统一补通用轻震（语义调用优先，不重复振）。
import { initHaptics, installHaptics } from './utils/haptics';

// 通知宿主（常驻 document.body，渲染 ah-notification.svelte.ts 的状态机）
import AhNotificationHost from './components/ah-notification.svelte';
// 应用根 / 登录页 / 首屏占位
import App from './app.svelte';
import Login from './login.svelte';
import Splash from './splash.svelte';

initTheme();
installGlobalStyles();

// P2-10：Service Worker（离线 app-shell）。注册边界与守卫见 ./sw-register 与
// public/sw.js 头注释——/api/*（含 SSE）一律直通，SW 仅缓存静态资产。
import { registerServiceWorker } from './sw-register';

// 鉴权拦截：无 token 时直接挂全屏登录页，登录成功后再渲染控制台（不再依赖 #/login）。
import { isAuthed, setSession, clearSession } from './api';
import { notify } from './components/ah-notification';
import { notifyError } from './utils/errors';
import { APP_EVENTS } from './app-events';

/* ------------------------------ 挂载管理 ------------------------------ */

let appInst: Record<string, unknown> | null = null;
let loginInst: Record<string, unknown> | null = null;
let splashInst: Record<string, unknown> | null = null;
let notifHostInst: Record<string, unknown> | null = null;

/**
 * 首屏占位（ah-splash → Splash.svelte）：HTML 首帧即渲染品牌启动画面
 * （logo + 品牌名 + "正在启动…"），消灭「打开 App → 黑屏 → 才显示页面」的卡顿感。
 * 原生侧另有 @capacitor/splash-screen 启动图覆盖冷启动，两者叠加后
 * 从原生 splash 淡出 → web 占位 → 控制台/登录页，全程无黑屏。
 */
function mountSplash(): void {
  document.getElementById('ah-splash-static')?.remove();
  if (splashInst) return;
  splashInst = mount(Splash, { target: document.body });
}

/** 淡出并摘除占位（由 mountApp / mountLogin 在挂载真实页面后调用）。 */
function hideSplash(): void {
  const el = document.querySelector('.splash-root') as HTMLElement | null;
  if (el) {
    el.classList.add('hiding');
    window.setTimeout(() => {
      if (splashInst) {
        unmount(splashInst);
        splashInst = null;
      }
    }, 220);
  }
}

/** 把控制台挂到 body（幂等：已存在则不重复创建）。 */
function mountApp(): void {
  if (appInst) return;
  if (loginInst) {
    unmount(loginInst);
    loginInst = null;
  }
  appInst = mount(App, { target: document.body });
  hideSplash();
}

/** 把全屏登录页挂到 body（幂等：已存在则不重复创建）。 */
function mountLogin(): void {
  if (loginInst) return;
  if (appInst) {
    unmount(appInst);
    appInst = null;
  }
  loginInst = mount(Login, { target: document.body });
  hideSplash();
}

/** 通知宿主常驻挂载（幂等）。 */
function mountNotificationHost(): void {
  if (notifHostInst) return;
  notifHostInst = mount(AhNotificationHost, { target: document.body });
}

// 首屏按当前会话落地：已登录（本地有用户名）→ 控制台；否则→ 登录页。
// OAuth 回调场景：浏览器带 ah_auth cookie 回到 ?oauth=success，但本地尚无用户名记录，
// 此时需先打 /api/account/me 用 cookie 回填会话，再进控制台（满足 x-ah-username 双因子）。
// 注意：OAuth 用户不经过账号密码接口，因此不写入 ah_token；会话存在性仅凭用户名判断。
const oauthSuccess = new URLSearchParams(location.search).get('oauth') === 'success';

// P3-1：加载品牌配置并应用主题色。脱离品牌不影响应用主流程。
initBrand().catch(() => {});

// 触感偏好预热（fire-and-forget，失败静默）：与 initBrand 同理，绝不影响启动主流程。
void initHaptics().catch(() => {});
// 全局委托触感监听：全站按钮类点击统一补轻震（幂等，内部处理禁用态）。
installHaptics();

async function bootstrap(): Promise<void> {
  if (isAuthed()) {
    mountApp();
    return;
  }
  if (oauthSuccess) {
    // OAuth 回调需要 fetch 才挂控制台：等待期间先挂登录页占位（避免黑屏），
    // fetch 成功替换为控制台，失败则保留登录页并提示。
    mountLogin();
    try {
      const me = await fetch('/api/account/me', { credentials: 'same-origin' });
      if (me.ok) {
        const data = (await me.json()) as { username?: string };
        if (data.username) {
          setSession(data.username);
          // OAuth 路径不直接返回 token，但浏览器已持有 ah_auth cookie；
          // scheduleAutoRefresh 依赖 accessExpiresAt，而 /me 不返回该字段。
          // 此处暂不调度刷新（OAuth 用户会话由 cookie Max-Age=7d 控制，
          // 过期后 401 → handleUnauthorized → 重新走 OAuth 流程）。
          history.replaceState(null, '', location.pathname);
          mountApp();
          notify.success('第三方登录成功');
          return;
        }
      }
      // 带回 ?oauth=success 却拿不到会话：授权流程未走完 / 后端未签发 cookie。
      notify.error('第三方登录未能完成，请重新登录。', {
        key: 'oauth-failed'
      });
    } catch (e) {
      notifyError(e, {
        fallback: '第三方登录校验失败，请重新登录。',
        key: 'oauth-failed'
      });
    }
    return;
  }
  mountLogin();
}

// 立即挂载占位 UI（不等 fetch），消灭白屏/黑屏。
// - 已登录且非 OAuth 回调：mountApp() 同步挂载，body 立即有内容。
// - 未登录且非 OAuth：mountLogin() 同步挂载，立即显示登录页。
// - OAuth 回调场景：先挂登录页占位，fetch 成功后替换为控制台（见上）。
// 在 bootstrap() 之前先挂品牌占位，确保 JS 执行期间 body 始终有内容。
mountSplash();
mountNotificationHost();
bootstrap();

// SW 注册 fire-and-forget：纯增强能力，任何失败（不支持/被策略跳过/注册异常）
// 都已在其内部消化为 null，这里再兜一层保证绝不影响启动主流程。
void registerServiceWorker().catch(() => {});

// 登录页派发 ah-login-success 后进入控制台。
window.addEventListener(APP_EVENTS.loginSuccess, () => mountApp());

// 任意请求 401（登录态失效 / cookie 过期 / 被吊销）→ 清会话并强制回到登录页。
// 幂等：main.ts 只负责清本地状态 + 切登录页；同时给一条常驻通知说明「为什么被踢回来」
// （此前是静默跳登录页，用户只会以为是自己手滑退出了）。
// 通知 key 固定，多个并发 401 只合并成一条。
window.addEventListener(APP_EVENTS.sessionExpired, () => {
  clearSession();
  mountLogin();
  notify.warning('登录已失效，请重新登录。', {
    key: 'session-expired',
    duration: 0
  });
});

// 设置页「清除数据」：本地凭据已被清空 → 切回登录页。
// 不做整页 reload：既更快，也不会把「已清除」的结果提示一起刷掉（提示由设置页自己弹）。
window.addEventListener(APP_EVENTS.sessionCleared, () => {
  clearSession();
  mountLogin();
});

// ── P2 全局错误兜底 ──────────────────────────────────────────────────────────
// 此前主应用无 window error / unhandledrejection 监听：组件树未捕获的异常
// 静默消失，排障只能靠复现。现统一兜底：
// - console.error 带固定前缀（浏览器 devtools / 移动端 WebView 日志可过滤）；
// - notifyError 弹提示（同 fallback 文案自动去重合并，不会刷屏）；
// - 最近 20 条挂在 window.__ahClientErrors，控制台可直接检查，
//   也为后续接入服务端错误上报端点预留数据源。
// 注意：SSE 断线重连、401 刷新等已自处理的错误走各自 UI 提示（均有 catch），
// 只有真正未捕获的异常 / Promise 拒绝才会到达这里。
const clientErrors: Array<{ at: number; kind: string; message: string }> = [];
(window as unknown as { __ahClientErrors?: typeof clientErrors }).__ahClientErrors =
  clientErrors;

function recordGlobalError(kind: 'error' | 'unhandledrejection', message: string): void {
  clientErrors.push({ at: Date.now(), kind, message });
  if (clientErrors.length > 20) clientErrors.shift();
  console.error(`[ah:${kind}]`, message);
}

window.addEventListener('error', (e) => {
  const msg =
    e instanceof ErrorEvent ? e.message : String((e as ErrorEvent)?.message ?? 'unknown error');
  recordGlobalError('error', e.filename ? `${msg} (${e.filename}:${e.lineno})` : msg);
  notifyError(new Error(msg), {
    fallback: '页面发生内部错误，部分功能可能异常。',
    key: 'global-error'
  });
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  const msg = reason instanceof Error ? reason.message : String(reason ?? 'unknown rejection');
  recordGlobalError('unhandledrejection', msg);
  notifyError(reason instanceof Error ? reason : new Error(msg), {
    fallback: '页面发生内部错误，部分功能可能异常。',
    key: 'global-error'
  });
});
