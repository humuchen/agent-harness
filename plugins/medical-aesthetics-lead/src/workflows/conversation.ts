import type { WorkflowDef } from '@agent-harness/core';

/**
 * 医美咨询 + 预约完整工作流（DAG）。
 * 步骤：
 *   analyze-project → pricing-eval → book-consultation → (可选) lead-capture
 */
export const consultationBookingWorkflow: WorkflowDef = {
  id: 'consultation-booking',
  tenantId: '{{tenantId}}',
  steps: [
    {
      id: 'analyze-project',
      agentRef: 'project-advisor',
      inputMapping: { requirement: 'input' },
    },
    {
      id: 'price-eval',
      agentRef: 'pricing-agent',
      dependsOn: ['analyze-project'],
      inputMapping: { projectResult: 'steps.analyze-project.output' },
    },
    {
      id: 'book-consultation',
      agentRef: 'booking-agent',
      dependsOn: ['analyze-project', 'price-eval'],
      inputMapping: {
        projectResult: 'steps.analyze-project.output',
        priceResult: 'steps.price-eval.output',
      },
      compensate: 'cancel-if-any',
    },
  ],
};
