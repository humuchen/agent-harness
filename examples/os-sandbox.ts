import {
  AgentHarness,
  ToolRegistry,
  Memory,
  objectParams,
  registerShell,
  createSandboxExecutor,
  messageText,
  type ShellExecRequest,
} from '@agent-harness/core';
import type { LLM, ToolCall } from '@agent-harness/core';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 演示 OS 级沙箱（命名空间隔离 + 系统调用过滤 + 资源限制 + 权限控制）。
//
// 关键改动：registerShell 的 executor 走 createSandboxExecutor({ backend: 'os' })，
// 在「命令白名单 + 作用域 + 确认」三道逻辑闸门之后，再把放行的命令交由 OS 沙箱执行：
//   - Linux + 原生 helper 就绪 -> 真正的四类原语全覆盖（unshare 命名空间 / seccomp /
//     setrlimit / 丢弃能力 + 禁提权 + 只读根）；
//   - 否则优雅降级为硬化本地执行器（macOS / 无 helper 时），保持「一切降级可用」。
//
// 可在此叠加 OS 级策略，例如收紧 syscall / 进一步限制资源：
//   createSandboxExecutor({
//     backend: 'os',
//     osProfile: {
//       seccomp: { profile: 'strict', defaultAction: 'kill' },
//       resources: { cpuSeconds: 5, processes: 64 },
//     },
//   })

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-os-demo-'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'os sandbox works\n');

  const tools = new ToolRegistry();
  tools.register(
    'add',
    'Add two numbers.',
    objectParams({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']),
    async ({ a, b }) => ({ sum: Number(a) + Number(b) })
  );

  // OS 级沙箱执行器：backend='os' 启用底层隔离；策略沿用默认（全套收紧）。
  const osExecutor = createSandboxExecutor({
    backend: 'os',
    osProfile: {
      seccomp: { profile: 'baseline', defaultAction: 'errno' },
      resources: { cpuSeconds: 10, processes: 128 },
    },
  });
  // 打印本次执行实际生效了哪些隔离（backend / 命名空间 / seccomp / 资源 / 能力）。
  console.log('[OS 沙箱状态]', JSON.stringify(osExecutor.describe?.() ?? osExecutor, null, 2));

  registerShell(tools, {
    root,
    allowedCommands: ['echo', 'ls', 'cat', 'pwd'],
    requireConfirmation: true,
    confirm: async (req: ShellExecRequest) => {
      console.log(`  [confirm] ${req.command} ${req.args.join(' ')} @ ${req.cwd}`);
      return true;
    },
    // 把 OS 沙箱执行器注入 shell 工具：白名单放行的命令在此被 OS 隔离执行。
    executor: osExecutor,
  });

  const mockLLM: LLM = async (messages) => {
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      return { content: `工具返回：${String(messageText(last)).slice(0, 200)}`, tool_calls: [] };
    }
    const text = messageText(last);
    if (text.includes('列出') || text.includes('list')) {
      return { content: '', tool_calls: [{ id: 'c1', name: 'builtin__shell_exec', arguments: { command: 'ls', cwd: '.' } } as ToolCall] };
    }
    if (text.includes('读') || text.includes('read')) {
      return { content: '', tool_calls: [{ id: 'c2', name: 'builtin__shell_exec', arguments: { command: 'cat', args: ['hello.txt'] } } as ToolCall] };
    }
    return { content: `（示例）已处理：${text}`, tool_calls: [] };
  };

  const agent = new AgentHarness({
    llm: mockLLM,
    tools,
    memory: new Memory(),
    systemPrompt: '你是演示助手，通过内置工具完成任务。',
  });

  console.log('\n—— 场景 1：列出沙箱目录（OS 隔离内执行） ——');
  console.log('<<', await agent.run('请列出当前沙箱目录下的文件'));

  console.log('\n—— 场景 2：读取 hello.txt（OS 隔离内执行） ——');
  console.log('<<', await agent.run('请读取 hello.txt 的内容'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
