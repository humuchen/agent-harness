# 自托管部署指南（agent-harness）

agent-harness 是一个 pnpm monorepo，对外服务由 `packages/ui` 的 HTTP+SSE server 提供。
本指南覆盖三种自托管方式：**本地 Docker Compose**、**Kubernetes（kustomize）**、以及镜像 CI。

> 核心原则：所有密钥经 `process.env` 注入（平台 env > `SECRETS_FILE` > 本地 `.env`），真实密钥**永不进仓库或镜像**。

---

## 1. 本地 Docker Compose（最快上手）

```bash
# 可选：在 .env 或环境变量中设置（留空则用 Mock LLM + 内存模式）
export OPENROUTER_API_KEY=sk-or-...
export UI_AUTH_TOKEN=$(openssl rand -hex 24)

# 内存模式（单副本，开箱即用）
docker compose up --build

# 带 Redis 运行队列（支持多副本水平扩展）
docker compose --profile redis up --build
```

访问 `http://localhost:4173`。Web 界面（Vite+Lit）由 server 同源托管；无 webapp 时回退到内置 `public/index.html`。

---

## 2. Kubernetes（kustomize）

清单位于 `deploy/k8s/`，含 Namespace / ConfigMap / Secret / Deployment / Service / Ingress / HPA，可选 Redis。

### 2.1 部署前准备

```bash
# 1) 用真实密钥覆盖占位 Secret（建议改用 Sealed Secrets / External Secrets Operator）
kubectl -n agent-harness create secret generic agent-harness \
  --from-literal=UI_AUTH_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=OPENROUTER_API_KEY='sk-or-...' \
  --from-literal=REDIS_URL='redis://redis:6379'

# 2) 修改 deployment.yaml 的 image 为你的实际镜像与 tag
# 3) 修改 ingress.yaml 的 host 为你的域名，确认集群有对应 Ingress Controller / TLS
```

### 2.2 应用

```bash
# 全部（含可选 Redis，默认 kustomization 未启用 redis，按需取消注释）
kubectl apply -k deploy/k8s

# 或仅核心资源（内存模式）
kubectl apply -f deploy/k8s/namespace.yaml -f deploy/k8s/configmap.yaml \
  -f deploy/k8s/secret.yaml -f deploy/k8s/deployment.yaml \
  -f deploy/k8s/service.yaml -f deploy/k8s/ingress.yaml -f deploy/k8s/hpa.yaml
```

### 2.3 校验

```bash
kubectl -n agent-harness rollout status deployment/agent-harness
kubectl -n agent-harness exec deploy/agent-harness -- \
  node -e "fetch('http://127.0.0.1:4173/api/v1/state').then(r=>process.exit(r.ok?0:1))" && echo "health ok"
```

> 多副本必须配 `REDIS_URL`（运行队列后端），否则各副本内存队列互不连通、断线重连/跨实例事件桥失效。
> 内置 Redis 为单副本非 HA，生产请用托管 Redis（ElastiCache / Memorystore / Azure Cache）。

---

## 3. 构建镜像（Dockerfile）

```bash
docker build -t agent-harness:local .
docker run -p 4173:4173 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e UI_AUTH_TOKEN=change-me \
  -e REDIS_URL=redis://redis:6379 \
  agent-harness:local
```

`Dockerfile` 为多阶段：
- **build**：`corepack enable` + pnpm 安装依赖并 `pnpm -r build`（拓扑序 core → client → ui → webapp）。
- **runtime**：`node:22-bookworm-slim`，非 root 运行，HEALTHCHECK 探活 `/api/v1/state`。

进阶体积精简见 `Dockerfile` 末尾 `pnpm deploy` 注释。

---

## 4. 镜像 CI（GHCR）

`.github/workflows/docker.yml` 在推送 `dev` / `main` 或 tag 时，用 `docker/build-push-action` 构建并推送至
`ghcr.io/<owner>/agent-harness`，标签含 `latest`、分支名、短 SHA 与语义化 tag。
GitHub Actions 的 `GITHUB_TOKEN` 自动获得 GHCR 推送权限，无需额外配置。

---

## 5. 环境变量清单（按场景）

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` / `UI_PORT` | 否 | 监听端口，默认 4173 |
| `UI_HOST` | 否 | 绑定地址，默认 0.0.0.0 |
| `NODE_ENV` | 否 | 设 `production` |
| `UI_AUTH_TOKEN` / `UI_TOKENS` | 生产必填 | Bearer 令牌；留空则开放（仅本地） |
| `UI_CORS_ORIGIN` | 否 | 跨域白名单（逗号分隔），多端客户端需列各端 origin |
| `OPENROUTER_API_KEY` | 真实 LLM 必填 | 留空用内置 Mock LLM 离线运行 |
| `OPENROUTER_MODEL` | 否 | 默认 `openai/gpt-4o-mini` |
| `REDIS_URL` | 多副本必填 | 运行队列后端，如 `redis://redis:6379` |
| `ENV_PLATFORM` | 否 | `harness`(默认,dry-run) / `local`(零依赖真跑) / `k8s`(生产级) |
| `HARNESS_API_KEY` / `HARNESS_ACCOUNT_ID` / `ORG_ID` / `PROJECT_ID` | 接 Harness 时填 | 仅 `ENV_PLATFORM=harness` 且要真拉环境时 |
| `K8S_*` | `k8s` 后端用 | `KUBECONFIG`、镜像、Ingress 主机模板、默认 TTL |
| `MAX_BODY_BYTES` / `RATE_LIMIT` / `RATE_LIMIT_WINDOW_MS` | 否 | 安全加固（防大报文 / 限流） |
| `AUDIT_LOG` | 否 | 审计落盘路径；留空仅落 stdout(JSON 行) |

完整可注入变量见 `packages/ui/src/secrets.ts` 与各 `config.ts`。

---

## 6. 多平台客户端

服务端暴露稳定的 `/api/v1` 契约（JSON + SSE），任意平台用 **`@agent-harness/client`** 即可消费：

- **Web（Vite+Lit）**：`packages/webapp`（生产构建产物被 ui server 同源托管）
- **Node CLI（运维/CI）**：`packages/cli`，命令如 `ah run --mode mock`、`ah env --action create`
- **自定义平台**：直接 `new AgentClient({ baseUrl, token })` 调 `streamRun/streamVerify/streamEnv/getMcpServers/...`

---

## 7. SSO / 外部身份源（OIDC 与 LDAP/SSO 网关）

本服务把鉴权抽象为可插拔的 `Authorizer` 接口，身份源由 `AUTH_PROVIDER` 切换，**server 其余代码（准入网关 / 审批 / 权限矩阵）完全不变**。三种模式：

| `AUTH_PROVIDER` | 适用场景 | 令牌形态 | 角色来源 |
|---|---|---|---|
| `token`（默认） | 本地 / 演示 / break-glass | 静态 `UI_TOKENS` / `UI_AUTH_TOKEN` | 令牌→角色映射 |
| `oidc` | IdP 直接向客户端签发 JWT（Keycloak/Okta/Azure AD/Auth0） | `Authorization: Bearer <JWT>` | JWT 的 groups/roles claim |
| `proxy` | **企业接入 LDAP/SSO 的最低成本路径**：把服务部署在 SSO 网关之后 | 网关注入的请求头 | 头里的 X-Forwarded-Groups |

### 7.1 推荐路径：部署在 SSO/LDAP 网关后（AUTH_PROVIDER=proxy）

绝大多数企业的 LDAP / AD 认证由网关层（Authelia / OAuth2 Proxy / Keycloak / nginx `auth_request` / Traefik forward-auth）完成。
把它们放在本服务之前，认证通过后注入标准头，本服务据头映射角色即可，**无需实现任何 LDAP 协议**：

```bash
# docker-compose.yml / k8s deployment env
AUTH_PROVIDER=proxy
SSO_OPERATOR_GROUPS=agent-harness-ops        # 命中即 operator
SSO_ADMIN_GROUPS=agent-harness-admins        # 命中即 admin（优先级最高）
# 可选但强烈建议：网关用共享密钥对用户名头做 HMAC，防非受信网络伪造
PROXY_HMAC_SECRET=<与网关一致的密钥>
```

反向代理需转发的头（以 nginx 为例）：

```nginx
proxy_set_header X-Forwarded-User      $remote_user;
proxy_set_header X-Forwarded-Email     $remote_user_email;
proxy_set_header X-Forwarded-Groups    $remote_user_groups;   # 逗号分隔
proxy_set_header X-Forwarded-Signature $http_x_signature;    # 网关计算的 HMAC
```

### 7.2 直接对接 OIDC（AUTH_PROVIDER=oidc，Bearer JWT 资源服务器）

客户端（Web/CLI/SDK）拿 IdP 签发的 JWT，直接以 `Authorization: Bearer <JWT>` 调用本服务；服务端用 IdP 的 JWKS 验签，零会话状态。

```bash
AUTH_PROVIDER=oidc
OIDC_ISSUER=https://idp.example.com/realms/agent
OIDC_AUDIENCE=agent-harness
# JWKS 三选一：内联 JSON（最稳）/ 远端 URI（推荐，自动轮换）/ 仅给 issuer 触发发现
OIDC_JWKS_URI=https://idp.example.com/realms/agent/protocol/openid-connect/certs
SSO_ADMIN_GROUPS=agent-harness-admins
SSO_OPERATOR_GROUPS=agent-harness-ops
```

验签支持 RS256/384/512、PS256/384/512、ES256/384/512、HS256/384/512；自动校验 `iss` / `aud` / `exp`，并兼容 IdP 密钥轮换（多 JWKS 逐把尝试验签）。
前端可用 `GET /api/auth/config` 取回 OIDC 元数据（授权端点 / clientId / scopes），自行实现授权码流 + PKCE 后拿 token 调接口。

### 7.3 break-glass 逃生通道

即使启用 `oidc` / `proxy`，仍可同时设置 `UI_TOKENS` / `UI_AUTH_TOKEN`。当 IdP 不可用时，运维可用静态令牌直接鉴权（默认映射 operator），避免被身份源故障锁死。

### 7.4 环境变量速查（SSO 相关）

| 变量 | 说明 |
|---|---|
| `AUTH_PROVIDER` | `token`(默认) / `oidc` / `proxy` |
| `OIDC_ISSUER` / `OIDC_JWKS_URI` / `OIDC_JWKS` | OIDC 发行方 / JWKS 来源（三者取其一即可） |
| `OIDC_AUDIENCE` / `OIDC_CLIENT_ID` | 受众校验 |
| `OIDC_CLIENT_SECRET` | 仅 HS* 对称签名需要 |
| `OIDC_ROLE_CLAIM` | groups/roles 所在 claim（默认 `groups`） |
| `SSO_ADMIN_GROUPS` / `SSO_OPERATOR_GROUPS` / `SSO_VIEWER_GROUPS` | 组→角色映射（OIDC 与 proxy 共用） |
| `SSO_DEFAULT_ROLE` | 无匹配组时的兜底角色（不设则严格拒绝） |
| `PROXY_USER_HEADER` / `PROXY_GROUPS_HEADER` / `PROXY_EMAIL_HEADER` | 网关注入头名 |
| `PROXY_HMAC_SECRET` / `PROXY_HMAC_HEADER` | 头 HMAC 防伪造 |

完整可注入变量见 `.env.example` 的「身份源 / SSO」小节。

