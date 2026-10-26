/**
 * worker-bootstrap.ts — worker 侧插件引导（tools-only 沙箱，第五批长期项）。
 *
 * 职责：在 worker_threads 内加载插件入口模块（entry），为其提供**受限 ctx-lite**：
 *   - tools：经 RPC 向主线程注册工具（名称/描述/schema 走主线程 ToolRegistry，
 *     handler 留在 worker 内，调用经 postMessage 往返）；
 *   - env：主线程经白名单（resolvePluginEnv）收敛后的只读子集 —— 与进程内插件
 *     同一密钥纪律，绝不含 ADMIN_API_KEY 等凭据；
 *   - manifest：只读清单。
 *
 * 边界（诚实声明）：本形态**仅支持 tools-only 插件** —— server 路由 / web 视图 /
 * events / cron / A2A 不跨线程代理；需要这些能力的插件继续用进程内形态
 * （isolation: 'none'）。工具入参/返回值必须是可结构化克隆的 JSON 值。
 *
 * 协议（与 worker-sandbox.ts 对应）：
 *   worker → main: {type:'register', name, description, schema}
 *                  {type:'ready'} | {type:'load-error', error}
 *                  {type:'result', id, ok, value|error}
 *   main → worker: {type:'call', id, name, args}
 */

import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  // 直接 require 本文件（非 worker 上下文）时的防御。
  // eslint-disable-next-line no-console
  console.error('[worker-bootstrap] 必须以 worker_threads 启动');
  process.exit(1);
}

interface WorkerInit {
  entry: string;
  env: Record<string, string>;
  manifest: { id: string; version: string; name?: string };
}

const port = parentPort!;
const init = workerData as WorkerInit;

const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();

/** ctx-lite：tools 门面（RPC 注册）+ 只读 env/manifest。 */
const ctxLite = {
  tools: {
    register(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => unknown,
    ): void {
      if (typeof name !== 'string' || !name) throw new Error('工具名必须为非空字符串');
      handlers.set(name, handler);
      port.postMessage({ type: 'register', name, description, schema });
    },
  },
  env: Object.freeze({ ...init.env }),
  manifest: Object.freeze({ ...init.manifest }),
};

port.on('message', (msg: { type: string; id?: number; name?: string; args?: Record<string, unknown> }) => {
  if (msg.type !== 'call') return;
  const id = msg.id as number;
  const handler = handlers.get(String(msg.name));
  Promise.resolve()
    .then(() =>
      handler
        ? handler(msg.args ?? {})
        : { error: true, message: `unknown tool: ${msg.name}` },
    )
    .then((value) => port.postMessage({ type: 'result', id, ok: true, value }))
    .catch((e: unknown) =>
      port.postMessage({ type: 'result', id, ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
});

// 异步加载入口模块：预期导出 setup(ctxLite)（或 default.setup）。
void (async () => {
  // entry 路径由主线程解析为绝对路径后下发；此处禁止再拼接用户输入。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(init.entry) as {
    setup?: (ctx: unknown) => void | Promise<void>;
    default?: { setup?: (ctx: unknown) => void | Promise<void> };
  };
  const setup = mod.setup ?? mod.default?.setup;
  if (typeof setup !== 'function') {
    throw new Error('插件入口须导出 setup(ctxLite) 函数（tools-only 沙箱形态）');
  }
  await setup(ctxLite);
  port.postMessage({ type: 'ready' });
})().catch((e: unknown) => {
  port.postMessage({ type: 'load-error', error: e instanceof Error ? e.message : String(e) });
});
