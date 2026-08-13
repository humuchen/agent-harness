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
import './dashboard';
import './observability';
