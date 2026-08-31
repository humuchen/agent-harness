# Agent Harness · Kubernetes 部署指南

基于 `deploy/k8s/` 下的 kustomize 清单。两套方案：**本地验证**（用你已构建的 `agent-harness:local` 镜像）与**生产集群**（需镜像仓库 + 域名 + 证书）。

## 0. 前提

- 一个可用的 Kubernetes 集群：
  - **最省事**：Docker Desktop → Settings → Kubernetes → Enable（Windows/Mac 自带）。
  - 或 `kind` / `minikube` / 托管集群（EKS/GKE/AKS）。
- `kubectl` 已安装，`kubectl config current-context` 指向目标集群。
- 镜像：
  - 本地（Docker Desktop 内置 K8s）：先 `docker build -t agent-harness:local .`，local overlay 的 `imagePullPolicy: IfNotPresent` 会让 kubelet 直接走 Docker Desktop 本地镜像代理拉取，**无需** kind load。
  - 本地（kind / minikube）：需先把镜像灌进集群（见下方命令），且 overlay 的 `imagePullPolicy` 要相应调整。
  - 生产：推到 `ghcr.io/<org>/agent-harness:tag`（改 `deploy/k8s/deployment.yaml` 的 image 字段）。

## 1. 本地验证（最快跑通）

```bash
# 1) 若用 kind/minikube，先把本地镜像灌进集群（Docker Desktop 内置 k8s 用 IfNotPresent 直接吃本地镜像，跳过此步）
kind load docker-image agent-harness:local          # kind
minikube cache add agent-harness:local              # minikube

# 2) 应用本地 overlay（Redis 默认开，单副本，NodePort 31473）
kubectl apply -k deploy/overlays/local

# 3) 等所有 Pod Running
kubectl -n agent-harness get pods -w

# 4) 验证健康检查
curl http://localhost:31473/api/state     # 应返回 200 JSON
```

浏览器打开 **http://localhost:31473**，点左侧「运行」即可看到思考 + 结果双栏。
（若 NodePort 不通，改用 `kubectl -n agent-harness port-forward svc/agent-harness 4173:4173`，访问 http://localhost:4173）

## 2. 生产集群

```bash
# 1) 把镜像推到你的仓库，并改 deploy/k8s/deployment.yaml 的 image
#    image: ghcr.io/<your-org>/agent-harness:<tag>

# 2) 用真实密钥重建 Secret（不要直接改 secret.yaml 提交明文）
kubectl -n agent-harness create secret generic agent-harness \
  --dry-run=client -o yaml \
  --from-literal=UI_AUTH_TOKEN='<强随机，如 openssl rand -base64 32>' \
  --from-literal=OPEN_API_KEY='sk-or-...' \
  --from-literal=REDIS_URL='redis://redis:6379' \
  | kubectl apply -f -

# 3) 改 deploy/k8s/ingress.yaml 的 host（如 harness.your-domain.com）与
#    cert-manager.io/cluster-issuer，确认集群有对应 Ingress Controller + Issuer。

# 4) 部署（含 Redis、2~6 副本 HPA）
kubectl apply -k deploy/k8s
```

## 3. 已修复的关键坑（务必知悉）

| 问题               | 旧值                                              | 现状                                                       |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------- |
| 健康检查探针路径   | `/api/v1/state`（早期 404，pod 永远 not-ready）   | 路由入口已将 `/api/v1/*` 重写为 `/api/*`，`/api/v1/state` 与 `/api/state` 均返回 200，否则 Service 收不到流量 |
| Redis 是否默认接入 | `redis.yaml` 被注释、`REDIS_URL=""`（走内存队列） | 已默认启用，`REDIS_URL=redis://redis:6379`，多副本共享队列 |

> 说明：`/api/v1/state` 与 `/api/state` 等价（server 在路由入口统一重写前缀），健康检查二者皆可。Docker 与 K8s 两处都已统一。

## 3.1 生产加固补丁（记忆持久化 + Redis 密码）

- **记忆持久化（决策 A：多副本共享）**：`configmap.yaml` 已设 `MEMORY_BACKEND=file` +
  `MEMORY_DIR=/app/data/memory`，`deployment.yaml` 把 RWX 卷 `agent-harness-data` 挂到
  `/app/data`。所有副本读同一共享卷 → 记忆跨副本一致、pod 重启不丢。
  ⚠️ 该 PVC `accessModes: ReadWriteMany`，**必须**用支持 RWX 的 StorageClass
  （AWS EFS / Azure Files / GCP Filestore / 阿里云 NAS），否则 PVC 一直 Pending。
- **Redis 密码 + AOF**：`redis.yaml` 改为
  `redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes --dir /data`，
  密码取自 Secret 的 `REDIS_PASSWORD`；Secret 的 `REDIS_URL` 同步改为
  `redis://:PASSWORD@redis:6379`。部署前用 `kubectl create secret` 注入真实密码
  （见 secret.yaml 顶部命令），**切勿把真实密钥提交进仓库**。

## 4. 验证清单

- [ ] `kubectl -n agent-harness get pods` 全部 `Running`，且 READY 为 `1/1`
- [ ] `kubectl -n agent-harness logs deploy/agent-harness | grep queue-backend` 出现
      `[queue-backend] using Redis backend (redis://redis:6379)`（Redis 真正接管）
- [ ] `curl http://<入口>/api/state` 返回 200
- [ ] UI 跑一次真实任务：左卡思考 Trace 流式、右卡结果交付物正常

## 5. 多人并发能力

- `deployment.replicas: 2` + `hpa` 自动扩到 6，配合 Redis 共享运行队列，**已满足内部多人低并发**。
- 生产若要对外部多人：补 `UI_AUTH_TOKEN` 鉴权 + Ingress TLS + Redis 持久化（或托管 Redis）。

## 6. 常用运维

```bash
kubectl -n agent-harness get all
kubectl -n agent-harness logs -f deploy/agent-harness
kubectl -n agent-harness rollout restart deploy/agent-harness
kubectl -n agent-harness delete -k deploy/overlays/local   # 清理本地
kubectl -n agent-harness delete -k deploy/k8s                  # 清理生产
```

## 7. 目录结构

```
deploy/k8s/
├── kustomization.yaml      # base：含 redis、2~6 副本 HPA、Ingress
├── namespace.yaml
├── configmap.yaml          # 非敏感配置（端口/限流/平台后端）
├── secret.yaml            # 敏感配置（默认开放 + Redis 已接）
├── deployment.yaml        # 2 副本，探针已修为 /api/state
├── service.yaml           # ClusterIP
├── ingress.yaml           # nginx + cert-manager（生产用）
├── hpa.yaml               # CPU 70% 触发扩缩
├── redis.yaml             # 单副本 Redis + PVC（生产建议换托管）
└── overlays/local/        # 本地验证：agent-harness:local + NodePort 31473 + 单副本
```
