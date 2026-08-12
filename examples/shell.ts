import {
  AgentHarness,
  ToolRegistry,
  Memory,
  objectParams,
  registerShell,
  type ShellExecRequest,
} from '@agent-harness/core';
import type { LLM, ToolCall } from '@agent-harness/core';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 演示沙箱 shell / 代码执行能力（Task #30）：
//   - 命令白名单：只允许 echo / ls / cat / node / pwd
//   - 作用域：cwd 锁定在临时沙箱根目录内
//   - 确认：requireConfirmation=true，用 confirm 函数做「演示用自动批准」
//           （真实 Web 场景可改为对接 /api/shell/approve 审批队列）
async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shell-demo-'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'sandbox works\n');

  const tools = new ToolRegistry();
  tools.register(
    'add',
    'Add two numbers and return the sum.',
    objectParams(
      { a: { type: 'number', description: 'first operand' }, b: { type: 'number', description: 'second operand' } },
      ['a', 'b']
    ),
    async ({ a, b }) => ({ sum: Number(a) + Number(b) })
  );

  // 注册沙箱 shell 工具：白名单 + 作用域 + 确认。
  registerShell(tools, {
    root,
    allowedCommands: ['echo', 'ls', 'cat', 'node', 'pwd'],
    requireConfirmation: true,
    // 演示用确认策略：打印请求；白名单内但含 'secret' 的命令拒绝（演示「确认」闸门），
    // 其余自动批准。真实 Web 场景可改为抛给 /api/shell/approve 审批队列。
    confirm: async (req: ShellExecRequest) => {
      if (req.args.includes('secret')) {
        console.log(`  [confirm] 拒绝: ${req.command} ${req.args.join(' ')}`);
        return false;
      }
      console.log(`  [confirm] 批准: ${req.command} ${req.args.join(' ')} @ ${req.cwd}`);
      return true;
    },
  });

  const mockLLM: LLM = async (messages) => {
    const last = messages[messages.length - 1];
    // 工具结果回显，便于直观看到「拦截 / 成功」。
    if (last?.role === 'tool') {
      return { content: `工具返回：${String(last.content ?? '').slice(0, 200)}`, tool_calls: [] };
    }
    const text = last?.content ?? '';
    if (text.includes('列出') || text.includes('list')) {
      const call: ToolCall = { id: 'c1', name: 'builtin__shell_exec', arguments: { command: 'ls', cwd: '.' } };
      return { content: '', tool_calls: [call] };
    }
    if (text.includes('读') || text.includes('read')) {
      const call: ToolCall = { id: 'c2', name: 'builtin__shell_exec', arguments: { command: 'cat', args: ['hello.txt'] } };
      return { content: '', tool_calls: [call] };
    }
    if (text.includes('secret')) {
      // 白名单内的命令，但被 confirm 策略拒绝（演示「确认」这道闸门）。
      const call: ToolCall = { id: 'c3', name: 'builtin__shell_exec', arguments: { command: 'echo', args: ['secret'] } };
      return { content: '', tool_calls: [call] };
    }
    if (text.includes('rm') || text.includes('越权') || text.includes('删除')) {
      // 白名单外的命令（rm）+ 越界 cwd（/etc），被「白名单 + 作用域」拦截。
      const call: ToolCall = { id: 'c4', name: 'builtin__shell_exec', arguments: { command: 'rm', args: ['-rf', '/'], cwd: '/etc' } };
      return { content: '', tool_calls: [call] };
    }
    return { content: `（示例）已处理：${text}`, tool_calls: [] };
  };

  const agent = new AgentHarness({
    llm: mockLLM,
    tools,
    memory: new Memory(),
    systemPrompt: '你是演示助手，会通过内置工具完成任务。',
  });

  console.log('—— 场景 1：列出沙箱目录（白名单 + 作用域 + 确认通过） ——');
  console.log('<<', await agent.run('请列出当前沙箱目录下的文件'));

  console.log('\n—— 场景 2：读取 hello.txt（白名单 + 作用域 + 确认通过） ——');
  console.log('<<', await agent.run('请读取 hello.txt 的内容'));

  console.log('\n—— 场景 3：越权命令（rm + 越界 cwd）应被白名单/作用域拦截 ——');
  console.log('<<', await agent.run('请执行 rm -rf / 并切到 /etc 目录'));

  console.log('\n—— 场景 4：白名单内命令但被「确认」策略拒绝 ——');
  console.log('<<', await agent.run('请执行 echo secret'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
