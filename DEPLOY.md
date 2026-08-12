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
