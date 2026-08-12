/**
 * 业务层 · OpenAPI 规范生成（版本化 REST 契约）。
 *
 * 设计原则（与核心 framework 隔离）：
 * - OpenAPI 文档是「API 契约」，属于业务/运维层，核心不产出。本模块在运行时按需拼装
 *   一份 OpenAPI 3.0 文档（覆盖 JSON 端点；SSE 端点标注为 event-stream），由
 *   GET /api/v1/openapi.json 暴露，便于接入网关 / 代码生成 / 合规审查。
 * - 文档内容与实际路由保持单点来源：server 的路由即契约，这里只做「描述」，不复制逻辑。
 */

interface PathSpec {
  get?: Record<string, unknown>;
  post?: Record<string, unknown>;
  delete?: Record<string, unknown>;
}

function jsonResponse(desc: string, schema?: Record<string, unknown>): Record<string, unknown> {
  return {
    description: desc,
    content: { 'application/json': { schema: schema ?? { type: 'object' } } },
  };
}

function bearer(): Record<string, unknown> {
  return { security: [{ bearerAuth: [] }] };
}

export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, PathSpec> = {
    '/api/v1/state': {
      get: {
        summary: '健康检查（开放，无需令牌）',
        responses: { '200': jsonResponse('服务状态') },
      },
    },
    '/api/v1/metrics': {
      get: {
        summary: '可观测性指标快照（token / 延迟 / 错误 / 成本 / 队列）',
        ...bearer(),
        responses: { '200': jsonResponse('指标'), '401': jsonResponse('未鉴权'), '403': jsonResponse('无权限') },
      },
    },
    '/api/v1/jobs': {
      get: {
        summary: '运行队列脱敏状态（排队/执行数、最近任务）',
        ...bearer(),
        responses: { '200': jsonResponse('队列状态') },
      },
    },
    '/api/v1/sessions': {
      get: {
        summary: '多租户记忆会话列表',
        ...bearer(),
        responses: { '200': jsonResponse('会话 key 与后端类型') },
      },
    },
    '/api/v1/memory': {
      get: {
        summary: '查看某会话记忆（?session=<key>）',
        ...bearer(),
        responses: { '200': jsonResponse('记忆摘要') },
      },
      delete: {
        summary: '清空某会话记忆（需审批）',
        ...bearer(),
        responses: { '202': jsonResponse('已创建审批工单'), '200': jsonResponse('已清空') },
      },
    },
    '/api/v1/roles': {
      get: { summary: '当前 RBAC 权限矩阵概览', ...bearer(), responses: { '200': jsonResponse('矩阵') } },
    },
    '/api/v1/approvals': {
      get: { summary: '审批工单列表', ...bearer(), responses: { '200': jsonResponse('工单列表') } },
    },
    '/api/v1/approvals/{id}': {
      get: { summary: '查看工单', ...bearer(), responses: { '200': jsonResponse('工单') } },
      post: {
        summary: '审批裁决（approve/reject）',
        ...bearer(),
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'reject'] } } } } },
        },
        responses: { '200': jsonResponse('裁决结果') },
      },
    },
    '/api/v1/eval': {
      post: {
        summary: '评估一次运行（body: { jobId }）',
        ...bearer(),
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { jobId: { type: 'string' } } } } } },
        responses: { '200': jsonResponse('评估结果与运行配方') },
      },
    },
    '/api/v1/recipes': {
      get: { summary: '运行配方版本列表', ...bearer(), responses: { '200': jsonResponse('配方列表') } },
      post: {
        summary: '保存运行配方版本（body: { jobId, name }）',
        ...bearer(),
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { jobId: { type: 'string' }, name: { type: 'string' } } } } } },
        responses: { '200': jsonResponse('已保存配方') },
      },
    },
    '/api/v1/recipes/{id}': {
      get: { summary: '查看配方', ...bearer(), responses: { '200': jsonResponse('配方') } },
    },
    '/api/v1/run': {
      post: {
        summary: '提交 Agent 运行（SSE：text/event-stream；需审批时返回 202 + ticketId）',
        ...bearer(),
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { mode: { type: 'string', enum: ['mock', 'real', 'real-mcp'] }, prompt: { type: 'string' }, model: { type: 'string' }, sessionId: { type: 'string' } } } } } },
        responses: { '200': { description: 'SSE 事件流', content: { 'text/event-stream': {} } }, '202': jsonResponse('需审批') },
      },
    },
  };

  return {
    openapi: '3.0.3',
    info: {
      title: 'Agent Harness UI API',
      version: '1.0.0',
      description: 'Agent Harness Playground 的版本化 REST/SSE 契约。未带 /api/v1 前缀的等价路径为兼容别名。',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
