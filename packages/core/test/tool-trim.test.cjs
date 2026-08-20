'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compactToolSchema } = require('../dist/llm/shared.js');

test('compactToolSchema 短描述原样保留', () => {
  const t = { name: 'add', description: '求和', parameters: { type: 'object', properties: {} } };
  const out = compactToolSchema(t, 160);
  assert.equal(out.description, '求和');
  assert.equal(out.name, 'add');
});

test('compactToolSchema 超长描述被截断并加省略号', () => {
  const long = 'a'.repeat(300);
  const t = { name: 'big', description: long, parameters: { type: 'object', properties: {} } };
  const out = compactToolSchema(t, 160);
  assert.ok(out.description.endsWith('…'), '应以省略号结尾');
  assert.ok(out.description.length <= 160, `长度应<=160，实际 ${out.description.length}`);
});

test('compactToolSchema 递归压缩 parameters 内 property 描述', () => {
  const t = {
    name: 'search',
    description: 'ok',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'b'.repeat(200) },
        nested: {
          type: 'object',
          properties: {
            deep: { type: 'string', description: 'c'.repeat(200) },
          },
        },
      },
    },
  };
  const out = compactToolSchema(t, 80);
  const props = out.parameters.properties;
  assert.ok(props.q.description.endsWith('…'));
  assert.ok(props.q.description.length <= 80);
  assert.ok(props.nested.properties.deep.description.endsWith('…'));
});

test('compactToolSchema maxDesc<=0 不截断', () => {
  const t = { name: 'x', description: 'a'.repeat(300), parameters: { type: 'object', properties: {} } };
  const out = compactToolSchema(t, 0);
  assert.equal(out.description.length, 300);
});
