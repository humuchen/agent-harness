// 零依赖测试（node:test + node:assert）：覆盖 P2 manifest 归一化（统一 manifest 形态）。
// - 默认值填充：name/domain/transport/isolation/capabilities/version
// - capabilities 双写法兼容：字符串 → {id}
// - 不修改入参（返回新对象）
// - 缺失 id 抛错

const test = require('node:test');
const assert = require('node:assert');

const { normalizeManifest } = require('../dist/plugin/normalize.js');

test('填充所有默认值', () => {
  const out = normalizeManifest({ id: 'demo' });
  assert.strictEqual(out.id, 'demo');
  assert.strictEqual(out.name, 'demo'); // name 缺省用 id
  assert.strictEqual(out.domain, 'generic');
  assert.strictEqual(out.transport, 'local');
  assert.strictEqual(out.isolation, 'none');
  assert.strictEqual(out.version, '0.0.0');
  assert.deepStrictEqual(out.capabilities, []);
});

test('保留已声明的字段', () => {
  const out = normalizeManifest({
    id: 'cs',
    name: '智能客服',
    domain: 'customer-service',
    transport: 'local',
    isolation: 'os',
    version: '1.2.3',
    capabilities: [{ id: 'chat' }],
    description: 'desc',
    assembly: { systemPrompt: 'x' },
  });
  assert.strictEqual(out.name, '智能客服');
  assert.strictEqual(out.domain, 'customer-service');
  assert.strictEqual(out.isolation, 'os');
  assert.strictEqual(out.version, '1.2.3');
  assert.strictEqual(out.description, 'desc');
  assert.deepStrictEqual(out.assembly, { systemPrompt: 'x' });
  assert.deepStrictEqual(out.capabilities, [{ id: 'chat' }]);
});

test('capabilities 字符串写法自动收敛为 {id}', () => {
  const out = normalizeManifest({ id: 'p', capabilities: ['chat', 'tools'] });
  assert.deepStrictEqual(out.capabilities, [{ id: 'chat' }, { id: 'tools' }]);
});

test('capabilities 混合写法也收敛', () => {
  const out = normalizeManifest({ id: 'p', capabilities: ['chat', { id: 'kb', foo: 1 }] });
  assert.deepStrictEqual(out.capabilities, [{ id: 'chat' }, { id: 'kb', foo: 1 }]);
});

test('不修改入参对象', () => {
  const input = { id: 'p', capabilities: ['chat'] };
  const out = normalizeManifest(input);
  assert.strictEqual(input.name, undefined); // 未被动过
  assert.deepStrictEqual(input.capabilities, ['chat']); // 原样
  assert.notStrictEqual(out.capabilities, input.capabilities);
});

test('缺失 id 抛错', () => {
  assert.throws(() => normalizeManifest({ name: 'no-id' }), /manifest\.id is required/);
});
