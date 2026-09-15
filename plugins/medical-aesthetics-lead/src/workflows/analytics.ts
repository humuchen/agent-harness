import type { WorkflowDef } from '@agent-harness/core';

/**
 * 运营分析报告工作流（DAG）。
 * 委派 operations-analyst 子 Agent 完成全面运营报表。
 */
export const analyticsReportWorkflow: WorkflowDef = {
  id: 'analytics-report',
  tenantId: '{{tenantId}}',
  steps: [
    {
      id: 'run-analytics',
      agentRef: 'operations-analyst',
      inputMapping: { requirement: 'input' },
    },
  ],
};
