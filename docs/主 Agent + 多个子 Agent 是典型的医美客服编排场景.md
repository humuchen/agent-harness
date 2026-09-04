明白了，主 Agent + 多个子 Agent 是典型的医美客服编排场景。让我深入分析并给出完整设计方案。

非常清晰！现在让我为你梳理一个**完整的主 Agent + 多子 Agent 业务场景分析**，直接基于你现有系统的代码。

---

# 🏥 医美客服主 Agent + 多子 Agent 业务场景设计

## 一、现有系统能力盘点

| 能力模块          | 现有实现                           | 医美场景对应                                 |
| ----------------- | ---------------------------------- | -------------------------------------------- |
| **主 Agent 框架** | `AgentHarness` + `ToolRegistry`    | 医美咨询主 Agent（接待、意图识别）           |
| **子 Agent 派发** | `delegate_task` 工具               | 项目咨询子 Agent、价格子 Agent、预约子 Agent |
| **记忆隔离**      | `sessionKey` + `tenantId` 复合 key | 多客户并发会话记忆隔离                       |
| **权限矩阵**      | admin/operator/viewer 三级         | 客服/咨询师/管理员权限分层                   |
| **任务队列**      | `RunQueue` + 优先级                | 高优先级 A 类客户快速响应                    |
| **工作流编排**    | `WorkflowExecutor` + `DagEngine`   | 复杂咨询的多步协作流程                       |
| **跨实例通信**    | `chat-bus` + Redis pub/sub         | 多坐席协作、主管接管                         |
| **历史存储**      | `ChatHistoryStore` (SQLite/Memory) | 客户画像、会话记录持久化                     |

---

## 二、医美咨询业务场景映射

### 场景 1: 客户首次咨询（主 Agent 接待 + 子 Agent 分流）

```
┌─────────────────────────────────────────────────────────────────┐
│                     客户私信入口                                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  🏠 主Agent（接待员）                                            │
│  - 意图识别：问项目 / 问价格 / 预约面诊 / 投诉                      │
│  - 记忆：当前 sessionKey 读取客户历史                              │
│  - 调用 delegate_task 派发子Agent                                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┬───────────────┐
          ▼               ▼               ▼               ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ 项目咨询 │   │ 价格评估 │   │ 预约管理 │   │ 客资录入 │
    │ 子Agent  │   │ 子Agent  │   │ 子Agent  │   │ 子Agent  │
    └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

**代码对应**（基于 `subagent-tools.js`）：

```javascript
// 主Agent 系统提示词注入
const systemPrompt = `
你是医美咨询顾问「小美」，负责接待客户私信。
根据客户意图，选择合适的子Agent处理：
- 问项目原理/效果 → delegate_task(task="分析客户需求", agent="project-advisor")
- 问价格/预算 → delegate_task(task="评估预算并报价", agent="pricing-agent")
- 预约面诊 → delegate_task(task="创建预约单", agent="booking-agent")
- 留联系方式 → delegate_task(task="录入客资", agent="lead-capture-agent")

子Agent返回结果后，整合成自然语言回复客户。
`;

// 子Agent 注册（基于 agent-run.js 的 runAgentTask）
await registerAgentCard({
	id: 'project-advisor',
	domain: 'medical-aesthetics',
	assembly: {
		systemPrompt: '你是医美项目专家，擅长双眼皮/玻尿酸/热玛吉等项目咨询...',
	},
});
```

---

### 场景 2: 意向分级 + 差异化服务（记忆 + 权限联动）

```
┌─────────────────────────────────────────────────────────────────┐
│                     客户消息流                                   │
│  "我想做双眼皮，大概多少钱？"                                      │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  主Agent 意图分析                                                 │
│  - 调用 memory 读取该客户历史咨询记录                              │
│  - 调用 lead_qualify 判定意向等级                                 │
│  - A级(高意向) → 立即转人工咨询师                                   │
│  - B级(有意向) → 子Agent详细解答 + 留资                             │
│  - C级(观望) → 标准化回复 + 优惠活动吸引                             │
│  - D级(无效) → 自动标签，后续营销                                   │
└─────────────────────────────────────────────────────────────────┘
```

**代码对应**（基于 `chat-sessions.js` 的记忆机制）：

```javascript
// 客户记忆读取（基于 owner 隔离）
async function handleCustomerMessage(sessionKey, message) {
	// 读取客户历史（多租户隔离：tenant::sessionKey）
	const history = await getChatSession(sessionKey, { tenantId: currentTenant });

	// 意图分类
	const intent = await classifyIntent(message);

	// 意向分级
	const grade = await lead_qualify({
		leadId: sessionKey,
		project: intent.project,
		budget: intent.budget,
		city: intent.city,
		grade: intent.grade, // A/B/C/D
	});

	// 根据等级分流
	if (grade === 'A') {
		// 高意向立即转人工
		await lead_handoff({ leadId: sessionKey, reason: '高意向需面诊设计' });
		return '您的高意向已转接专业咨询师，请稍候...';
	}

	// B/C/D 走子Agent处理
	return await delegate_task({
		task: `客户需求：${message}，意向等级：${grade}`,
		agent: grade === 'B' ? 'detailed-advisor' : 'standard-replier',
	});
}
```

---

### 场景 3: 多 Agent 团队协作（Workflow + TeamManager）

```
┌─────────────────────────────────────────────────────────────────┐
│                     复杂面诊预约流程                              │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  工作流定义（基于 workflow-executor.js）                           │
│                                                                 │
│  Step1: project-agent      → 确定客户想做「眼综合」                │
│    ↓                                                         │
│  Step2: [并行] pricing-agent + clinic-agent                      │
│         - pricing-agent: 评估眼综合价格区间                       │
│         - clinic-agent: 查询附近门店余号                          │
│    ↓                                                         │
│  Step3: booking-agent      → 创建预约单（锁定医生档期）             │
│    ↓                                                         │
│  Step4: lead-capture-agent → 确认联系方式，完成留资                │
└─────────────────────────────────────────────────────────────────┘
```

**代码对应**（基于 `workflow-executor.js` 的 teamRef 机制）：

```javascript
// 工作流编排（多子Agent协作）
const workflow = {
  id: 'consultation-booking',
  tenantId: 'clinic-001',
  steps: [
    {
      id: 'analyze-project',
      agentRef: 'project-advisor',
      input: '{{input}}'  // 客户原始需求
    },
    {
      id: 'parallel-eval',
      teamRef: 'pricing-team',  // 团队协作模式
      steps: [
        { id: 'price', agentRef: 'pricing-agent' },
        { id: 'slots', agentRef: 'clinic-agent' }
      ]
    },
    {
      id: 'book-consultation',
      agentRef: 'booking-agent',
      input: '{{parallel-eval}}'  // 引用并行步骤结果
    }
  ]
};

// TeamManager 执行（workflow-executor.js 第35-56行）
const result = await teamManager.executeTask('pricing-team', task,
  async (card, task) => {
    const assembled = await assembleAgent(mode, onEvent, ..., card, tenantCtx);
    return assembled.harness.run(task);
  }
);
```

---

### 场景 4: 跨坐席协作 + 主管接管（chat-bus + A2A）

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   坐席A (客服)    │    │   坐席B (咨询师)   │    │   主管 (管理员)    │
│   view role     │    │   operator role  │    │   admin role     │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                         │                         │
         │    chat-bus 实时同步     │                         │
         │◄──────────────────────►│                         │
         │                         │                         │
         │  客户转接请求            │                         │
         └────────────────────────►│  lead_handoff           │
                                   │                         │
                                   │  A2A 任务传递            │
                                   └────────────────────────►│
                                                           │
                                              主管审核 + 介入处理
```

**代码对应**（基于 `authz.js` 权限 + `chat-bus.js` 跨实例通信）：

```javascript
// 权限矩阵（医美行业定制）
const MEDICAL_MATRIX = {
	admin: [
		...DEFAULT_MATRIX.admin,
		'lead:transfer', // 跨坐席转接
		'audit:view', // 查看所有会话
		'override:close', // 强制关闭会话
	],
	operator: [
		...DEFAULT_MATRIX.operator,
		'lead:handoff', // 转接咨询师
		'booking:confirm', // 确认预约
		'payment:record', // 记录付款
	],
	viewer: [
		'chat:read', // 只读会话
		'lead:read', // 查看客资
	],
};

// 跨坐席消息同步（chat-bus.js）
async function transferToConsultant(sessionKey, fromAgent, toAgent) {
	// 1. 锁定会话（防止重复处理）
	await lockSession(sessionKey, toAgent);

	// 2. 广播转接事件
	publishChatEvent(fromAgent, {
		type: 'session:transfer',
		session: sessionKey,
		from: fromAgent,
		to: toAgent,
		timestamp: Date.now(),
	});

	// 3. A2A 任务传递（agent-run.js）
	await runAgentTask('consultant-handoff', {
		sessionKey,
		history: await getChatSession(sessionKey),
		reason: '高意向客户需专业面诊设计',
	});
}
```

---

### 场景 5: 计划模式 + 批量客资处理（RunQueue 优先级）

```
┌─────────────────────────────────────────────────────────────────┐
│                     批量客资处理场景                              │
│  - 活动推广后大量留资需要逐一回访                                   │
│  - 高优先级客户优先响应                                           │
└─────────────────────────────────────────────────────────────────┘

RunQueue 优先级队列（基于 run-queue.js）：
                    ┌─────────────┐
  P0(urgent)        │ 面诊当天提醒 │ ← 优先处理
                    └──────┬──────┘
                           │
  P1(high)         ┌──────▼──────┐
  ┌────────────────►│  高意向转化  │ ← 次优先
  │                 └──────┬──────┘
  │                        │
  │                 ┌──────▼──────┐
  └────────────────►│  普通咨询   │ ← 常规队列
                    └──────┬──────┘
                           │
  P3(low)          ┌──────▼──────┐
                   │  沉睡客户激活 │ ← 低优先级
                   └─────────────┘
```

**代码对应**（基于 `run-queue.js` 的优先级调度）：

```javascript
// 批量提交客资回访任务
async function batchProcessLeads(leads, priority = 'normal') {
	const jobs = leads.map(lead =>
		runQueue.submit({
			prompt: `回访客户：${lead.name}，手机：${lead.phone}，意向项目：${lead.project}`,
			sessionKey: `lead-revisit:${lead.id}`,
			priority: lead.grade === 'A' ? 'urgent' : lead.grade === 'B' ? 'high' : priority,
			agentId: 'followup-agent',
			tenantId: lead.clinicId,
			maxSteps: 10,
		})
	);

	return jobs;
}

// 计划模式执行（长任务不超时）
runQueue.submit({
	prompt: '对100条高意向客户发送优惠活动短信',
	planPhase: 'execute', // 触发 planTask run
	timeoutMs: 600_000, // 10分钟长任务超时
});
```

---

## 三、关键数据结构设计

### 3.1 客资实体（基于 sessionKey 隔离）

```typescript
// 医美客资标准字段
interface MedicalLead {
	id: string; // 客资唯一ID（= sessionKey）
	tenantId: string; // 租户/门店ID

	// 基础信息
	name?: string;
	phone?: string; // 脱敏存储
	wechat?: string;

	// 意向信息
	project: string[]; // ['双眼皮', '玻尿酸']
	budget: string; // '1-3万'
	city: string;
	intent: string; // 一句话画像

	// 分级
	grade: 'A' | 'B' | 'C' | 'D';

	// 状态
	stage: 'new' | 'contacted' | 'qualified' | 'booked' | 'arrived' | 'closed';

	// 时间戳
	createdAt: number;
	updatedAt: number;

	// 关联
	sessionKeys: string[]; // 关联的聊天会话
	consultantId?: string; // 负责咨询师
}
```

### 3.2 多 Agent 会话消息

```typescript
// 扩展 chat-sessions.js 的消息结构
interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;

	// 医美扩展
	agentType?: 'main' | 'project' | 'pricing' | 'booking' | 'capture';
	delegateTaskId?: string; // 关联的子Agent任务ID

	// 客资关联
	leadGrade?: 'A' | 'B' | 'C' | 'D';
	leadId?: string;

	// 元数据
	metadata?: {
		intent?: string;
		products?: string[];
		budget?: string;
		timestamp: number;
	};
}
```

---

## 四、实施路线图

| 阶段     | 内容                                      | 依赖现有模块               |
| -------- | ----------------------------------------- | -------------------------- |
| **P0**   | 主 Agent + 3 个子 Agent（项目/价格/预约） | `subagent-tools.js`        |
| **P0.1** | 客资录入 + lead_qualify 意向分级          | `chat-sessions.js`         |
| **P0.2** | 咨询师接管 + lead_handoff                 | `authz.js` + `chat-bus.js` |
| **P1**   | 工作流编排（多步协作）                    | `workflow-executor.js`     |
| **P1.1** | RunQueue 优先级调度                       | `run-queue.js`             |
| **P2**   | 多租户完整隔离                            | `history-store.js`         |
| **P2.1** | 跨实例 Redis 部署                         | `queue-backend.js`         |

---

## 五、总结

你现有的 `@agent-harness/server` 已经具备**完整的主 Agent + 多子 Agent**基础设施：

1. **通信层**：`delegate_task` 工具 + 独立 sessionKey
2. **编排层**：`WorkflowExecutor` + `TeamManager`
3. **记忆层**：`Memory`（运行时）+ `ChatHistoryStore`（持久化）
4. **权限层**：`RoleBasedAuthorizer` 可配置矩阵
5. **队列层**：`RunQueue` 支持优先级 + 并发控制
6. **通信层**：`chat-bus` 支持跨实例实时同步

下一步建议基于这套框架，先实现 **P0 核心流程**：主 Agent 接待 → 子 Agent 分流 → 客资录入 → 意向分级，这样可以用最小改动验证核心价值。
