# Agent Harness · 部署总览（决策树）

> 一份文档帮你决定**怎么部署**，以及**点到哪份详细指南**。
> 当前推荐路径：**Docker Compose**（已在本机验证通过）。Kubernetes 清单已就绪，但本机环境暂时无法拉取 K8s 节点镜像，详见下方「路径二」。

---

## 0. 先选场景

| 你的场景 | 推荐路径 | 详细文档 |
|---|---|---|
|| 本机快速试用 / 演示（≤1 人，Mock 即可） | Compose 内存模式 | [./docker-deploy-guide.md](./docker-deploy-guide.md) §2 |
|| **内网多人低并发（推荐你现在的用法）** | Compose + Redis + 鉴权 overlay | [./docker-deploy-guide.md](./docker-deploy-guide.md) §3、§9 |
|| 外部多人 / 高可用 / 弹性扩缩 | Kubernetes | [./k8s-deploy-guide.md](./k8s-deploy-guide.md) |
|| **Vercel 部署** | Vercel Node.js Server | [./vercel-deploy-guide.md](./vercel-deploy-guide.md) |

> **结论**：你这次选的是「内网多人」档，所以主线就是 **Compose + Redis overlay + 强随机令牌**，下面「路径一」给的是完整可直接复制的命令。

---

## 路径一：Docker Compose（当前主用）

### A. 快速试用（内存模式，零配置）

```bash
cd C:\Users\Administrator\Documents\WorkBuddy\App\agent-harness-ts
docker compose up --build -d
# 打开 http://localhost:4173
```

> 两个密钥都留空即 Mock LLM 离线模式，运行时面板交互完整可演示，无需任何密钥。

### B. 内网多人（Redis + 鉴权，推荐）

> 本项目已预置 `.env`（含自动生成的强随机 `UI_AUTH_TOKEN`），可直接用；如需自签：`openssl rand -base64 32`。

```bash
cd C:\Users\Administrator\Documents\WorkBuddy\App\agent-harness-ts

# 停旧容器 + 用 redis overlay 重建（redis profile 会把 REDIS_URL 注入 ui，并强制 UI_AUTH_TOKEN）
docker compose down
docker compose -f docker-compose.yml -f docker-compose.redis.yml --profile redis up --build -d

# 验证 Redis 已接管队列（应出现 using Redis backend）
docker logs agent-harness-ts-ui-1 | grep queue-backend

# 健康端点
curl http://localhost:4173/api/state
```

浏览器打开 **http://localhost:4173**，顶栏「Bearer 令牌」填入 `.env` 里的 `UI_AUTH_TOKEN` 即可使用。

### C. 验证 & 使用

1. `docker ps` → ui / redis 均 `healthy`。
2. 打开 UI → 左侧「运行」→ 输入提示词 → 运行。
3. 左卡「思考 Trace」流式输出，右卡「最终结果」交付物 + 复制/导出/重试。
4. 详见 [./docker-deploy-guide.md](./docker-deploy-guide.md) §6、§7。

---

## 路径二：Kubernetes（✅ 本机已跑通）

`deploy/k8s/` 下已有完整 kustomize 清单（namespace / configmap / secret / deployment / service / ingress / hpa / redis），base 之外平级放了 `deploy/overlays/local` 本地验证 overlay（kustomize 要求 overlay 与 base 平级，否则报 cycle detected）。已修复的致命坑：

- 健康检查探针：早期 `/api/v1/state` 返回 404（pod 永远 not-ready），已在 server 路由入口将 `/api/v1/*` 重写为 `/api/*`，现 `/api/v1/state` 与 `/api/state` 均 200。
- Redis 默认接入、带密码（`REDIS_URL=redis://:PASSWORD@redis:6379`，否则多副本走内存队列）。
- 记忆持久化：RWX 卷 `agent-harness-data` 挂 `/app/data`，`MEMORY_BACKEND=file`，多副本共享、重启不丢（依赖支持 RWX 的 StorageClass）。
- **kustomize 循环**：local overlay 原放在 `deploy/k8s/overlays/local`（base 子目录），引用 base 触发 `cycle detected`，已移至 `deploy/overlays/local`。
- **Service NodePort 丢失**：strategic merge patch 合并 Service port 列表时 `nodePort` 字段被丢，已改为 JSON 6902 patch 显式注入 `31473`。
- **镜像加载**：Docker Desktop 内置 K8s 底层是 kind 节点容器，读不到 `docker images`；local overlay 的 `imagePullPolicy` 必须是 `IfNotPresent`（不是 `Never`），由 kubelet 走 Docker Desktop 本地镜像代理拉取，否则 `ErrImageNeverPull`。宿主机需先 `docker build -t agent-harness:local .`。

完整命令与验证清单见 [./k8s-deploy-guide.md](./k8s-deploy-guide.md)。本地验证步骤：

```bash
docker build -t agent-harness:local .                                  # 先构建本地镜像
kubectl apply -k deploy/overlays/local                                  # 部署
kubectl -n agent-harness get pods -w                                    # 等 Running
kubectl -n agent-harness port-forward svc/agent-harness 4173:4173       # 浏览器开 http://localhost:4173
# 或 Docker Desktop NodePort：http://localhost:31473
```

---

## 共用：运维 & 排错

| 操作 | Compose | K8s | Vercel |
|---|---|---|---|
| 看状态 | `docker ps` | `kubectl -n agent-harness get pods` | `vercel ls` |
| 看日志 | `docker logs -f agent-harness-ts-ui-1` | `kubectl -n agent-harness logs -f deploy/agent-harness` | `vercel logs` |
| 重启 | `docker compose restart` | `kubectl -n agent-harness rollout restart deploy/agent-harness` | `vercel deploy --redeploy` |
| 停止 | `docker compose down` | `kubectl delete -k deploy/k8s` | `vercel rm --prod` |
| 验证 Redis 接管 | `docker logs … \| grep queue-backend` | `kubectl … logs \| grep queue-backend` | N/A（Vercel 單實例）|

**常见坑**（两份指南都有详述）：
- 健康检查必须是 `/api/state`，不是 `/api/v1/state`。
- 纯 `docker compose --profile redis` **不会**连上 Redis，必须用 `docker-compose.redis.yml` overlay。
- `UI_AUTH_TOKEN` 不设在 overlay 模式下会拒绝启动（保护行为）。

---

## 文件地图

```
docker-compose.yml          # base：内存模式单副本
docker-compose.redis.yml    # overlay：Redis 接管队列 + 强制鉴权
.env.example                # 环境变量模板（含全部真实配置项）
.env                        # 本机实际配置（已被 .gitignore 忽略）
deployment-index.md          # 本文件：决策树总入口
docs/
  docker-deploy-guide.md    # Compose 完整流程（从部署到落地使用）
  k8s-deploy-guide.md       # K8s 完整流程（本地 overlay + 生产集群）
deploy/k8s/                 # K8s manifests（base + overlays/local）
| Dockerfile                  | 多阶段构建（已修正健康检查为 /api/state） |
| vercel.json               | Vercel 部署配置（Node.js Server 模式） |
| scripts/vercel-build.sh   | Vercel 預構建腳本（pnpm monorepo 全構建 + 產物驗證） |
```
