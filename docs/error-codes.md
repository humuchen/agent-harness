# 错误码文档

本文档列出 Agent-Harness 项目中所有重要错误码、含义和解决建议。

---

## 🔐 认证与授权错误

### AUTH_001 - 未授权访问

**错误信息**: `unauthorized: missing or invalid token`

**位置**: `access/server/src/server.ts:221`

**原因**:

- 请求未携带认证令牌
- 令牌格式不正确
- 令牌已过期

**解决**:

```bash
# 检查环境变量
echo $ADMIN_TOKEN

# 在请求中添加令牌
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3100/api/v1/run
```

---

### AUTH_002 - 权限不足

**错误信息**: `forbidden`

**位置**: `access/server/src/server.ts:180`

**原因**:

- 用户角色不具备所需权限
- RBAC 策略拒绝操作

**解决**:

- 检查用户角色: `admin` > `operator` > `viewer`
- 查看权限矩阵: `access/server/src/authz.ts`
- 联系管理员提升权限

---

### AUTH_003 - 速率限制

**错误信息**: `rate limit exceeded`

**位置**: `access/server/src/server.ts:174`

**原因**:

- 短时间内请求过多
- 超过配置的速率限制

**解决**:

- 降低请求频率
- 调整速率限制配置(如果已配置)

---

## 🤖 Agent 与作业错误

### AGENT_001 - Agent 未找到

**错误信息**: `agent not found`

**位置**: `access/server/src/server.ts:427`

**原因**:

- 请求的 Agent ID 不存在
- Agent 未正确注册

**解决**:

```bash
# 查看已注册的Agent
curl http://localhost:3100/api/agents

# 检查插件是否加载成功
# 查看服务器日志
```

---

### AGENT_002 - 工作流未找到

**错误信息**: `workflow not found`

**位置**: `access/server/src/server.ts:441`

**原因**:

- 请求的工作流 ID 不存在

**解决**:

- 检查工作流定义是否存在
- 确认工作流已正确注册

---

### JOB_001 - 作业未找到

**错误信息**: `job not found`

**位置**: `access/server/src/server.ts:524, 542`

**原因**:

- Job ID 不存在或已过期
- Job 可能已被清理

**解决**:

- 检查 Job ID 是否正确
- 查看作业列表: `GET /api/jobs`

---

### JOB_002 - 作业执行失败

**错误信息**: `_done{error: true}` (SSE 事件)

**位置**: `access/server/src/run-queue.ts:491, 511, 668, 681`

**原因**:

- LLM API 调用失败
- 工具执行异常
- 超时或资源限制

**解决**:

```bash
# 查看详细错误日志
DEBUG=* pnpm server

# 检查LLM API Key
echo $OPENAI_API_KEY
echo $OPEN_API_KEY
```

---

## 🔧 工具与插件错误

### TOOL_001 - 未知工具

**错误信息**: `Unknown tool: {name}`

**位置**: `backend/core/src/tools.ts:58`

**原因**:

- 调用的工具名称未注册
- 工具名称拼写错误

**解决**:

- 查看可用工具列表
- 检查工具注册代码
- 确认工具名称拼写

---

### PLUGIN_001 - 插件未找到

**错误信息**: `plugin not found: {id}`

**位置**: `backend/core/src/plugin/loader.ts:265`

**原因**:

- 插件 ID 不存在
- 插件未正确安装

**解决**:

```bash
# 查看已安装插件
curl http://localhost:3100/api/plugins

# 检查插件目录
ls plugins/
```

---

### PLUGIN_002 - 插件已存在

**错误信息**: `plugin already installed: {id}`

**位置**: `backend/core/src/plugin/loader.ts:156, 171`

**原因**:

- 重复安装同一插件

**解决**:

- 先卸载再安装
- 或使用升级接口

---

### PLUGIN_003 - 插件签名验证失败

**错误信息**: `plugin "{id}" signature verification failed`

**位置**: `backend/core/src/plugin/loader.ts:146`

**原因**:

- 插件包被篡改
- 签名不匹配

**解决**:

- 重新获取插件包
- 检查完整性

---

### PLUGIN_004 - 依赖缺失

**错误信息**: `plugin "{id}" depends on missing plugin "{dep}"`

**位置**: `backend/core/src/plugin/loader.ts:258`

**原因**:

- 插件依赖的其他插件未安装

**解决**:

```bash
# 先安装依赖插件
# 查看插件依赖关系
cat plugins/*/manifest.json | grep dependencies
```

---

### PLUGIN_005 - 插件 ID 不匹配

**错误信息**: `upgrade manifest id mismatch: {manifest.id} != {id}`

**位置**: `backend/core/src/plugin/loader.ts:239`

**原因**:

- 升级包的 manifest 与实际 ID 不符

**解决**:

- 检查升级包是否正确
- 确认 manifest.json 中的 id 字段

---

## 🔄 工作流错误

### WF_001 - 工作流执行器未注入

**错误信息**: `DagEngine requires an injected 'executor'`

**位置**: `backend/core/src/workflow/engine.ts:70`

**原因**:

- 创建 DagEngine 时未提供 executor 参数

**解决**:

```typescript
const engine = new DagEngine({
  executor: myExecutor,  // 必须提供
  steps: [...],
});
```

---

### WF_002 - 重复步骤 ID

**错误信息**: `duplicate step id: {id}`

**位置**: `backend/core/src/workflow/engine.ts:89`

**原因**:

- 工作流定义中有重复的步骤 ID

**解决**:

- 检查步骤定义,确保每个步骤 ID 唯一

---

### WF_003 - 未知 Agent 引用

**错误信息**: `unknown agentRef: {ref}`

**位置**: `backend/core/src/workflow/engine.ts:99`

**原因**:

- 步骤引用了未注册的 Agent

**解决**:

- 确保所有 agentRef 对应的 Agent 已注册
- 检查 Agent 名称拼写

---

### WF_004 - 依赖未知步骤

**错误信息**: `step "{id}" depends on unknown step "{d}"`

**位置**: `backend/core/src/workflow/engine.ts:111`

**原因**:

- 步骤的 dependsOn 引用了不存在的步骤

**解决**:

- 检查依赖关系图
- 确保所有依赖的步骤都存在

---

### WF_005 - 循环依赖

**错误信息**: `workflow contains a dependency cycle`

**位置**: `backend/core/src/workflow/engine.ts:124`

**原因**:

- 工作流步骤间存在循环依赖
- DAG(有向无环图)约束被违反

**解决**:

```typescript
// 错误: 循环依赖
{ id: 'a', dependsOn: ['c'], ... },
{ id: 'b', dependsOn: ['a'], ... },
{ id: 'c', dependsOn: ['b'], ... },  // 形成环

// 正确: DAG结构
{ id: 'a', ... },
{ id: 'b', dependsOn: ['a'], ... },
{ id: 'c', dependsOn: ['a'], ... },
```

---

### WF_006 - 工作流中止

**错误信息**: `workflow aborted`

**位置**: `backend/core/src/workflow/engine.ts:165`

**原因**:

- AbortSignal 被触发
- 用户主动取消

**解决**:

- 检查工作流中止逻辑
- 确认是否需要重新执行

---

## 💬 LLM 错误

### LLM_001 - API 调用失败

**错误信息**: `LLM API error {status} (model={model}): {text}`

**位置**: `backend/core/src/llm/shared.ts:184, 263`

**原因**:

- API Key 无效或过期
- 模型名称错误
- API 额度耗尽
- 网络问题

**解决**:

```bash
# 检查API Key
echo $OPENAI_API_KEY
echo $OPEN_API_KEY

# 测试API连接
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"

# 检查模型名称
# 查看: https://platform.openai.com/docs/models
```

---

### LLM_002 - 流式响应无 Body

**错误信息**: `LLM streaming response has no readable body (model={model})`

**位置**: `backend/core/src/llm/shared.ts:266`

**原因**:

- LLM API 未返回流式响应
- 响应格式不兼容

**解决**:

- 确认模型支持流式输出
- 检查 API 版本

---

### LLM_003 - 缺少 API Key

**错误信息**:

- `OpenAI LLM requires OPENAI_API_KEY`
- `OpenRouter LLM requires OPEN_API_KEY`

**位置**:

- `backend/core/src/llm/openai.ts:33`
- `backend/core/src/llm/openrouter.ts:52`

**解决**:

```bash
# 在 .env 文件中配置
echo "OPENAI_API_KEY=sk-..." >> .env
echo "OPEN_API_KEY=sk-or-..." >> .env

# 或在创建LLM时传入
const llm = createOpenAILLM({ apiKey: 'sk-...' });
```

---

### LLM_004 - 真实模式缺少 Key

**错误信息**: `真实模式需要 OPEN_API_KEY(在 .env 中配置)。可切换到 Mock 模式离线验证。`

**位置**: `access/server/src/runner.ts:294`

**解决**:

```bash
# 方式1: 配置API Key
echo "OPEN_API_KEY=sk-or-..." >> .env

# 方式2: 使用Mock模式测试
# 修改代码切换到mock模式
```

---

## 🎯 技能错误

### SKILL_001 - 技能 ID 为空

**错误信息**: `Skill 必须包含非空 id`

**位置**: `backend/core/src/skills/index.ts:34`

**原因**:

- 注册技能时未提供 id 或 id 为空

**解决**:

```typescript
// 错误
skills.register({ name: 'my-skill' });

// 正确
skills.register({ id: 'my-skill', name: 'my-skill' });
```

---

## 🖥️ 会话错误

### SESSION_001 - 会话未找到

**错误信息**: `session not found`

**位置**: `access/server/src/server.ts:595`

**原因**:

- 会话 ID 不存在或已过期
- 会话可能已被清理

**解决**:

- 检查会话 ID 是否正确
- 查看会话列表

---

## 📦 插件特定错误(医疗客资)

### MA_001 - 号源已满

**错误码**: `CONFLICT` 或 `NOT_FOUND`

**位置**: `plugins/medical-aesthetics-lead/src/services/schedule-service.ts`

**原因**:

- 预约的时段号源已满
- 时段不存在

**解决**:

- 选择其他时段
- 联系管理员增加号源

---

### MA_002 - 线索阶段回退

**现象**: 阶段尝试回退被阻止

**位置**: `plugins/medical-aesthetics-lead/src/repo/lead-repo.ts`

**原因**:

- 线索阶段只能前进,不能回退
- 这是设计行为,防止数据不一致

**解决**:

- 这是正常保护机制
- 如需重新评估,创建新线索

---

### MA_003 - CRM 同步禁用

**现象**: `crmSync: 'disabled'`

**位置**: `plugins/medical-aesthetics-lead/src/services/lead-service.ts`

**原因**:

- 未配置 CRM 系统连接
- 这是正常状态,不影响核心功能

**解决**(可选):

```bash
# 配置CRM
export MA_CRM_API_URL=https://your-crm.com/api
export MA_CRM_API_KEY=your-key
```

---

### MA_004 - HIS 同步禁用

**现象**: `hisSync: 'disabled'`

**位置**: `plugins/medical-aesthetics-lead/src/services/schedule-service.ts`

**原因**:

- 未配置 HIS 系统连接

**解决**(可选):

```bash
# 配置HIS
export MA_HIS_API_URL=https://your-his.com/api
export MA_HIS_API_KEY=your-key
```

---

## 🔍 错误排查 checklist

### 通用排查步骤

1. **检查环境变量**:

   ```bash
   env | grep -E "API_KEY|TOKEN|URL"
   ```

2. **查看详细日志**:

   ```bash
   DEBUG=* pnpm server
   ```

3. **检查服务状态**:

   ```bash
   curl http://localhost:3100/api/state
   ```

4. **查看已注册插件**:

   ```bash
   curl http://localhost:3100/api/plugins
   ```

5. **查看作业列表**:
   ```bash
   curl http://localhost:3100/api/jobs
   ```

### 常见问题快速解决

| 问题               | 快速解决                           |
| ------------------ | ---------------------------------- |
| 401 Unauthorized   | 检查 ADMIN_TOKEN 环境变量          |
| 403 Forbidden      | 检查用户角色和权限                 |
| 404 Not Found      | 检查 ID 是否正确                   |
| 429 Rate Limit     | 降低请求频率                       |
| 500 Internal Error | 查看服务器日志                     |
| 插件未加载         | 检查 plugins/ 目录和 manifest.json |
| LLM 调用失败       | 检查 API Key 和模型名称            |

---

## 📞 获取帮助

如果错误不在文档中,或解决建议无效:

1. **查看 GitHub Issues**: https://github.com/your-org/agent-harness/issues
2. **提交新 Issue**: 包含完整错误信息和复现步骤
3. **查看文档**: docs/ 目录

---

**文档版本**: 0.1.0
**最后更新**: 2026-08-19
