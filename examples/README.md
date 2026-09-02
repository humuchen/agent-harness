# 示例代码导航

本目录包含 Agent-Harness 的使用示例,覆盖从基础到高级的各种场景。

## 📚 示例分类

### 🟢 入门示例 (适合新手)

| 文件                   | 说明                                     | 运行方式           |
| ---------------------- | ---------------------------------------- | ------------------ |
| [basic.ts](./basic.ts) | **最简示例** - 展示如何运行一个基本Agent | `npx tsx basic.ts` |
| [chat.ts](./chat.ts)   | **对话示例** - 展示多轮对话交互          | `npx tsx chat.ts`  |
| [shell.ts](./shell.ts) | **Shell交互** - 命令行交互式Agent        | `npx tsx shell.ts` |

### 🟡 中级示例 (核心功能)

| 文件                                   | 说明                                    | 运行方式                   |
| -------------------------------------- | --------------------------------------- | -------------------------- |
| [multi-agent.ts](./multi-agent.ts)     | **多Agent协作** - 展示多个Agent协同工作 | `npx tsx multi-agent.ts`   |
| [multi-mcp.ts](./multi-mcp.ts)         | **多MCP服务** - 连接多个MCP工具服务     | `npx tsx multi-mcp.ts`     |
| [real-loop.ts](./real-loop.ts)         | **真实循环** - Agent工具调用循环        | `npx tsx real-loop.ts`     |
| [workflow-demo.ts](./workflow-demo.ts) | **工作流演示** - 完整业务工作流         | `npx tsx workflow-demo.ts` |

### 🔴 高级示例 (专业场景)

| 文件                                     | 说明                                  | 运行方式                    |
| ---------------------------------------- | ------------------------------------- | --------------------------- |
| [medspa-agent.ts](./medspa-agent.ts)     | **医美Agent** - 医疗客资Agent完整实现 | `npx tsx medspa-agent.ts`   |
| [os-sandbox.ts](./os-sandbox.ts)         | **操作系统沙箱** - 安全执行环境       | `npx tsx os-sandbox.ts`     |
| [self-serve-env.ts](./self-serve-env.ts) | **自助环境** - 自动环境配置           | `npx tsx self-serve-env.ts` |

### 🔍 验证/测试示例

| 文件                                       | 说明                                | 运行方式                     |
| ------------------------------------------ | ----------------------------------- | ---------------------------- |
| [verify-harness.ts](./verify-harness.ts)   | **框架验证** - 验证框架核心功能     | `npx tsx verify-harness.ts`  |
| [verify-mcp.ts](./verify-mcp.ts)           | **MCP验证** - 验证MCP服务连接       | `npx tsx verify-mcp.ts`      |
| [use-context7.ts](./use-context7.ts)       | **Context7使用** - 使用Context7工具 | `npx tsx use-context7.ts`    |
| [verify-context7.ts](./verify-context7.ts) | **Context7验证** - 验证Context7集成 | `npx tsx verify-context7.ts` |

## 🚀 快速开始

### 1. 安装依赖

```bash
cd examples
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入 API Key
```

### 3. 运行示例

```bash
# 从最简单的开始
npx tsx basic.ts

# 体验对话
npx tsx chat.ts

# 查看多Agent协作
npx tsx multi-agent.ts
```

## 📖 示例详解

### basic.ts - 最简示例

**使用场景**: 了解如何初始化和运行Agent

**核心概念**:

- 创建Agent实例
- 设置系统提示
- 运行单次查询

**关键代码**:

```typescript
const agent = new Agent({
  systemPrompt: '你是一个有用的助手',
  model: 'gpt-4'
});

const result = await agent.run('你好,请介绍一下自己');
console.log(result);
```

---

### chat.ts - 对话示例

**使用场景**: 实现多轮对话,保持上下文

**核心概念**:

- 对话历史管理
- 多轮交互
- 上下文保持

**关键代码**:

```typescript
const chat = new ChatSession(agent);

await chat.sendMessage('我想了解医美项目');
await chat.sendMessage('双眼皮手术多少钱?');
await chat.sendMessage('恢复期多久?');
```

---

### multi-agent.ts - 多Agent协作

**使用场景**: 多个专业Agent协同完成任务

**核心概念**:

- Agent角色分工
- 任务分发
- 结果聚合

**关键代码**:

```typescript
const researcher = new Agent({ role: '研究员' });
const writer = new Agent({ role: '作家' });
const reviewer = new Agent({ role: '审核员' });

// 协作流程
const research = await researcher.run('调研医美市场');
const article = await writer.run(`基于以下研究写文章: ${research}`);
const final = await reviewer.run(`审核文章: ${article}`);
```

---

### multi-mcp.ts - 多MCP服务

**使用场景**: 连接多个MCP工具服务扩展Agent能力

**核心概念**:

- MCP服务注册
- 工具发现
- 跨服务调用

**关键代码**:

```typescript
const agent = new Agent({
  mcpServers: [
    { name: 'weather', url: 'http://localhost:3001' },
    { name: 'calendar', url: 'http://localhost:3002' }
  ]
});

// Agent自动发现并调用工具
const result = await agent.run('明天北京天气如何?帮我安排会议');
```

---

### medspa-agent.ts - 医美Agent

**使用场景**: 医疗客资Agent完整实现,包含合规护栏

**核心概念**:

- 医疗广告合规检测
- 线索资质评估
- 预约管理
- 转人工流程

**关键代码**:

```typescript
const medspaAgent = new MedicalAestheticsAgent({
  guardrails: medicalAdRules,
  kbService: kbService,
  leadService: leadService
});

// 完整对话流程
await medspaAgent.handleMessage('我想做双眼皮');
// → 资质评估 → 留资 → 预约 → (可选)转人工
```

---

### os-sandbox.ts - 操作系统沙箱

**使用场景**: 安全执行系统命令,防止破坏性操作

**核心概念**:

- 沙箱隔离
- 权限控制
- 资源限制

**关键代码**:

```typescript
const sandbox = new OSSandbox({
  allowedCommands: ['ls', 'cat', 'pwd'],
  maxMemory: '512mb',
  timeout: 30000
});

const result = await sandbox.execute('ls -la');
```

---

### workflow-demo.ts - 工作流演示

**使用场景**: 完整业务工作流,包含多个步骤和条件分支

**核心概念**:

- 工作流定义
- 步骤编排
- 条件分支
- 错误处理

**关键代码**:

```typescript
const workflow = new Workflow({
  steps: [
    { id: 'qualify', action: qualifyLead },
    { id: 'capture', action: captureLead, condition: isQualified },
    { id: 'book', action: bookConsultation, condition: hasConsent }
  ]
});

await workflow.execute({ channel: '抖音', project: '双眼皮' });
```

---

## 💡 学习建议

### 学习路径

```
入门 (1-2小时)
  ↓
basic.ts → chat.ts → shell.ts
  ↓
中级 (3-4小时)
  ↓
multi-agent.ts → multi-mcp.ts → real-loop.ts
  ↓
高级 (5-6小时)
  ↓
medspa-agent.ts → os-sandbox.ts → workflow-demo.ts
```

### 调试技巧

1. **启用详细日志**:

   ```bash
   DEBUG=* npx tsx basic.ts
   ```

2. **单步执行**:

   ```bash
   npx tsx --inspect-brk basic.ts
   # 然后在 Chrome 打开 chrome://inspect
   ```

3. **查看网络请求**:
   ```bash
   NODE_DEBUG=http,https npx tsx multi-mcp.ts
   ```

## 🐛 常见问题

### Q: 运行示例时报错 "Missing API Key"

**A**: 确保已配置环境变量:

```bash
cp .env.example .env
# 编辑 .env 添加 OPENAI_API_KEY
```

### Q: MCP服务连接失败

**A**: 检查MCP服务是否运行:

```bash
curl http://localhost:3001/health
```

### Q: 如何查看Agent的完整执行日志?

**A**: 启用调试模式:

```typescript
const agent = new Agent({
  debug: true // 启用详细日志
});
```

## 📚 相关资源

- [架构文档](../docs/01-architecture/)
- [插件开发指南](../docs/03-plugins/)
- [部署指南](../docs/02-deployment/)
- [CHANGELOG](../CHANGELOG.md)

---

**需要帮助?** 查看项目README或提交Issue。
