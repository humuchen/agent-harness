/**
 * 入口：导入各组件模块以注册自定义元素，<ah-app> 已在 index.html 中声明。
 * 所有面板消费 @agent-harness/client 单例（见 ./api.ts），不再手写 fetch / SSE。
 */
import './app';
import './panels';
