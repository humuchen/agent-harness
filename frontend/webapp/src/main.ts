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
// 通用 UI 组件统一注册入口（弹层 / 弹框 / 抽屉 / 通知）：集中注册所有通用 UI 原语。
import './components';

// 鉴权拦截：无 token 时直接挂全屏登录页，登录成功后再渲染控制台（不再依赖 #/login）。
import { isAuthed, setSession, clearSession, scheduleAutoRefresh } from './api';
import { notify } from './components/ah-notification';
import { notifyError } from './utils/errors';

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

// 首屏按当前会话落地：已登录（本地有用户名）→ 控制台；否则→ 登录页。
// OAuth 回调场景：浏览器带 ah_auth cookie 回到 ?oauth=success，但本地尚无用户名记录，
// 此时需先打 /api/account/me 用 cookie 回填会话，再进控制台（满足 x-ah-username 双因子）。
// 注意：OAuth 用户不经过账号密码接口，因此不写入 ah_token；会话存在性仅凭用户名判断。
const oauthSuccess = new URLSearchParams(location.search).get('oauth') === 'success';
async function bootstrap(): Promise<void> {
  if (isAuthed()) {
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
  }
  mountLogin();
}
bootstrap();

// 登录页派发 ah-login-success 后进入控制台。
window.addEventListener('ah-login-success', () => mountApp());

// 任意请求 401（登录态失效 / cookie 过期 / 被吊销）→ 清会话并强制回到登录页。
// 幂等：main.ts 只负责清本地状态 + 切登录页；同时给一条常驻通知说明「为什么被踢回来」
// （此前是静默跳登录页，用户只会以为是自己手滑退出了）。
// 通知 key 固定，多个并发 401 只合并成一条。
window.addEventListener('ah-session-expired', () => {
  clearSession();
  mountLogin();
  notify.warning('登录已失效，请重新登录。', {
    key: 'session-expired',
    duration: 0
  });
});
