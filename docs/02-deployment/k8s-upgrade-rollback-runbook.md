# agent-harness K8s 升级 / 回滚 Runbook

> 适用部署形态：`kubectl apply -k deploy/k8s/overlays/eks`（kustomize overlay 含 Redis 后端、租户门禁、迁移开关）。
> 本文面向运维 / on-call，命令均可直接复制执行。遇「升级后不可用」优先走 [快速回滚](#3-快速回滚)。

## 0. 前置检查（每次升级前）

```bash
# 1) 确认集群就绪（harness-env-platform 的 app-ready 层）：
kubectl -n agent-harness get pvc agent-harness-data        # 必须已 Bound（RWX，efs-sc）
kubectl -n agent-harness get pods -l app.kubernetes.io/name=redis   # redis-0 Running
kubectl get sc efs-sc                                      # StorageClass 存在

# 2) 确认当前版本与副本健康：
kubectl -n agent-harness get deploy agent-harness
kubectl -n agent-harness get pods -l app.kubernetes.io/name=agent-harness

# 3) 确认 Secret 完整（REDIS_URL / REDIS_PASSWORD / RAG_API_TOKEN 等）：
kubectl -n agent-harness get secret agent-harness -o jsonpath='{.data.REDIS_URL}' | base64 -d && echo

# 4) 升级前备份（宿主机或任一可执行节点）：
AH_BACKUP_DIR=/app/data/backups node scripts/backup-db.cjs --action backup
node scripts/backup-db.cjs --action list     # 记录 backup id，回滚时用
```

⚠️ **严禁**多副本 + 共享卷 SQLite + 内存队列的组合直接上线：base 清单（`deploy/k8s/base`）即为该形态，
生产必须经 `overlays/eks`（已注入 `RUN_QUEUE_BACKEND=redis` / `AGENT_STORE=redis` / `REQUIRE_TENANT=on` / `AH_MIGRATE_AUTO=on`）。

## 1. 标准升级流程

```bash
# 1) 镜像已由 CI 推送（dev 分支 → :dev，main → :latest；生产建议按 digest 固定）。
#    修改 base/deployment.yaml 的 image 为目标 tag/digest 后：

# 2) 渲染并预览变更（不落盘）：
kubectl diff -k deploy/k8s/overlays/eks

# 3) 应用（滚动更新，默认 maxSurge/maxUnavailable 由 Deployment 默认值决定）：
kubectl apply -k deploy/k8s/overlays/eks

# 4) 观察滚动状态与就绪探针：
kubectl -n agent-harness rollout status deploy/agent-harness --timeout=180s
kubectl -n agent-harness get pods -w
```

健康判定（Pod 就绪 ≠ 业务正常，升级后必查）：

```bash
# 就绪/存活探针路径（server.ts 真实端点）：
kubectl -n agent-harness port-forward svc/agent-harness 4173:4173
curl -sf http://127.0.0.1:4173/health/live | jq .
curl -sf http://127.0.0.1:4173/health/ready | jq .    # 含 DB SELECT 1 真探针
# 观察启动日志：构建时间横幅 / [migration] 启动迁移完成 / multi-replica self-check passed
kubectl -n agent-harness logs deploy/agent-harness --tail=50 | grep -E "migration|self-check|🚀"
```

## 2. 升级后验证清单

- [ ] 所有副本 `2/2 Running`，`rollout status` Completed
- [ ] `/health/ready` 返回 ok（数据库探针真实通过）
- [ ] 启动日志含 `multi-replica self-check passed (redis-backed queue/registry)`
- [ ] `AH_MIGRATE_AUTO=on` 时日志含 `[migration] 启动迁移完成`
- [ ] Prometheus 抓取正常：`harness_queue_pending` 有数据；延迟直方图 `harness_latency_*_ms_bucket` 出现
- [ ] 发起一次真实 run 冒烟（若配置了 OPEN_API_KEY）

## 3. 快速回滚

```bash
# 方式 A：回滚 Deployment 镜像（最快，不动配置）
kubectl -n agent-harness rollout undo deploy/agent-harness
kubectl -n agent-harness rollout status deploy/agent-harness --timeout=180s

# 方式 B：回滚到历史 revision
kubectl -n agent-harness rollout history deploy/agent-harness
kubectl -n agent-harness rollout undo deploy/agent-harness --to-revision=<N>

# 方式 C：清单层面回滚（配置也变了，如 configmap-prod-patch）
git checkout <上一个发布 tag/commit> -- deploy/k8s/
kubectl apply -k deploy/k8s/overlays/eks
```

**回滚注意：**

1. **先回镜像、后回配置**：configmap/secret 变更与新镜像耦合时，只回镜像可能因新配置项缺失而异常；反之亦然。先评估变更面（`kubectl diff` 记录）。
2. **迁移已执行不自动回退**：`AH_MIGRATE_AUTO` 只 up 不 down。回滚镜像后旧代码 + 新 schema 通常向前兼容（迁移设计为加列/建表）；确需回滚 schema：`node scripts/db-migrate.cjs down`（**人工确认数据已备份后执行**）。
3. **数据回滚**：从升级前备份恢复——
   ```bash
   node scripts/backup-db.cjs --action restore   # 交互式选择 backup id
   # 或人工：停副本 → 恢复 /app/data 下的 DB 文件 → 重新扩容副本
   kubectl -n agent-harness scale deploy/agent-harness --replicas=0
   # ...恢复文件...
   kubectl -n agent-harness scale deploy/agent-harness --replicas=2
   ```
4. 回滚后同样跑 [验证清单](#2-升级后验证清单)。

## 4. 故障排查速查

| 症状 | 首查 | 处置 |
|---|---|---|
| Pod CrashLoopBackOff | `kubectl logs --previous` | 常见：Secret 缺 REDIS_URL、AH_AUTH_SECRET 未持久化 |
| PVC 一直 Pending | `kubectl get sc` | efs-sc 未安装 / StorageClass 不支持 RWX |
| 多副本自检失败退出 | 启动日志 `multi-replica self-check` | REDIS_URL/REDIS_PASSWORD 错误；修复 Secret |
| 「改了没生效」 | 启动横幅构建时间 + src/dist 告警 | 镜像 tag 冲突；用 digest 固定并重推 |
| Grafana 打不开 | compose 监控栈仅绑 127.0.0.1 | 需反向代理；口令必须显式设 `GRAFANA_ADMIN_PASSWORD` |
| 迁移在容器里没跑 | 日志 `[migration]` | 确认镜像 ≥ 引入 migrations COPY 的版本；`AH_MIGRATE_AUTO=on` |

## 5. 日常运维

```bash
# 备份（默认 AH_BACKUP_ENABLED=on 由进程内调度器执行，落 /app/data/backups，保留 30 天）
node scripts/backup-db.cjs --action list

# 留存清理 / 回滚演练（定期执行，验证备份可用性）
node scripts/cleanup-retention.cjs --dry-run
node scripts/rollback-drill.cjs --action verify
```
