// 回归测试：SSE 写入竞态不得升级为进程崩溃（线上「agent 跑一半就 503」的根因）。
//
// 背景（已复现的确定性缺陷链）：
//   1) res.end() 只是把结束写入内核队列，'close' 事件在之后才**异步**派发；
//      在这个窗口内 closed 仍为 false，到达的事件 / ping 心跳会继续 res.write()
//      到一个已结束的响应上 → 异步 emit ERR_STREAM_WRITE_AFTER_END。
//   2) ServerResponse 的异步 'error' 若无监听器，会冒泡成 uncaughtException。
//      （注意：write 周围的 try/catch 捕获不到异步 error，这是原实现的误判点。）
//   3) crash-guard 对 uncaughtException 执行 process.exit(1) → 平台重启 →
//      重启期间全部在途请求返回 503。
//
// 三层修复对应的断言：
//   - startSse 必须注册 'error' 监听器（第二层冒泡被截断）；
//   - writeSseFrame 必须按 writableEnded / destroyed 短路（第一层竞态被消除）；
//   - isBenignStreamError 必须把流级错误判为良性（第三层不再 exit）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  startSse,
  writeSseFrame,
  endSse,
  isBenignStreamError
} = require('../dist/http-helpers.js');

/**
 * 最小 ServerResponse 替身：只实现 SSE 路径真正用到的面。
 * 刻意让 write() 在 end() 之后**异步** emit error —— 复刻 Node 真实行为
 * （write after end 是异步 error，不是同步 throw）。
 */
function makeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.headers = null;
  res.written = [];
  res.writeHead = (code, headers) => {
    res.headers = { code, headers };
    return res;
  };
  res.write = (chunk) => {
    if (res.writableEnded) {
      // 与 Node 一致：异步派发 error，不同步抛。
      setImmediate(() =>
        res.emit('error', Object.assign(new Error('write after end'), {
          code: 'ERR_STREAM_WRITE_AFTER_END'
        }))
      );
      return false;
    }
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    return res;
  };
  return res;
}

const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('startSse：必须注册 error 监听器（否则异步写错误冒泡成 uncaughtException）', () => {
  const res = makeRes();
  startSse(res);
  assert.ok(
    res.listenerCount('error') >= 1,
    'ServerResponse 未注册 error 监听器：write after end 会冒泡为 uncaughtException → 进程退出 → 503'
  );
});

test('startSse：end 之后再 send 不得抛出、不得产生未消费的 error', async () => {
  const res = makeRes();
  const send = startSse(res);
  send({ type: 'hello' });
  assert.strictEqual(res.written.length, 1);
  assert.ok(res.written[0].startsWith('data: '), 'data 帧格式须保持 data: 前缀');

  // 关键时序：end() 已调用，但 close 事件尚未派发（Node 中二者是异步解耦的）。
  res.end();
  assert.doesNotThrow(() => send({ type: 'late' }));

  // error 已被 startSse 消费：不应冒泡为 uncaughtException。
  await tick();
  assert.strictEqual(res.written.length, 1, 'end 之后不得再写入任何帧');
});

test('writeSseFrame：writableEnded / destroyed / closed 三重守卫各自短路', () => {
  // 守卫 1：end() 已调用但 close 未派发 —— 仅靠 closed 会漏，靠 writableEnded 拦住。
  const a = makeRes();
  a.end();
  writeSseFrame(a, ': ping\n\n', () => false);
  assert.strictEqual(a.written.length, 0, 'writableEnded 后必须短路');

  // 守卫 2：底层套接字已销毁。
  const b = makeRes();
  b.destroyed = true;
  writeSseFrame(b, ': ping\n\n', () => false);
  assert.strictEqual(b.written.length, 0, 'destroyed 后必须短路');

  // 守卫 3：业务侧 closed 标记。
  const c = makeRes();
  writeSseFrame(c, ': ping\n\n', () => true);
  assert.strictEqual(c.written.length, 0, 'closed 后必须短路');

  // 正常路径：帧原样写出（ping 必须是注释帧，不能被包成 data 帧）。
  const d = makeRes();
  writeSseFrame(d, ': ping\n\n', () => false);
  assert.deepStrictEqual(d.written, [': ping\n\n']);
});

test('writeSseFrame：同步抛出的写入异常被吞掉，不外泄', () => {
  const res = makeRes();
  res.write = () => {
    throw new Error('boom');
  };
  assert.doesNotThrow(() => writeSseFrame(res, ': ping\n\n', () => false));
});

test('isBenignStreamError：流级错误判为良性（crash-guard 据此不 exit）', () => {
  // 本次线上故障的实际错误码。
  assert.strictEqual(
    isBenignStreamError(
      Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })
    ),
    true
  );
  assert.strictEqual(isBenignStreamError({ code: 'EPIPE' }), true);
  assert.strictEqual(isBenignStreamError({ code: 'ECONNRESET' }), true);
  assert.strictEqual(isBenignStreamError({ code: 'ERR_STREAM_DESTROYED' }), true);
  // 仅 message 无 code 的运行时也要能识别。
  assert.strictEqual(isBenignStreamError(new Error('write after end')), true);
  assert.strictEqual(isBenignStreamError({ name: 'ERR_STREAM_WRITE_AFTER_END' }), true);
});

test('isBenignStreamError：非流级异常必须判为不可放行（不得削弱崩溃兜底）', () => {
  // 这些说明进程状态可能真的非法，必须维持 process.exit(1)。
  assert.strictEqual(isBenignStreamError(new TypeError('x is not a function')), false);
  assert.strictEqual(isBenignStreamError({ code: 'EACCES' }), false);
  assert.strictEqual(isBenignStreamError(new Error('database connection lost')), false);
  assert.strictEqual(isBenignStreamError(null), false);
  assert.strictEqual(isBenignStreamError(undefined), false);
});

test('源码守护：startSse 不得移除 error 监听器（防止后续重构回退）', () => {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'http-helpers.ts'),
    'utf8'
  );
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const startSseIdx = src.indexOf('export function startSse');
  assert.ok(startSseIdx > 0, '未找到 startSse 定义');
  const startSseBody = src.slice(startSseIdx, src.indexOf('export function', startSseIdx + 10));
  assert.ok(
    /res\.on\('error'/.test(startSseBody),
    'startSse 必须保留 res.on(\'error\')：否则 write after end 会冒泡成 uncaughtException'
  );
  // ping 心跳必须走 writeSseFrame，不得回退成裸 res.write。
  assert.ok(
    !/res\.write\(': ping/.test(src),
    'ping 心跳不得裸调 res.write：须经 writeSseFrame 守卫'
  );
});

test('endSse：先置 closed → 清心跳 → 再 end；writableEnded 后幂等跳过', () => {
  // 正常路径：markClosed 与 clearPing 必须先于 end 执行（窗口期写入被 closed 挡住）。
  const res = makeRes();
  let closed = false;
  let pingCleared = false;
  let order = [];
  res.end = () => {
    order.push('end');
    res.writableEnded = true;
    return res;
  };
  endSse(
    res,
    () => {
      closed = true;
      order.push('closed');
    },
    () => {
      pingCleared = true;
      order.push('ping');
    }
  );
  assert.strictEqual(closed, true, 'endSse 必须置位调用方 closed 标志');
  assert.strictEqual(pingCleared, true, 'endSse 必须清理心跳定时器');
  assert.strictEqual(res.writableEnded, true, 'endSse 必须调用 res.end()');
  assert.deepStrictEqual(order, ['closed', 'ping', 'end'], '收尾顺序铁律：先 closed → 清心跳 → 最后 end');

  // 幂等：已结束的响应重复收尾不得二次 end（避免 ERR_STREAM_ALREADY_FINISHED）。
  const done = makeRes();
  done.writableEnded = true;
  let endCalls = 0;
  done.end = () => {
    endCalls++;
    return done;
  };
  assert.doesNotThrow(() => endSse(done, () => {}));
  assert.strictEqual(endCalls, 0, 'writableEnded 后必须跳过 end()');

  // 同步异常吞掉：收尾失败（连接已断）不得外泄。
  const boom = makeRes();
  boom.end = () => {
    throw new Error('socket gone');
  };
  assert.doesNotThrow(() => endSse(boom, () => {}));
});

test('源码守护：_done 收尾必须走 endSse（时序铁律已收敛为原语，禁止回退手写）', () => {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'run-routes.ts'),
    'utf8'
  );
  // 必须剥离注释再做断言：注释里也出现了 res.end() / endSse 字样，直接匹配会锚到注释。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const doneIdx = src.indexOf("=== '_done'");
  assert.ok(doneIdx > 0, '未找到 _done 收尾分支');
  const branch = src.slice(doneIdx, doneIdx + 700);
  assert.ok(
    /endSse\(\s*res/.test(branch),
    '_done 收尾必须走 endSse 原语（先置 closed 再 end 的手写实现已在 R3 收敛，不得回退）'
  );
  assert.ok(
    /clearInterval\(pingTimer\)/.test(branch),
    '_done 收尾必须清理 pingTimer：否则心跳会在响应结束后继续写入'
  );
  assert.ok(
    !/res\.end\(\)/.test(branch),
    '_done 分支不得裸调 res.end()：必须经 endSse 的 closed 先置位 + 幂等守卫'
  );
});

test('源码守护：endSse 原语本身必须「先置 closed 再 end」且带幂等守卫', () => {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'http-helpers.ts'),
    'utf8'
  );
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fnIdx = src.indexOf('export function endSse');
  assert.ok(fnIdx > 0, '未找到 endSse 定义');
  const body = src.slice(fnIdx, src.indexOf('export function', fnIdx + 10));
  const markIdx = body.indexOf('markClosed()');
  const endIdx = body.indexOf('res.end()');
  const guardIdx = body.indexOf('writableEnded');
  assert.ok(
    markIdx >= 0 && endIdx > markIdx,
    'endSse 必须「先 markClosed() 再 res.end()」：end 到 close 派发的窗口内写入会触发 write after end'
  );
  assert.ok(
    guardIdx >= 0 && guardIdx < endIdx,
    'endSse 必须按 writableEnded/destroyed 幂等短路（重复收尾不得二次 end）'
  );
  const clearIdx = body.indexOf('clearPing?.()');
  if (clearIdx >= 0) {
    assert.ok(clearIdx < endIdx, '心跳清理必须早于 res.end()');
  }
});

test('源码守护：crash-guard 不得对流级错误 process.exit', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'crash-guard.ts'),
    'utf8'
  );
  assert.ok(
    /isBenignStreamError/.test(src),
    'crash-guard 必须用 isBenignStreamError 白名单放行流级错误'
  );
  // 白名单分支内不得出现 process.exit。
  const handler = src.slice(src.indexOf("process.on('uncaughtException'"));
  const benignIdx = handler.indexOf('isBenignStreamError');
  const exitIdx = handler.indexOf('process.exit(1)');
  assert.ok(benignIdx >= 0 && exitIdx > benignIdx, '未找到白名单分支');
  const benignBranch = handler.slice(benignIdx, exitIdx);
  assert.ok(
    !/process\.exit/.test(benignBranch),
    '良性分支内禁止 process.exit：单条 SSE 竞态不得升级为整进程退出'
  );
});