// 零依赖测试（node:test + node:assert）：覆盖 Request 3 补全的
// defineTool 声明式封装、builtin__weather、builtin__data_transform。
// 直接 require 编译后的 dist 叶子模块，避免引入运行时依赖。
const test = require('node:test');
const assert = require('node:assert');

const { defineTool, ToolRegistry, objectParams } = require('../dist/tools.js');
const { registerWeather } = require('../dist/builtins/weather.js');
const { registerDataTransform } = require('../dist/builtins/datatransform.js');
const { registerBuiltinTools } = require('../dist/builtins/index.js');

/* ------------------------- defineTool ------------------------- */

test('defineTool：合法定义产出可注册工具，注册后可调用', async () => {
  const reg = new ToolRegistry();
  const tool = defineTool({
    name: 'plugin__echo',
    description: 'Echo the input back.',
    parameters: objectParams({ text: { type: 'string' } }, ['text']),
    fn: (args) => String(args.text ?? ''),
    source: 'plugin:demo',
  });
  assert.strictEqual(tool.name, 'plugin__echo');
  assert.strictEqual(tool.schema.source, 'plugin:demo');
  tool.register(reg);
  assert.strictEqual(reg.has('plugin__echo'), true);
  const out = await reg.call('plugin__echo', { text: 'hi' });
  assert.strictEqual(out, 'hi');
});

test('defineTool：非法输入抛错（缺失 name / 空 description / fn 非函数 / 非法字符）', () => {
  assert.throws(() => defineTool({ name: '', description: 'x', fn: () => 1 }));
  assert.throws(() => defineTool({ name: 'a b', description: 'x', fn: () => 1 }));
  assert.throws(() => defineTool({ name: 'ok', description: '  ', fn: () => 1 }));
  assert.throws(() => defineTool({ name: 'ok', description: 'x', fn: 'nope' }));
  assert.throws(() => defineTool(null));
});

/* ----------------------- data_transform ----------------------- */

function newDataReg() {
  const reg = new ToolRegistry();
  registerDataTransform(reg);
  return reg;
}

test('data_transform：csv.parse 带表头与引号转义', async () => {
  const reg = newDataReg();
  const out = await reg.call('builtin__data_transform', {
    operation: 'csv.parse',
    data: 'name,age,note\n"Alice, A","30","say ""hi"""\nBob,25,plain',
  });
  assert.doesNotThrow(() => JSON.parse(String(out)));
  const rows = JSON.parse(String(out));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, 'Alice, A');
  assert.strictEqual(rows[0].note, 'say "hi"');
  assert.strictEqual(rows[1].age, '25');
});

test('data_transform：json.parse 支持点路径抽取', async () => {
  const reg = newDataReg();
  const out = await reg.call('builtin__data_transform', {
    operation: 'json.parse',
    data: JSON.stringify({ a: { b: [1, 2, 3] } }),
    options: { path: 'a.b' },
  });
  assert.deepStrictEqual(JSON.parse(String(out)), [1, 2, 3]);
});

test('data_transform：text.clean 组合清洗', async () => {
  const reg = newDataReg();
  const out = await reg.call('builtin__data_transform', {
    operation: 'text.clean',
    data: '  Hello   <b>World</b>  \n  Hello   <b>World</b>  \n',
    options: { modes: ['trim', 'collapse', 'stripHtml', 'dedupeLines'] },
  });
  assert.strictEqual(String(out), 'Hello World');
});

test('data_transform：aggregate 数值统计与分组', async () => {
  const reg = newDataReg();
  const data = JSON.stringify([
    { dept: 'a', amount: 10 },
    { dept: 'a', amount: 20 },
    { dept: 'b', amount: 5 },
  ]);
  const out = await reg.call('builtin__data_transform', {
    operation: 'aggregate',
    data,
    options: { field: 'amount', metrics: ['count', 'sum', 'avg', 'min', 'max'] },
  });
  const stat = JSON.parse(String(out));
  assert.strictEqual(stat.count, 3);
  assert.strictEqual(stat.sum, 35);
  assert.strictEqual(stat.avg, 35 / 3);
  assert.strictEqual(stat.min, 5);
  assert.strictEqual(stat.max, 20);

  const grouped = await reg.call('builtin__data_transform', {
    operation: 'aggregate',
    data,
    options: { field: 'amount', metrics: ['sum'], groupBy: 'dept' },
  });
  const g = JSON.parse(String(grouped));
  assert.strictEqual(g.totalGroups, 2);
  assert.strictEqual(g.groups.a.sum, 30);
  assert.strictEqual(g.groups.b.sum, 5);
});

test('data_transform：非法输入返回 error 前缀而非抛错', async () => {
  const reg = newDataReg();
  const r1 = await reg.call('builtin__data_transform', { operation: 'aggregate', data: 'not json' });
  assert.match(String(r1), /^error:/);
  const r2 = await reg.call('builtin__data_transform', { operation: 'nope', data: 'x' });
  assert.match(String(r2), /^error:/);
  const r3 = await reg.call('builtin__data_transform', { operation: 'json.parse', data: '{bad' });
  assert.match(String(r3), /^error:/);
});

/* -------------------------- weather --------------------------- */

test('weather：注册与调用返回字符串（离线环境返回 error: 而非抛错）', async () => {
  const reg = new ToolRegistry();
  registerWeather(reg);
  assert.strictEqual(reg.has('builtin__weather'), true);
  // 缺少 location 时直接给出参数校验错误
  const missing = await reg.call('builtin__weather', {});
  assert.match(String(missing), /^error:/);
  // 有 location 时：在线则返回 JSON，离线则返回 error —— 均不得抛异常
  const out = await reg.call('builtin__weather', { location: '上海', days: 1 });
  assert.strictEqual(typeof out, 'string');
  if (!String(out).startsWith('error:')) {
    const parsed = JSON.parse(String(out));
    assert.ok(parsed.place);
    assert.ok(parsed.current);
  }
});

/* --------------------- registerBuiltinTools ------------------- */

test('registerBuiltinTools：默认注册新增工具，可按 tools 收窄、按开关禁用', () => {
  const reg = new ToolRegistry();
  registerBuiltinTools(reg, {});
  assert.strictEqual(reg.has('builtin__weather'), true);
  assert.strictEqual(reg.has('builtin__data_transform'), true);

  const narrowed = new ToolRegistry();
  registerBuiltinTools(narrowed, { tools: ['calculator'] });
  assert.strictEqual(narrowed.has('builtin__weather'), false);
  assert.strictEqual(narrowed.has('builtin__data_transform'), false);
  assert.strictEqual(narrowed.has('builtin__calculator'), true);

  const disabled = new ToolRegistry();
  registerBuiltinTools(disabled, { weatherEnabled: false, dataTransformEnabled: false });
  assert.strictEqual(disabled.has('builtin__weather'), false);
  assert.strictEqual(disabled.has('builtin__data_transform'), false);
});
