import type { WorkflowDef } from '@agent-harness/core';

/**
 * 客服会话工作流（DAG 示意）：先「意图分类」再「生成应答」。
 *
 * 这是插件可声明的工作流能力示例：插件仅在 setup 中经 ctx.workflow.validate 校验拓扑合法性，
 * 真正的逐步执行由服务端 /api/workflows 经核心 DagEngine 驱动（复用 core 拓扑分层 / 补偿 / 检查点）。
 *
 * step 的 agentRef 指向本插件注册进 AgentRegistry 的 agentId（'customer-service'），
 * 与 manifest.id 一致——无需手写任何路由代码即可被核心选中执行。
 */
export const conversationWorkflow: WorkflowDef = {
  id: 'cs-conversation',
  steps: [
    {
      id: 'classify',
      agentRef: 'customer-service',
      inputMapping: { prompt: 'input' },
    },
    {
      id: 'respond',
      agentRef: 'customer-service',
      dependsOn: ['classify'],
      inputMapping: { context: 'steps.classify', prompt: 'input' },
    },
  ],
};
