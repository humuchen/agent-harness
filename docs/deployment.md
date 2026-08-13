# 部署文档（自托管）

> 整合自根目录 `DEPLOY.md`，归入统一文档中心 `docs/`。仓库已完成 `packages/ui` → `packages/server`（并拆分为 `server` + `webapp` + `client` + `cli`）的重命名，根 `README.md` / `DEPLOY.md` / `package.json` / `render.yaml` / `Dockerfile` 均已同步更新。
> 配套图：`diagrams/architecture.svg`

核心原则：**所有密钥经 `process.env` 注入（平台 env > `SECRETS_FILE` > 本地 `.env`），真实密钥永不进仓库或镜像。**

---

## 0. 部署目标

对外服务由 **`packages/server`** 的 HTTP+SSE 进程提供（原 `packages/ui` 已重命名为 `packages/server`）。

---

## 1. 本地 Docker Compose（最快上手）

```bash
export OPENROUTER_API_KEY=sk-or-...
export UI_AUTH_TOKEN=$(openssl rand -hex 24)

# 内存模式（单副本，开箱即用）
docker compose up --build

# 带 Redis 运行队列（支持多副本水平扩展）
docker compose --profile redis up --build
```

访问 `http://localhost:4173`。Web 界面（Vite+Lit，位于 `packages/webapp`）由 `packages/server` 同源托管，需先构建 webapp（`pnpm --filter @agent-harness/webapp run build`）；若未构建，`/`（根路径）会返回 500 并提示先构建 webapp。

## 2. Kubernetes（kustomize）

清单位于 `deploy/k8s/`：Namespace / ConfigMap / Secret / Deployment / Service / Ingress / HPA，可选 Redis。

```bash
# 1) 用真实密钥覆盖占位 Secret（建议改用 Sealed Secrets / External Secrets）
kubectl -n agent-harness create secret generic agent-harness \
  --from-literal=UI_AUTH_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=OPENROUTER_API_KEY='sk-or-...' \
  --from-literal=REDIS_URL='redis://redis:6379'

# 2) 修改 deployment.yaml 的 image 与 ingress.yaml 的 host（真实值）

# 3) 应用
kubectl apply -k deploy/k8s
```

校验：

```bash
kubectl -n agent-harness rollout status deployment/agent-harness
kubectl -n agent-harness exec deploy/agent-harness -- \
  node -e "fetch('http://127.0.0.1:4173/api/v1/state').then(r=>process.exit(r.ok?0:1))" && echo "health ok"
```

> 多副本**必须**配 `REDIS_URL`（运行队列后端），否则各副本内存队列互不连通。内置 Redis 为单副本非 HA，生产请用托管 Redis。

## 3. 构建镜像（Dockerfile）

```bash
docker build -t agent-harness:local .
docker run -p 4173:4173 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e UI_AUTH_TOKEN=change-me \
  -e REDIS_URL=redis://redis:6379 \
  agent-harness:local
```

`Dockerfile` 多阶段：
- **build**：`corepack enable` + pnpm 安装并 `pnpm -r build`（拓扑序 core → client → server → webapp → cli）。
- **runtime**：`node:22-bookworm-slim`，非 root 运行，HEALTHCHECK 探活 `/api/v1/state`。

## 4. 镜像 CI（GHCR）

`.github/workflows/docker.yml` 在推送 `dev`/`main` 或 tag 时，构建并推送至 `ghcr.io/<owner>/agent-harness`（标签含 `latest`、分支名、短 SHA、语义 tag）。`GITHUB_TOKEN` 自动获得推送权限。

## 5. 环境变量清单（按场景）

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` / `UI_PORT` | 否 | 监听端口，默认 4173 |
| `UI_HOST` | 否 | 绑定地址，默认 0.0.0.0 |
| `NODE_ENV` | 否 | 设 `production` |
| `UI_AUTH_TOKEN` / `UI_TOKENS` | 生产必填 | Bearer 令牌；留空则开放（仅本地） |
| `UI_CORS_ORIGIN` | 否 | 跨域白名单（逗号分隔） |
| `OPENROUTER_API_KEY` | 真实 LLM 必填 | 留空用内置 Mock LLM 离线运行 |
| `OPENROUTER_MODEL` | 否 | 默认 `openai/gpt-4o-mini` |
| `REDIS_URL` | 多副本必填 | 运行队列后端 |
| `ENV_PLATFORM` | 否 | `harness`(默认,dry-run) / `local`(零依赖真跑) / `k8s`(生产级) |
| `HARNESS_API_KEY` / `ACCOUNT` / `ORG` / `PROJECT` | 接 Harness 时填 | 仅 `ENV_PLATFORM=harness` 且要真拉环境时 |
| `K8S_*` | `k8s` 后端用 | `KUBECONFIG`、镜像、Ingress 模板、TTL |
| `MAX_BODY_BYTES` / `RATE_LIMIT` / `RATE_LIMIT_WINDOW_MS` | 否 | 安全加固（防大报文 / 限流） |
| `AUDIT_LOG` | 否 | 审计落盘路径；留空仅落 stdout(JSON 行) |
| `MEMORY_BACKEND` | 否 | `volatile`(默认) / `file` / `sqlite` |
| `RUN_QUEUE_BACKEND` | 否 | `memory`(默认) / `file` / `redis` |
| `MAX_STEPS` / `MAX_TOOL_RESULT_CHARS` / `CONTEXT_COMPRESSION` / `PROMPT_CACHE` | 否 | 成本与完成率调优 |

完整可注入变量见 `.env.example` 与各 `config.ts` / `secrets.ts`。

## 6. 多平台客户端

服务端暴露稳定 `/api/v1` 契约（JSON + SSE），任意平台用 **`@agent-harness/client`** 消费：
- **Web（Lit+Vite）**：`packages/webapp`（生产产物被 server 同源托管）
- **Node CLI**：`packages/cli`，如 `ah run --mode mock`、`ah env --action create`
- **自定义平台**：`new AgentClient({ baseUrl, token })` 调 `streamRun/streamVerify/streamEnv/getMcpServers/...`

## 7. SSO / 外部身份源

鉴权抽象为可插拔 `Authorizer`，身份源由 `AUTH_PROVIDER` 切换，server 其余代码不变。

| `AUTH_PROVIDER` | 场景 | 令牌形态 | 角色来源 |
|---|---|---|---|
| `token`（默认） | 本地/演示/break-glass | 静态 `UI_TOKENS` / `UI_AUTH_TOKEN` | 令牌→角色映射 |
| `oidc` | IdP 签发 JWT（Keycloak/Okta/Azure AD/Auth0） | `Bearer <JWT>` | JWT 的 groups/roles claim |
| `proxy` | 部署在 SSO/LDAP 网关之后 | 网关注入请求头 | `X-Forwarded-Groups` |

**推荐路径（AUTH_PROVIDER=proxy）**：把服务部署在 SSO 网关（Authelia / OAuth2 Proxy / Keycloak / nginx `auth_request`）之后，认证后注入标准头，本服务据头映射角色，**无需实现任何 LDAP 协议**。可配 `PROXY_HMAC_SECRET` 防伪造。

OIDC 直接对接：客户端拿 IdP 签发的 JWT，以 `Authorization: Bearer <JWT>` 调用；服务端用 JWKS 验签（支持 RS*/PS*/ES*/HS*），自动校验 `iss`/`aud`/`exp`，兼容密钥轮换。前端可经 `GET /api/auth/config` 取回元数据自实现授权码流 + PKCE。

**break-glass**：即使启用 `oidc`/`proxy`，仍可设 `UI_TOKENS` 作静态令牌逃生通道（默认 operator）。

## 8. 部署安全清单（发布公网前）

- [ ] 设置 `UI_AUTH_TOKEN`（或 `UI_TOKENS` 多角色）；未设则开放并告警
- [ ] 设 `UI_CORS_ORIGIN` 白名单（不再回 `*`）
- [ ] 设 `MAX_BODY_BYTES` / `RATE_LIMIT` 防 DoS
- [ ] 设 `AUDIT_LOG` 落盘审计（绝不记录密钥/令牌/MCP 头）
- [ ] 修正 `render.yaml` 的 `startCommand` 为 `packages/server/dist/server.js`
- [ ] 多副本配 `REDIS_URL`；LB 开启 sticky session 获得最顺滑 SSE
- [ ] K8s Secret / `image` / `ingress.host` 部署前替换为真实值（建议 Sealed/External Secrets）
- [ ] `ENV_PLATFORM` 按是否需要真建环境选择 `local` / `k8s`（默认 `harness` 仅 dry-run）

## 9. 密钥管理（外部化）

服务不依赖任何密钥 SDK，所有密钥经 `process.env` 读取，启动早期由 `loadSecrets()`（`packages/server/src/secrets.ts`）统一装配。三种来源优先级从高到低：

1. **平台注入 env**（推荐，最高优先级）— Render / K8s / Docker / systemd 直接注入。
2. **`SECRETS_FILE`（JSON）** — 适配 K8s Secret 挂载 / Docker secret / Render Secret Files。
3. **本地 `.env`** — 仅开发便利，已被 `.gitignore` 忽略。

> 解析失败只告警不中断（`[secrets]` 日志），保证降级可用。多实例各自装配密钥，无共享密钥存储依赖。
