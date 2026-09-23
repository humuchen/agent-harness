# agent-harness on EKS — 部署期 Checklist

消费 `harness-env-platform` 的 app-ready 层（EKS + ingress-nginx + cert-manager + efs-sc），
把 agent-harness 跑上 EKS。本清单覆盖所有「代码里是占位 / 需部署期填真实值」的项
（对应 Request 4 的 R1–R8 落地），按序执行，逐项打勾。

> 路径约定：`agent-harness/deploy/k8s`。base 与 EKS overlay 已用规范 `base/` + `overlays/eks/`
> 平级布局（薄 root `kustomization.yaml` 代理到 base），`kubectl kustomize` 已验证可渲染。

---

## 0. 前置：env-platform 已就绪
- [ ] EKS 集群存在，`~/.kube/config` 指向它（或 `aws eks update-kubeconfig`）。
- [ ] `harness-env-platform` 已 apply：`ingress-nginx`（LB）、`cert-manager`、`efs-sc`（RWX StorageClass）就绪。
- [ ] 验证：`kubectl get sc efs-sc` 存在；`kubectl -n ingress-nginx get svc` 有 EXTERNAL-IP。

## 1. R6 对外域名（OAuth 回调 / Let's Encrypt 都依赖）
- [ ] 准备真实域名（如 `harness.acme.io`），A/AAAA 记录解析到 ingress-nginx 的 LB EXTERNAL-IP。
- [ ] 改 `overlays/eks/deploy-config.yaml` 的 `data.host` 为真实域名（**只动这一处**，
       overlay 的 `replacements` 会自动写进 Ingress 的 `spec.rules[0].host` 与 `spec.tls[0].hosts[0]`）。
- [ ] 本地自检：`kubectl kustomize overlays/eks | grep -E 'host:|<你的域名>'` 应出现 3 处。
- [ ] GitHub OAuth App 的 **Authorization callback URL** 设为 `https://<域名>/api/account/oauth/github/callback`
      （GitHub 侧配置，非 k8s）。

## 2. 镜像与 P3 镜像供应链
- [ ] 构建并推送 agent-harness 镜像（CI 推 `:dev`/`:latest`，或私有/ECR）。
- [ ] 改 `base/deployment.yaml` 的 `image` 为实际镜像与 tag（生产建议按 digest 固定）。
- [ ] 若镜像在私有/ECR：`kubectl -n agent-harness create secret docker-registry regcred \
      --docker-server=<ECR>/docker.io --docker-username=... --docker-password=...`
      （命令模板见 `regcred.yaml.example`）。EKS overlay 已给 Deployment 加 `imagePullSecrets: regcred`，
      不建则 apply 会报 Secret 不存在。

## 3. 密钥 Secret（agent-harness）— 含 R4 RAG 令牌
> 用 `kubectl create secret` 注入，**勿提交明文**（`secret.yaml.example` 只含占位）。

- [ ] `OPEN_API_KEY`：OpenRouter Key（留空降级 mock LLM）。
- [ ] `REDIS_URL` / `REDIS_PASSWORD`：如 `redis://:<PASS>@redis:6379`（redis.yaml 已默认部署）。
- [ ] `RAG_API_TOKEN`：RAG 服务单租户令牌（rag.yaml 读取它鉴权）。
- [ ] `MA_RAG_TOKEN`：**须与 `RAG_API_TOKEN` 取相同值** —— agent-harness Pod 调 RAG 服务的 Bearer 令牌
      （medical-aesthetics-lead 插件读 `MA_RAG_TOKEN`）。两值不同 → RAG 调用 401。
- [ ] （可选）`HARNESS_API_KEY` / `HARNESS_ACCOUNT_ID` / `HARNESS_ORG_ID` / `HARNESS_PROJECT_ID`。

```bash
kubectl -n agent-harness create secret generic agent-harness \
  --from-literal=OPEN_API_KEY='sk-or-...' \
  --from-literal=REDIS_URL='redis://:STRONGPASS@redis:6379' \
  --from-literal=REDIS_PASSWORD='STRONGPASS' \
  --from-literal=RAG_API_TOKEN='<rag-secret>' \
  --from-literal=MA_RAG_TOKEN='<rag-secret>'   # 同 RAG_API_TOKEN
```

## 4. R4 RAG 服务（EKS overlay 已接通）
- [ ] EKS overlay 已把 `MA_RAG_BASE_URL=http://rag:8787` 注入 agent-harness ConfigMap
      （仅 EKS；base 不写，保证非 EKS 环境 fail-closed）。
- [ ] 部署 RAG 服务：`kubectl -n agent-harness apply -f rag.yaml`（PVC 用 efs-sc RWX；
      读 `RAG_API_TOKEN` + `RAG_DATA_FILE=/data/rag.jsonl`）。
- [ ] 入库（可选）：`MA_RAG_DATA_FILE=... node plugins/medical-aesthetics-lead/scripts/rag-ingest.cjs`
      把医美项目语料写进 RAG。
- [ ] 自检：Pod 内 `curl -H "Authorization: Bearer $MA_RAG_TOKEN" http://rag:8787/v1/health` 应 200；
      `project_kb_search` 工具应返回 RAG 命中而非空。

## 5. R7 OTel（可选）
- [ ] env-platform 的 OpenTelemetry Collector 已部署（observability 命名空间，OTLP gRPC :4317）。
- [ ] EKS overlay 已注入 `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability.svc.cluster.local:4317`
      等环境变量；端点不可达时 SDK 静默丢弃，不影响业务。

## 5b. P0/P1 可信执行与数据分区（企业级上线必做）

### P0-A：OS 级沙箱门禁
- [ ] 镜像构建时用 `HARNESS_NATIVE_STRICT=1` 编译 native helper（Dockerfile 已默认开启；
      自托管时 `HARNESS_NATIVE_STRICT=1 bash scripts/build-native.sh` 后 `test -x` 校验产物）。
- [ ] Pod 调度到 Linux 节点 + 内核 `user.max_user_namespaces > 0`（`sysctl user.max_user_namespaces`）；
      不满足时 `SHELL_ENABLED=true` 会被静默关闭（`runner.ts` 守卫），日志会出 `error` 级告警。
- [ ] `SHELL_ENABLED=true` + `SHELL_WHITELIST=ls,cat,echo,node,python3`（按业务最小化白名单）；
      `SHELL_REQUIRE_CONFIRM=true` 走 `/api/shell/approve` 审批。
- [ ] `SANDBOX_BACKEND=os`（默认）；不可用环境显式 `SANDBOX_BACKEND=container` + `SANDBOX_IMAGE=node:22-slim`。

### P0-C：出网白名单
- [ ] 生产环境必设 `WEB_FETCH_ALLOWED_DOMAINS`（逗号分隔，支持 `*.example.com` 通配）。
      留空 = 全放行（演示/开发可用）；生产至少把 LLM / RAG / 业务 API 域名列出。
- [ ] 与 NetworkPolicy 叠加：K8s 侧收紧 DNS + 443，应用侧 `WEB_FETCH_ALLOWED_DOMAINS` 做 host 级二次校验。

### P1：租户数据分区
- [ ] 按合规域设 `TENANT_DATA_ZONE`（`general`/`medical`/`financial`），缺省 `general` 保持向后兼容。
      设 `medical` 后 SQLite 文件自动落到 `<dir>/medical/<basename>`（`resolveTenantDbPath`）。
- [ ] `ComplianceProfile.dataResidency=domestic` 的租户务必配 `TENANT_DATA_ZONE=medical` 或 `financial`，
      配合 `audit().dataZone` 字段出合规报表。
- [ ] 多租户生产建议每个合规域一个 DB 文件（物理隔离），而非共享 `./data/app.db`。

## 6. 应用顺序
```bash
kubectl apply -k deploy/k8s            # 薄 root → base（namespace/configmap/secret/deployment/service/ingress/hpa/redis/pvc）
kubectl -n agent-harness apply -f rag.yaml        # RAG 服务（步骤 4）
kubectl apply -k deploy/k8s/overlays/eks          # EKS 加固：Let's Encrypt + regcred + OTel + RAG + FinOps 标签
```
> 若启用出网 NetworkPolicy（需支持 NetworkPolicy 的 CNI）：取消 `overlays/eks/kustomization.yaml`
> 里 `networkpolicy-egress.yaml` 的注释（已收紧为 DNS + 443/80 + redis:6379，非允许所有）。

## 7. 验证
- [ ] `kubectl -n agent-harness get pods` 全 Running（deployment replicas=2，多副本共享 efs-sc RWX）。
- [ ] `kubectl -n agent-harness get certificate` 显示 READY=True（cert-manager 签发 letsencrypt-prod）。
- [ ] `curl -I https://<域名>/api/state` 返回 200（服务端健康检查）。
- [ ] 浏览器打开 `https://<域名>` 走通 GitHub OAuth（回调步骤 1 已配）。
- [ ] R2 多副本登录会话：ingress 已加 cookie 亲和（`ah-session`），不会被其它副本踢。
- [ ] R8 成本：AWS Cost Explorer 按 `finops.cost-center`/`finops.owner`/`finops.env` 标签对账
      （集群侧也需打同样 tag）。

## 备注：已知限制（非阻塞）
- R3 出网 NetworkPolicy 为 opt-in 模板；收紧后需按实际命名空间核对 redis/otel 选择器。
- customer-service 插件的 KB 仍走本地关键词匹配（语义检索「留待 RAG 上游接入」），R4 当前仅
  medical-aesthetics-lead 消费 RAG 服务。
