// 零依赖测试（node:test + node:assert）：覆盖从 server.ts 拆出的视图层模块 views.ts。
// 验证拆分后视图函数行为不变、可独立测试（可维护性审计 P2：降低 server.ts 单体规模）。
// 这些函数原为 server.ts 内部定义，现位于独立模块，仅依赖 core 错误存储 API。

const test = require('node:test');
const assert = require('node:assert');
const views = require('../dist/views.js');

test('esc 转义 HTML 特殊字符，防 XSS', () => {
  assert.strictEqual(views.esc('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
  assert.strictEqual(views.esc(null), '');
  assert.strictEqual(views.esc(undefined), '');
  assert.strictEqual(views.esc(42), '42');
});

test('contentTypeFor 按扩展名推断 MIME，未知回落 octet-stream', () => {
  assert.strictEqual(views.contentTypeFor('/x/app.js'), 'text/javascript; charset=utf-8');
  assert.strictEqual(views.contentTypeFor('index.HTML'), 'text/html; charset=utf-8');
  assert.strictEqual(views.contentTypeFor('icon.svg'), 'image/svg+xml');
  assert.strictEqual(views.contentTypeFor('pic.PNG'), 'image/png');
  assert.strictEqual(views.contentTypeFor('weird.xyz'), 'application/octet-stream');
});

test('renderOAuthTransitionHtml 成功态含「登录成功」且消息被转义', () => {
  const html = views.renderOAuthTransitionHtml({ ok: true, message: 'welcome' });
  assert.match(html, /登录成功/);
  assert.match(html, /welcome/);
  // 失败注入的脚本标签必须被转义，不能原样出现
  const evil = views.renderOAuthTransitionHtml({ ok: true, message: '<script>x</script>' });
  assert.ok(!evil.includes('<script>x</script>'), '消息中的脚本不应原样注入');
  assert.match(evil, /&lt;script&gt;/);
});

test('renderOAuthTransitionHtml 失败态含「登录失败」与回登录按钮', () => {
  const html = views.renderOAuthTransitionHtml({ ok: false, message: 'denied' });
  assert.match(html, /登录失败/);
  assert.match(html, /回到登录页/);
});

test('renderErrorsHtml 在空错误存储下也能渲染（不抛、含标题）', () => {
  const html = views.renderErrorsHtml();
  assert.match(html, /系统错误明细/);
  assert.match(html, /暂无错误记录/);
});

test('webappDir 返回 string 或 null（不抛）', () => {
  const d = views.webappDir();
  assert.ok(d === null || typeof d === 'string');
});
