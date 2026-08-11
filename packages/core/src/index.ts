export * from './types';
export * from './telemetry';
export * from './memory';
export * from './tools';
export * from './guardrails';
export * from './harness';
export * from './loadEnv';
export * from './llm';
export * from './integrations/harness-client.types';
export * from './integrations/harness-client';
export * from './integrations/harness-tools';
export * from './integrations/mcp/placeholder';

// 兜底入口：允许 `node dist/src/index.js` 直接把面板服务拉起来。
// 某些 PaaS（例如 Render 面板里残留的旧启动命令）会指向 package.json 的 main
// 而不是真正的服务文件；有了这段守卫，无论指向哪个入口都能正常启动。
// 作为库被 import 时 require.main !== module，不会有任何副作用。
if (require.main === module) {
  require('./ui/server');
}
