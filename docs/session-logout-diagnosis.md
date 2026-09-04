# 登录会话提前失效 / 刷新即登出 — 排查与修复报告

> 范围：`access/server`（账户密码鉴权、token 签发/验签、cookie 下发）、`frontend/webapp`（登录 / 会话 bootstrap）。
> 两次排查结论：
> 1. **首轮根因**：账户 token 的 HMAC 签名密钥在运行期不稳定（缺 `AH_AUTH_SECRET` 时每进程随机），导致登录签发的 `ah_auth` cookie 在下一请求/进程重启后验签失败 → `/api/account/me` 401 → 前端强制登出。
> 2. **二次根因（重新发布后仍登出）**：P2 静默续期改动中，把 `ah_auth` 与 `ah_refresh` 两个 cookie **拼接成单个 `Set-Cookie` 头**，违反 HTTP 规范（每个 `Set-Cookie` 头只能设置一个 cookie），导致浏览器/客户端误解析、`/api/account/me` 验签失败 → 刷新即登出。
> 3. **跨重启稳定性**：即便密钥稳定，若进程重启/多副本且未配 `AH_AUTH_SECRET`，每进程随机密钥仍会让旧 cookie 失效。已加持久化兜底密钥。

---

## 1. 首轮根因：签名密钥不稳定

`access/server/src/accounts.ts` 的 `getAuthSecret()` 在缺 `AH_AUTH_SECRET`/`AH_CRYPTO_KEY` 时退化为随机密钥。原实现**每次调用都重新随机** → 登录签发与下次验签密钥不一致 → 必然 401。

**修复（P0a）**：模块级 `cachedSecret` 缓存，同一进程内签发/验签必用同一密钥。

## 2. 二次根因（关键回归）：多 cookie 拼成单一 Set-Cookie 头

登录 / 注册 / `/api/account/refresh` / GitHub·Google OAuth 回调，原本需要**同时下发 `ah_auth` 和 `ah_refresh` 两个 cookie**。P2 改动错误地把它们用 `.join('; ')` 拼成**一个** `Set-Cookie` 头：

```
set-cookie: ah_auth=TOKEN; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800; Expires=...; ah_refresh=REFRESH; HttpOnly; SameSite=Lax; ...
```

HTTP 规范：每个 `Set-Cookie` 头只能携带**一个** cookie。多 cookie 必须用**数组**（Node 会写成多个 `Set-Cookie` 头）。拼接后浏览器会误解析——部分客户端把整串当作 `ah_auth` 的值（含属性串与 refresh 数据），或丢弃 `ah_refresh`，导致下一请求（页面加载/刷新触发的 `/api/account/me`）验签失败 → 401 → 强制登出。

**这正是「重新发布后，登录成功、刷新即被踢出」的直接原因。**

**修复**：新增模块级 `setCookies(...cookies: (string|null)[]): string[]`，所有下发点改为传数组（自动过滤 `null`）：

```ts
'set-cookie': setCookies(
  authCookieValue(req, r.token),
  refreshCookieValue(req, r.refreshToken)
),
```

涉及：`server.ts` 登录(901)、注册(873)、refresh(1041)、GitHub OAuth(1285)、Google OAuth(1539)。`authCookieValue`/`refreshCookieValue` 内部仍用 `parts.join('; ')` 构建**单个** cookie 的属性串（正确）。

## 3. 跨重启稳定性：持久化兜底密钥

即便密钥稳定，若部署**重启进程**或跑**多副本**且未配 `AH_AUTH_SECRET`，每进程随机密钥仍会让旧 cookie 全部失效（重启即登出，正是用户「卡住后刷新登出」的放大器——若卡住是进程崩溃，重启后密钥变了）。

**修复（accounts.ts）**：缺 env 密钥时，生成 64hex 并落盘到 `data/.ah_auth_secret`（与 `accounts.db` 同卷），重启后复用；`AH_AUTH_SECRET`/`AH_CRYPTO_KEY` 仍优先（多副本一致）。`config-schema.ts` 的缺失校验降为 `warnings`（因已有文件兜底，避免 `AH_STARTUP_CRITICAL=1` 下「无 env→报错→启动失败→文件永不被创建」死锁）。

> ⚠️ 持久化文件仅对**单实例 + 持久化文件系统**有效。Render 等 PaaS 默认**临时文件系统**，每次部署得到全新 FS，文件不保留 → 仍必须配置 `AH_AUTH_SECRET` 环境变量（见第 5 节）。

## 4. 验证结果

| 验证项 | 命令 / 方式 | 结果 |
|--------|------------|------|
| access/server 类型检查 | `tsc --noEmit -p access/server/tsconfig.json` | ✅ EXIT 0 |
| access/server 构建 | `tsc -p tsconfig.json` | ✅ dist 已产出 |
| 配置 / 鉴权单测 | `node --test test/config-defaults.test.cjs test/authz.test.cjs` | ✅ 9/9 |
| 登录→/me 集成回归 | `node --test test/server.test.cjs` | ✅ 3 pass / 1 skip |
| **端到端多 cookie**（本次重点） | 注册→登录→`me`→二次 `me`（模拟刷新） | ✅ `Set-Cookie` 返回 **2 个独立头**，`me` 两次均 `ok:true` |
| 密钥持久化 | 登录后检查 `data/.ah_auth_secret` 落盘 | ✅ 文件已生成（64hex） |

## 5. 运维必做（代码改不了，需你/运维执行）

1. **Render Dashboard 真实填入 `AH_AUTH_SECRET=64hex`**：Render 临时 FS 不会保留 `data/.ah_auth_secret`，这是消除「重启/多副本即登出」的最后关卡。本地 `docker compose up` + `.env`/`docker-compose.yml` 已透传，无需此步。
2. 若跑**多副本**（Render 扩到 >1 实例），必须用 `AH_AUTH_SECRET` env 保证跨实例密钥一致（文件兜底层级仅单实例）。
3. 可选加固：`AH_STARTUP_CRITICAL=1`，密钥缺失即启动失败而非静默降级（现已降为 warning，不会阻断启动）。

## 6. 关于「回答到一半卡住」

`/api/run` 与 `/api/chat/stream` 的 SSE 在收到 `error`/`_done` 事件时都会正确 `res.end()` 关闭，**运行错误不会卡住**（会干净结束并提示）。因此「答到一半卡住」更可能是 **LLM 流中段挂起**（provider 不再发 token 但连接未关，无 `_done`）或进程在生成中崩溃——属 provider/网络层或 `backend/core` 流式客户端问题，需另立项排查。本次的会话修复保证：即便发生卡顿/崩溃，只要密钥稳定（已配 `AH_AUTH_SECRET` 或单实例持久化文件），刷新后用户**仍保持登录**，不会被踢出。
