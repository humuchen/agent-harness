# 用户自带 LLM 凭据（BYOK）设计方案

> 目标：移除环境中写死的 `OPEN_API_KEY`，改为「每个登录用户自己去 OpenRouter 取 Key → 在 UI 填入 → 加密落库 → 运行期按用户注入」。
> 状态：设计稿（待确认后进入实施）。约束：非侵入式，不引入新依赖，core / server / webapp 零业务耦合不变。

---

## 1. 现状与根因

| # | 现状 | 位置 | 后果 |
|---|------|------|------|
| R1 | `OPEN_API_KEY` 写死在 `.env` / Render 环境变量 | `.env`、`render.yaml:49` | 任何登录用户共用同一把 Key，用平台的钱 |
| R2 | core 三源解析把 `env.OPEN_API_KEY` 作为兜底 | `backend/core/src/llm/config.ts:64` | 只要进程环境有 Key，所有 run 都能跑通 |
| R3 | real 模式硬门槛是 `process.env.OPEN_API_KEY` | `access/server/src/runner.ts:418-422` | 无环境 Key 时全站直接降级 mock |
| R4 | `/api/state` 下发 `openrouter: !!process.env.OPEN_API_KEY` | `server.ts:1895` → `chat.ts:550` | 前端按「全局是否有 Key」决定 real/mock，不是按用户 |
| R5 | `custom_models` 表无 `owner` 列 | `custom-models.ts:119-125` | 自定义模型（含 Key 密文）全体用户共享 |
| R6 | `GET /api/custom-models` 把 `api_key` 密文回传前端，且 AES Key 经 vite define 打进前端 bundle | `custom-models.ts:131-141`、`frontend/webapp/vite.config.ts:17` | 任一用户可解出他人明文 Key（双重泄露） |
| R7 | `modelApiKey` 明文随 job descriptor 持久化 | `queue-backend.ts:29-30` | Key 明文落 Redis / 队列文件 |
| R8 | `OPEN_API_KEY` 在 `ADMIN_API_KEY` 未设时兼任站点 admin 凭证 | `authz.ts:386` | 直接删除环境 Key 会同时打断 admin 逃生通道 |

**结论**：这不是「加一个输入框」的活，而是 4 件事的组合——① 凭据来源从「进程级」下沉到「用户级」；② 鉴权凭证与 LLM 凭证解耦；③ 存储与传输面收敛（服务端加密、密文不出网）；④ 无 Key 时的产品化引导。

---

## 2. 目标 / 非目标

**目标**
- 环境不再需要配置任何 LLM Key，服务仍可正常启动（无 Key = 未就绪，而不是崩溃）。
- 用户在 UI「设置 → 模型服务商」填入自己的 OpenRouter Key，含获取引导（openrouter.ai/keys）与连通性测试。
- Key 按 `owner`（= 登录身份 `AuthContext.sub`）AES-256-GCM 加密落库，同一账号跨设备可用。
- 运行期按发起 run 的用户解析出该用户的 Key，等价替换原 `OPEN_API_KEY` 的作用。
- 未配置 Key 的用户无法消耗平台额度：real 模式请求被结构化拒绝并引导去设置。

**非目标（本期不做）**
- 不做代付 / 计费分账 / 额度售卖。
- 不做把用户 Key 写入 `process.env`（见 §5 决策 D2）。
- 不做 OpenRouter OAuth（PKCE）自动授权——留作 P2 可选增强。

---

## 3. 总体设计：一条「凭据解析链」

所有 LLM 调用凭据统一收敛到一个函数 `resolveRunCredential(owner, req)`，位于 server 层，返回 `{ apiKey, baseUrl, model?, source }`：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 请求指定的自定义模型（`custom_models`，且 `owner` 匹配） | 用户自带任意 OpenAI 兼容端点，现有能力保留 |
| 2 | 该用户的 `user_provider_keys[provider]` | 本方案主链路（OpenRouter / OpenAI / 自定义 provider） |
| 3 | 平台兜底 Key（`PLATFORM_OPEN_API_KEY` + `ALLOW_PLATFORM_KEY=true`） | **默认关闭**；仅用于内部演示 / 灰度，开启时打审计日志 |
| 4 | 无 → `mock` 模式或 `402 provider_key_required` | 前端据此弹「去配置 Key」引导 |

要点：**core 完全不用改**。`resolveOpenRouterConfig` 已经是「配置对象优先 → env 次之」，server 把解析结果作为 `apiKey` 显式传入 `createOpenRouterLLM({ apiKey, baseUrl })`（`runner.ts:429-433` 已有透传链路：server → run-queue → runner → core）。删掉环境变量后，第 2 源自然消失，第 1 源（配置对象）成为唯一入口。

---

## 4. 数据层 Schema（schema-first）

### 4.1 新表 `user_provider_keys`

落在账户库（`ACCOUNT_DB_FILE`，与 `users` 同库，便于按用户级联删除），经 `getDbAdapter` 走 sqlite/turso 双后端：

```sql
CREATE TABLE IF NOT EXISTS user_provider_keys (
  owner             TEXT    NOT NULL,          -- = AuthContext.sub（登录用户名 / SSO subject）
  provider          TEXT    NOT NULL,          -- 'openrouter' | 'openai' | 'custom'
  base_url          TEXT,                      -- 可空：留空用 provider 内置默认端点
  key_cipher        TEXT    NOT NULL,          -- AES-256-GCM(base64: iv|ct|tag)，服务端加密
  key_hint          TEXT    NOT NULL,          -- 掩码回显，如 sk-or-v1-…a91f（只存首尾）
  status            TEXT    NOT NULL DEFAULT 'unverified', -- unverified | valid | invalid
  last_verified_at  INTEGER,
  last_error        TEXT,                      -- 最近一次校验失败原因（脱敏）
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (owner, provider)
);
CREATE INDEX IF NOT EXISTS idx_upk_owner ON user_provider_keys(owner);
```

### 4.2 `custom_models` 补 owner（消除 R5/R6）

```sql
ALTER TABLE custom_models ADD COLUMN owner TEXT;   -- 兼容旧库：NULL 视为 legacy
-- 新主键语义：(owner, id)。SQLite 不支持改主键，采用「新表 + 数据搬迁」或
-- 保留现主键 + 查询层强制 owner 过滤（推荐后者，改动最小、无停机）。
```
迁移策略：旧行 `owner IS NULL` 一次性归属到 `ADMIN_USERNAME`（默认 admin），并在启动日志打印搬迁条数。

### 4.3 加密

复用 `custom-models.ts` 已有的 `encryptApiKey` / `decryptApiKey`（AES-256-GCM，密钥 `AH_CRYPTO_KEY`），但**加密位置从前端上移到服务端**：
- 前端 → 服务端：明文 Key，仅走 HTTPS（生产强制 https，本地 localhost 例外）。
- 服务端 → DB：密文。
- 服务端 → 前端：**只回 `key_hint` / `status`，永不回密文或明文**。
- 因此 `frontend/webapp/vite.config.ts` 的 `__AH_CRYPTO_KEY__` 注入可在 P1 下线，前端 bundle 不再含任何密钥材料。

---

## 5. 关键设计决策

| ID | 决策 | 理由 / 权衡 |
|----|------|-------------|
| D1 | 凭据解析放在 **server 层**，core 保持不动 | core 是纯框架，不该知道「用户」；`config.apiKey` 优先于 env 的现有语义正好是注入点 |
| D2 | **绝不**把用户 Key 写入 `process.env.OPEN_API_KEY` | Node 单进程并发多 run，写 env 必然串号（A 用户的请求用到 B 的 Key）。「映射到 OPEN_API_KEY」在语义上等价实现为 per-run 的 `config.apiKey` 注入 |
| D3 | job descriptor 不再存明文 Key，改存 `credentialRef: { owner, provider }`（或 modelId） | 消除 R7：Key 不落 Redis / 队列文件；worker 领取任务时用 ref 现场解密。多副本部署共享同库即可 |
| D4 | 服务端加密而非前端加密 | 消除 R6；且前端不再需要 AES Key，浏览器侧零密钥材料 |
| D5 | 先设 `ADMIN_API_KEY` 再删 `OPEN_API_KEY` | 消除 R8：否则 admin 逃生通道随环境 Key 一起消失，`/api/run` 等端点直接 401 |
| D6 | `/api/state` 的 `openrouter` 字段升级为 per-user 的 `llm.ready` | 前端 real/mock 判定从「全局」变为「当前用户」；旧字段保留一版做兼容 |
| D7 | Key 校验（`/verify`）走 OpenRouter `GET /api/v1/key`，结果缓存 60s | 避免每次 run 前额外网络往返；run 失败返回 401 时把 status 打回 `invalid` 并通知前端 |

---

## 6. API 契约

| 方法 | 路径 | 权限 | 请求 | 响应 |
|------|------|------|------|------|
| GET | `/api/account/provider-keys` | 登录用户（仅自己） | — | `[{ provider, baseUrl?, keyHint, status, lastVerifiedAt }]` |
| PUT | `/api/account/provider-keys/:provider` | 登录用户 | `{ apiKey, baseUrl? }` | `{ ok:true, keyHint, status }` |
| POST | `/api/account/provider-keys/:provider/verify` | 登录用户 | — | `{ status:'valid'\|'invalid', limit?, usage?, error? }` |
| DELETE | `/api/account/provider-keys/:provider` | 登录用户 | — | `{ ok:true }` |
| GET | `/api/state`（改造） | 现状 | — | 增加 `llm: { ready, source:'user'\|'platform'\|'none', provider, keyHint? }` |

约束：
- 一律以 `ctx.sub` 为 owner，**忽略请求体里的任何 owner/username 字段**（防越权）。
- `provider` 白名单校验（`openrouter` / `openai` / `custom`），非法值 400。
- 审计事件 `account.provider_key.put/delete/verify`，只记 provider + hint，绝不记明文。
- 错误码新增：`provider_key_required`（402）、`provider_key_invalid`（401，来自上游）；登记进 `docs/error-codes.md`。

`/api/run` 侧改造（`server.ts:2016-2033`）：
1. 保留 `body.modelBaseUrl` / `body.modelApiKey`（兼容旧客户端），但**新前端不再传 Key**。
2. 新增：按 `ctx.sub` + `body.model` 调 `resolveRunCredential`；解析失败且 `mode !== 'mock'` → 402 + `{ error:'provider_key_required', hint:'请在设置中配置 OpenRouter API Key' }`。
3. `runner.ts:418` 的守卫由「查 env」改为「查解析结果」，错误文案改为指向 UI 设置页。

---

## 7. 前端设计

**入口（两处，指向同一组件）**
1. 侧栏新增 `设置` tab（`app.ts` 的 tab 路由 + `/settings` 路径），内含「模型服务商」分区。
2. `model-picker` 面板底部「配置 API Key」按钮 → 直接打开同一设置面板（用户当下就在选模型，就地解决）。

**组件 `components/provider-key-settings.ts`**
- 说明文案 + 外链按钮「前往 OpenRouter 获取 Key」→ `https://openrouter.ai/keys`（`target=_blank rel=noopener`），附 3 步图文：注册 → Create Key → 粘贴回来。
- 输入框（`type=password` + 显示/隐藏切换）、保存、测试连通、删除。
- 状态徽标：未配置（灰）/ 已保存待验证（黄）/ 有效（绿，附余额或额度）/ 无效（红，附原因）。
- 保存成功后刷新 `/api/state`，把 chat 的 `mode` 从 mock 切到 real。
- 全部样式走 `--ah-*` 令牌，提示统一走 `notify.*` / `notifyError`（禁止内联红条）。

**Gating 与引导**
- `chat.ts` 发送前置检查：`llm.ready === false` → 拦截发送，`notify.warning` + 就地打开设置面板，不发无效请求。
- 会话顶部持久提示条：「当前使用离线 Mock 模型，配置你的 API Key 后可使用真实模型」+ 跳转按钮。
- run 过程中收到 `provider_key_invalid` → 提示「Key 已失效，请更新」并把设置面板的状态置红。

---

## 8. 分期计划

### P0 —— 主链路可用（本期核心）
| 序 | 任务 | 涉及文件 |
|----|------|----------|
| P0.1 | 环境侧解耦：新增 `ADMIN_API_KEY`（64hex），从 `.env` / Render 移除 `OPEN_API_KEY`；`.env.example` 与部署文档同步改写 | `.env.example`、`render.yaml`、`deploy/k8s/*`、`docs/02-deployment/*` |
| P0.2 | 新建 `provider-keys.ts`：表 DDL + CRUD + 服务端加解密 + 掩码 | `access/server/src/provider-keys.ts`（新） |
| P0.3 | REST 路由 4 个端点 + 审计 + 权限（仅本人） | `provider-keys.ts`、`server.ts`（注册路由） |
| P0.4 | `resolveRunCredential` + `/api/run` 注入 + `runner.ts` 守卫改造 + 402 错误码 | `server.ts`、`runner.ts`、`docs/error-codes.md` |
| P0.5 | `/api/state` 增加 per-user `llm.ready`；`chat.ts:550` 改按 `llm.ready` 判定 | `server.ts`、`frontend/webapp/src/chat.ts` |
| P0.6 | 前端设置组件 + 侧栏 tab + model-picker 入口 + 发送前 gating | `components/provider-key-settings.ts`（新）、`app.ts`、`components/model-picker.ts`、`chat.ts` |

### P1 —— 安全收敛
| 序 | 任务 |
|----|------|
| P1.1 | `custom_models` 加 `owner` + 查询层强制过滤 + 旧数据归属搬迁 |
| P1.2 | `GET /api/custom-models` 不再回传密文（改回 hint）；前端改为「只写不读」 |
| P1.3 | job descriptor 改存 `credentialRef`，执行期现场解密（消除 Redis/文件明文） |
| P1.4 | 下线 `vite.config.ts` 的 `__AH_CRYPTO_KEY__` 注入与 `utils/crypto.ts` 前端加密 |

### P2 —— 增强（可选）
- OpenRouter OAuth PKCE 一键授权（免手工粘贴）。
- per-user 配额与用量看板（复用现有 token/cost 统计 + `tenantId` 聚合）。
- Key 轮换提醒、多 Key 负载/故障转移（复用 `createFailoverLLM`）。

---

## 9. 验证清单

**单测（`node --test`）**
- 加解密往返、掩码生成（不同长度 Key 边界）、非法密文拒绝。
- `resolveRunCredential` 4 级优先级（含平台兜底开/关两种）。
- 越权：A 的 token 读/写 B 的 provider key → 403/空。
- 无 Key + `mode=real` → 402 且不产生任何上游请求。

**集成 / E2E**
- 两个账号各配不同 Key，各自 `/api/run`，断言 `llm:call` 事件里的凭据指纹（hash 前 8 位）互不相同。
- 环境完全不配 `OPEN_API_KEY` 时：服务正常启动、`/api/state.llm.ready=false`、前端显示 mock 且提示配置。
- 保存 → 测试 → run 全链路手测（含跨设备：另一浏览器登录同账号可直接用）。

**构建门禁**
- `tsc -p` 各包通过；`pnpm -r build` 全绿（6/7 workspace）；`pnpm -r test` 无回归。

---

## 10. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 删 `OPEN_API_KEY` 后 admin 通道失效 → 全站 401 | P0.1 必须先设 `ADMIN_API_KEY` 并验证登录，再删旧变量（顺序不可换） |
| 存量用户突然「不能用了」 | 上线首周开 `ALLOW_PLATFORM_KEY=true` 灰度兜底 + 站内提示条，一周后关闭 |
| `AH_CRYPTO_KEY` 轮换导致历史密文不可解 | `key_cipher` 加版本前缀 `v1:`，解密失败标记 `status=invalid` 并提示重填，不静默失败 |
| Render 免费实例临时盘丢库 → Key 丢失 | 账户库需挂持久卷（`ACCOUNT_DB_FILE` 指向卷）；文档中显式写明 |
| 前端仍有旧 bundle 传密文 | 服务端对 `body.modelApiKey` 保留一版兼容解析，日志计数，两周后移除 |

---

## 附：改动面一览（预估）

```
新增  access/server/src/provider-keys.ts
新增  frontend/webapp/src/components/provider-key-settings.ts
改动  access/server/src/server.ts        (路由注册 / /api/run 凭据注入 / /api/state)
改动  access/server/src/runner.ts        (real 模式守卫)
改动  access/server/src/queue-backend.ts (credentialRef, P1)
改动  access/server/src/custom-models.ts (owner 隔离 + 不回传密文, P1)
改动  frontend/webapp/src/chat.ts        (mode 判定 / 发送 gating / 提示条)
改动  frontend/webapp/src/app.ts         (settings tab)
改动  frontend/webapp/src/components/model-picker.ts (配置入口)
改动  .env.example / render.yaml / deploy/k8s/*  (移除 LLM key，新增 ADMIN_API_KEY)
文档  docs/error-codes.md、docs/02-deployment/*
```
