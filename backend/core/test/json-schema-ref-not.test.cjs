'use strict';
// P6.1 回归：json-schema 子集校验器的 not 与 $ref 支持。
//
// 背景：旧实现 `not` 未实现（忽略）、`$ref` 遇到视为通过 —— 工具参数 / step 产出
// 的校验闸门存在逃逸面。修复后：
//  - not：子 schema 校验通过 → 本身报错（语义反转）；
//  - $ref：本地指针 #/definitions/... 与 #/$defs/... 解析后校验（含 ~0/~1 转义、
//    URI 编码段、循环引用由深度护栏兜底）；
//  - 无法解析的 $ref（外部 URL / 指针悬空）→ fail-closed 报错，绝不静默放行。
const test = require('node:test');
const assert = require('node:assert');
const { validateAgainstSchema } = require('../dist/json-schema.js');

test('not：子 schema 通过则本体失败，子 schema 失败则本体通过', () => {
  // { not: string }：非字符串才通过
  assert.strictEqual(validateAgainstSchema(42, { not: { type: 'string' } }).ok, true);
  const v = validateAgainstSchema('hello', { not: { type: 'string' } });
  assert.strictEqual(v.ok, false);
  assert.match(v.errors[0], /not/);
  // not 组合：非空字符串
  const s = { not: { type: 'string', maxLength: 0 } };
  assert.strictEqual(validateAgainstSchema('a', s).ok, true);
  assert.strictEqual(validateAgainstSchema('', s).ok, false);
});

test('$ref：本地 #/definitions 指针解析', () => {
  const schema = {
    type: 'object',
    required: ['id'],
    properties: {
      id: { $ref: '#/definitions/nonEmptyString' },
      tag: { $ref: '#/definitions/nonEmptyString' }
    },
    definitions: { nonEmptyString: { type: 'string', minLength: 1 } }
  };
  assert.strictEqual(validateAgainstSchema({ id: 'a', tag: 'b' }, schema).ok, true);
  const v1 = validateAgainstSchema({ id: '' }, schema);
  assert.strictEqual(v1.ok, false);
  assert.match(v1.errors[0], /^id:.*minLength/);
  const v2 = validateAgainstSchema({ id: 42 }, schema);
  assert.strictEqual(v2.ok, false);
  assert.match(v2.errors[0], /^id:.*类型/);
});

test('$ref：#/$defs 指针 + 数组元素引用', () => {
  const schema = {
    type: 'array',
    items: { $ref: '#/$defs/port' },
    $defs: { port: { type: 'integer', minimum: 1, maximum: 65535 } }
  };
  assert.strictEqual(validateAgainstSchema([80, 443], schema).ok, true);
  assert.strictEqual(validateAgainstSchema([70000], schema).ok, false);
});

test('$ref：~0/~1 转义与循环引用（深度护栏兜底，不挂死）', () => {
  // ~1 转义：属性名本身含 /
  const esc = {
    definitions: { 'a/b': { type: 'string' } },
    $ref: '#/definitions/a~1b'
  };
  assert.strictEqual(validateAgainstSchema('ok', esc).ok, true);
  assert.strictEqual(validateAgainstSchema(42, esc).ok, false);

  // 循环引用：树形结构 schema（node.children 引用自身）
  const tree = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      children: { type: 'array', items: { $ref: '#' } }
    }
  };
  assert.strictEqual(validateAgainstSchema({ name: 'a', children: [{ name: 'b' }] }, tree).ok, true);
  // 根引用自身：校验不挂死（>32 层护栏）
  const deep = { name: 'x' };
  let cur = deep;
  for (let i = 0; i < 40; i++) {
    const next = { name: 'x', children: [cur] };
    cur = next;
  }
  const v = validateAgainstSchema(cur, tree);
  assert.strictEqual(v.ok, false, '超深嵌套应被深度护栏拦下');
});

test('$ref：无法解析的引用 fail-closed（外部 URL / 悬空指针）', () => {
  // 外部 URL 引用：零依赖校验器无法解析 → 必须报错而非静默放行
  const v1 = validateAgainstSchema('anything', { $ref: 'https://example.com/schema.json' });
  assert.strictEqual(v1.ok, false, '外部 $ref 不得静默放行');
  assert.match(v1.errors[0], /\$ref/);

  // 悬空指针：指向不存在的定义
  const v2 = validateAgainstSchema('anything', { $ref: '#/definitions/nope' });
  assert.strictEqual(v2.ok, false, '悬空 $ref 不得静默放行');

  // 非 #/ 开头（纯片段 / 兄弟文档）
  const v3 = validateAgainstSchema('anything', { $ref: 'other.json' });
  assert.strictEqual(v3.ok, false);
});

test('$ref 优先于兄弟键（draft-07 语义）：解析成功时忽略兄弟关键字', () => {
  const schema = {
    $ref: '#/definitions/str',
    type: 'number', // 兄弟键：按 draft-07 应被忽略
    definitions: { str: { type: 'string' } }
  };
  assert.strictEqual(validateAgainstSchema('text', schema).ok, true);
  assert.strictEqual(validateAgainstSchema(42, schema).ok, false);
});

test('回归：既有基础语义不受影响', () => {
  assert.deepStrictEqual(validateAgainstSchema({ a: 1 }, { type: 'object', required: ['a'] }), {
    ok: true,
    errors: []
  });
  assert.strictEqual(validateAgainstSchema(null, { type: ['null', 'string'] }).ok, true);
  assert.strictEqual(validateAgainstSchema('hi', { enum: ['a', 'hi'] }).ok, true);
});
