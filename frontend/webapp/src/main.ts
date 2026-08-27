/**
 * 入口：先装好主题样式（注入 <head> 并落到 <html data-theme>），
 * 再注册自定义元素。<ah-app> 已在 index.html 中声明。
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
// 通用 UI 原语（suggestions/file-upload 已由 run.ts 引入；popup 在此注册）。
import './components/ah-popup';
// 统一弹框组件（components/）：info / confirm / warning / 自定义内容 + 命令式 API。
import './components/ah-modal';
// 通用抽屉组件（components/）：四向滑入 + 遮罩/ Esc / 关闭按钮 + 焦点圈闭环。
import './components/ah-drawer';

// 演示入口：访问 #/login 时以全屏登录页替换控制台，便于预览登录/注册 + 左侧动画。
if (location.hash.startsWith('#/login')) {
  const existing = document.querySelector('ah-app');
  const login = document.createElement('ah-login');
  if (existing) existing.replaceWith(login);
  else document.body.appendChild(login);
}
