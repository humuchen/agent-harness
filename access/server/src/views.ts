/**
 * views：服务端 HTML 渲染层（从 server.ts 单体拆出）。
 *
 * 收敛所有「把数据渲染成 HTML 字符串」的纯函数：OAuth 过渡页、系统错误页、
 * webapp 兜底页、HTML 转义、静态资源 Content-Type 推断、SPA 产物目录探测。
 * 这些函数不依赖 server 的鉴权 / 路由 / 配置常量，只依赖 core 的错误存储 API，
 * 因此可独立测试与维护（见可维护性审计 P2：降低 server.ts 单体规模）。
 */
import type { ServerResponse } from 'node:http';
import { accessSync } from 'node:fs';
import { resolve } from 'node:path';
import { getErrorSummary, getErrorLog, type ErrorRecord } from '@agent-harness/core';

/** Web 前端未构建时的兜底：直接返回 500 并提示先构建前端。 */
export function serveHtml(res: ServerResponse): void {
  res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    'Web 前端未构建，请先构建 webapp：pnpm --filter @agent-harness/webapp run build'
  );
}

/** HTML 转义，防 XSS（错误信息可能含用户 / 第三方内容）。 */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染 OAuth 回调过渡页：成功时展示「正在登录…」动效并自动跳转；
 * 失败时展示错误信息与「回到登录页」按钮。
 * 避免用户在回调期间面对空白页或原始 JSON 错误。
 */
export function renderOAuthTransitionHtml(opts: {
  ok: boolean;
  message: string;
  redirect?: string;
}): string {
  const redirect = opts.redirect || '/';
  const safeMsg = esc(opts.message);
  const safeRedirect = esc(redirect);
  const autoRedirect = opts.ok
    ? `<script>setTimeout(()=>{window.location.href="${safeRedirect}";},1200);</script>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.ok ? '登录成功' : '登录失败'}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f1117;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;}
.card{background:#181b22;border:1px solid #2a2f3a;border-radius:16px;padding:40px 32px;max-width:380px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4);}
.spinner{width:38px;height:38px;border:3px solid #2a2f3a;border-top-color:#6c5ce7;border-radius:50%;margin:0 auto 20px;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
.ok{width:42px;height:42px;margin:0 auto 18px;border-radius:50%;background:#198754;display:flex;align-items:center;justify-content:center;}
.ok::after{content:"";width:12px;height:20px;border-right:3px solid #fff;border-bottom:3px solid #fff;transform:rotate(45deg) translate(-2px,-2px);}
.err{width:42px;height:42px;margin:0 auto 18px;border-radius:50%;background:#dc3545;display:flex;align-items:center;justify-content:center;font-size:26px;color:#fff;font-weight:700;}
h2{font-size:18px;font-weight:600;margin-bottom:8px;}
p{font-size:13px;color:#9ca3af;line-height:1.6;margin-bottom:22px;word-break:break-word;}
.btn{display:inline-block;width:100%;padding:10px 18px;border-radius:8px;background:#6c5ce7;color:#fff;text-decoration:none;font-size:14px;font-weight:500;border:none;cursor:pointer;transition:background .15s;}
.btn:hover{background:#5a4bd6;}
</style>
</head>
<body>
<div class="card">
${opts.ok ? '<div class="ok"></div>' : '<div class="err">×</div>'}
${opts.ok ? '<div class="spinner" style="position:absolute;visibility:hidden;"></div>' : ''}
<h2>${opts.ok ? '登录成功' : '登录失败'}</h2>
<p>${safeMsg}</p>
${opts.ok
  ? `<a class="btn" href="${safeRedirect}">进入工作台</a>`
  : '<button class="btn" onclick="window.location.href=\'/\'">回到登录页</button>'}
</div>
${autoRedirect}
</body>
</html>`;
}

/**
 * 服务端渲染「系统错误」展示页（深色主题，与运行时面板一致）：
 * 顶部数量横幅（错误总数 + 按名称分布），下方逐条明细表格
 * （序号 / 时间 / 级别 / 名称 / 类型 / 消息 / 堆栈+上下文）。
 * 数据与 /api/errors 同源，刷新即重新拉取最新状态。
 */
export function renderErrorsHtml(): string {
  const summary = getErrorSummary();
  const list = getErrorLog({ limit: 500 });
  const pills = Object.entries(summary.byName)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="pill">${esc(k)} <b>${v}</b></span>`)
    .join('');
  const rows = list.length
    ? list
        .slice()
        .reverse()
        .map((e: ErrorRecord, idx: number) => {
          const stack = e.stack
            ? `<details class="stack"><summary>堆栈跟踪</summary><pre>${esc(
                e.stack
              )}</pre></details>`
            : '';
          const ctx =
            e.fields && Object.keys(e.fields).length
              ? `<div class="ctx">上下文：${esc(
                  JSON.stringify(e.fields)
                )}</div>`
              : '';
          return `<tr>
      <td class="num">${list.length - idx}</td>
      <td class="mono">${esc(e.ts)}</td>
      <td><span class="sev sev-${esc(e.severity)}">${esc(
            e.severity
          )}</span></td>
      <td class="name">${esc(e.name)}</td>
      <td class="type">${esc(e.type ?? '-')}</td>
      <td class="msg">${esc(e.message)}</td>
      <td class="extra">${stack}${ctx}</td>
    </tr>`;
        })
        .join('')
    : `<tr><td colspan="7" class="empty">暂无错误记录</td></tr>`;
  const span =
    summary.firstSeen != null && summary.lastSeen != null
      ? `<div class="span">时间跨度：${esc(
          new Date(summary.firstSeen).toISOString()
        )} ~ ${esc(new Date(summary.lastSeen).toISOString())}</div>`
      : '';
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>系统错误 · Agent Harness</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; background: #0B0E14; color: #C9D1D9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #E6EDF3; font-weight: 600; }
  .sub { color: #8B949E; margin: 0 0 18px; }
  .banner {
    background: #121622; border: 1px solid #1F2633; border-radius: 10px;
    padding: 16px 18px; margin-bottom: 16px;
  }
  .count { font-size: 34px; font-weight: 700; color: #FF6B6B; line-height: 1; }
  .count.zero { color: #3FB950; }
  .label { color: #8B949E; margin-left: 8px; font-size: 13px; }
  .pills { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
  .pill { background: #0B0E14; border: 1px solid #1F2633; border-radius: 999px; padding: 4px 12px; font-size: 12px; color: #C9D1D9; }
  .pill b { color: #2997FF; margin-left: 4px; }
  .span { color: #8B949E; margin-top: 10px; font-size: 12px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
  button, .btn {
    background: #1F2633; color: #C9D1D9; border: 1px solid #2A3340; border-radius: 6px;
    padding: 6px 14px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-block;
  }
  button:hover, .btn:hover { background: #2A3340; }
  table { width: 100%; border-collapse: collapse; background: #121622; border: 1px solid #1F2633; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #1A2030; vertical-align: top; }
  th { background: #0E1320; color: #8B949E; font-weight: 600; font-size: 12px; position: sticky; top: 0; }
  tr:last-child td { border-bottom: none; }
  td.num { color: #8B949E; width: 36px; }
  td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.name { font-family: ui-monospace, monospace; font-size: 12px; color: #79C0FF; white-space: nowrap; }
  td.type { font-family: ui-monospace, monospace; font-size: 12px; color: #D2A8FF; white-space: nowrap; }
  td.msg { color: #E6EDF3; }
  .sev { font-size: 11px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .sev-error { background: rgba(255,107,107,0.15); color: #FF8787; }
  .sev-fatal { background: rgba(255,71,87,0.2); color: #FF5252; }
  .stack { margin-top: 6px; }
  .stack summary { cursor: pointer; color: #8B949E; font-size: 12px; }
  .stack pre { margin: 6px 0 0; padding: 10px; background: #0B0E14; border: 1px solid #1A2030; border-radius: 6px; overflow-x: auto; font-size: 11px; color: #8B949E; }
  .ctx { margin-top: 6px; font-size: 11px; color: #6E7681; word-break: break-all; }
  .empty { text-align: center; color: #8B949E; padding: 32px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>系统错误明细</h1>
  <p class="sub">错误数量与每条错误的具体信息（类型 / 消息 / 时间 / 堆栈 / 上下文）同源展示。</p>
  <div class="banner">
    <div><span class="count ${summary.total === 0 ? 'zero' : ''}">${
    summary.total
  }</span><span class="label">条系统错误</span></div>
    ${span}
    <div class="pills">${pills || '<span class="pill">无</span>'}</div>
  </div>
  <div class="toolbar">
    <button onclick="location.reload()">刷新</button>
    <a class="btn" href="/api/errors?format=text" target="_blank">复制为文本报告</a>
    <a class="btn" href="/api/errors?full=1" target="_blank">原始 JSON（全量）</a>
  </div>
  <table>
    <thead><tr><th>#</th><th>时间</th><th>级别</th><th>名称</th><th>类型</th><th>消息</th><th>堆栈 / 上下文</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</body>
</html>`;
}

/** Web SPA 构建产物目录（frontend/webapp/dist）；未构建则返回 null。 */
export function webappDir(): string | null {
  const dir = resolve(__dirname, '..', '..', '..', 'frontend', 'webapp', 'dist');
  try {
    accessSync(dir);
    return dir;
  } catch {
    return null;
  }
}

/** 按扩展名推断静态资源 Content-Type（SPA 资源托管用）。 */
export function contentTypeFor(fp: string): string {
  const ext = fp.slice(fp.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    html: 'text/html; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    ico: 'image/x-icon',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf'
  };
  return map[ext] ?? 'application/octet-stream';
}
