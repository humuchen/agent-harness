/**
 * RAG 检索工具集成测试
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const coreDist = path.join(__dirname, '../../../backend/core/dist/index.js');
const { ToolRegistry, registerRagRetrieve } = require(coreDist);

describe('builtin__rag_retrieve', () => {
  it('RAG_URL 未配置时不应注册工具', () => {
    const orig = process.env.RAG_URL;
    delete process.env.RAG_URL;
    const registry = new ToolRegistry();
    registerRagRetrieve(registry, { baseUrl: '' });
    assert.equal(registry.schemas().length, 0, '应不注册任何工具当 RAG_URL 为空');
    if (orig !== undefined) process.env.RAG_URL = orig;
  });

  it('应注册 builtin__rag_retrieve 工具', () => {
    const orig = process.env.RAG_URL;
    process.env.RAG_URL = 'http://localhost:8787';
    const registry = new ToolRegistry();
    registerRagRetrieve(registry, { baseUrl: 'http://localhost:8787' });
    const schemas = registry.schemas();
    assert.equal(schemas.length, 1, '应注册一个工具');
    assert.equal(schemas[0].name, 'builtin__rag_retrieve');
    if (orig !== undefined) process.env.RAG_URL = orig;
  });

  it('工具参数应包含 query, top_k, score_threshold, trace_id', () => {
    const registry = new ToolRegistry();
    registerRagRetrieve(registry, { baseUrl: 'http://localhost:8787' });
    const schema = registry.schemas()[0];
    const props = schema.parameters.properties;
    assert.ok(props.query, '应有 query 参数');
    assert.ok(props.top_k, '应有 top_k 参数');
    assert.ok(props.score_threshold, '应有 score_threshold 参数');
    assert.ok(props.trace_id, '应有 trace_id 参数');
  });
});
