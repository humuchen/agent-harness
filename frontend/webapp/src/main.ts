/**
 * 入口：先装好主题样式（注入 <head> 并落到 <html data-theme>），
 * 再注册自定义元素。应用根（ah-app / ah-login）不预置在 index.html，
 * 而是由本文件按鉴权状态在运行时挂载（无 token → 全屏登录页拦截）。
 * 所有面板消费 @agent-harness/client 单例（见 ./api.ts），不再手写 fetch / SSE。
 */
import { initTheme } from './theme/tokens';

initTheme();

import './app';
import './panels';
import './run';
import './chat';
import './dashboard';
import './observability';
import './login';
// 通用 UI 组件统一注册入口（弹层 / 弹框 / 抽屉）：集中注册所有通用 UI 原语。
import './components';

// 鉴权拦截：无 token 时直接挂全屏登录页，登录成功后再渲染控制台（不再依赖 #/login）。
// 与 app.ts 的 History 路由解耦——这是「是否放行应用」的门户，而非一条普通路由。
import { getToken, setSession, clearSession } from './api';

/** 把控制台挂到 body（幂等：已存在则不重复创建）。 */
function mountApp(): void {
  if (document.querySelector('ah-app')) return;
  document.querySelector('ah-login')?.remove();
  document.body.appendChild(document.createElement('ah-app'));
}

/** 把全屏登录页挂到 body（幂等：已存在则不重复创建）。 */
function mountLogin(): void {
  if (document.querySelector('ah-login')) return;
  document.querySelector('ah-app')?.remove();
  document.body.appendChild(document.createElement('ah-login'));
}

// 首屏按当前 token 落地：未登录 → 登录页；已登录 → 控制台。
// OAuth 回调场景：浏览器带 ah_auth cookie 回到 ?oauth=success，但本地尚无用户名记录，
// 此时需先打 /api/account/me 用 cookie 回填会话，再进控制台（满足 x-ah-username 双因子）。
const oauthSuccess = new URLSearchParams(location.search).get('oauth') === 'success';
async function bootstrap(): Promise<void> {
  if (getToken()) {
    mountApp();
    return;
  }
  if (oauthSuccess) {
    try {
      const me = await fetch('/api/account/me', { credentials: 'same-origin' });
      if (me.ok) {
        const data = (await me.json()) as { username?: string };
        if (data.username) {
          setSession(data.username);
          history.replaceState(null, '', location.pathname);
          mountApp();
          return;
        }
      }
    } catch {
      /* 忽略，落到登录页 */
    }
  }
  mountLogin();
}
bootstrap();

// 登录页派发 ah-login-success 后进入控制台。
window.addEventListener('ah-login-success', () => mountApp());

// 任意请求 401（登录态失效 / cookie 过期 / 被吊销）→ 清会话并强制回到登录页。
// 幂等：main.ts 只负责清本地状态 + 切登录页，不重复弹窗。
window.addEventListener('ah-session-expired', () => {
  clearSession();
  mountLogin();
});
