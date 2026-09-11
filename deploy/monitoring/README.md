# 监控与告警（Prometheus + Grafana）

把 agent-harness 的运行态从「需要手工 curl `/api/metrics`」升级为**开箱即用的可视化监控栈**。

## 为什么

agent-harness 已经暴露了完整的运行指标与告警能力，但此前缺少「交付即用」的采集与展示层：

| 已有能力 | 此前缺口 | 本目录补齐 |
| --- | --- | --- |
| `GET /api/metrics`（JSON 快照） | 无时序存储，无法看趋势 | Prometheus 定时抓取 |
| `GET /api/metrics/prometheus`（文本指标，无需令牌） | 无采集配置 | `prometheus.yml` 抓取任务 |
| `emitAlert` + `ALERT_WEBHOOK_URL`（应用内告警） | 无规则引擎 | `alert-rules.yml` 规则集 |
| `GET /api/errors`（错误明细） | 无可视化 | Grafana 看板面板 |

## 快速开始

```bash
# 在仓库根目录执行（会同时启动 ui + prometheus + grafana + alertmanager）
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml --profile monitoring up -d

# 打开
#   Grafana        http://localhost:3000   （admin / admin，首次登录请改密）
#   Prometheus     http://localhost:9090
#   Alertmanager   http://localhost:9093
```

Grafana 首次启动即自动装配好数据源与看板（`Agent Harness · 运行总览`），无需手工导入。

告警投递需指定 webhook 地址：

```bash
ALERTMANAGER_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/xxxx' \
GRAFANA_ADMIN_PASSWORD='强口令' \
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml --profile monitoring up -d
```

未配置 webhook 时，告警仍会在 Prometheus / Alertmanager UI 可见，只是不对外投递。

## 目录结构

```
deploy/monitoring/
├─ prometheus.yml                                  # 抓取配置（目标 ui:4173 /api/metrics/prometheus）+ 告警路由
├─ alert-rules.yml                                 # 告警规则（可用性/可靠性/容量/成本）
├─ alertmanager.yml                                # 告警分组 / 抑制 / 投递通道
└─ grafana/
   ├─ provisioning/
   │  ├─ datasources/prometheus.yml                # 数据源（uid=prometheus）
   │  └─ dashboards/dashboards.yml                 # 看板装载器
   └─ dashboards/agent-harness.json                # 运行总览看板（11 面板）
```

## 采集的指标

全部来自 `/api/metrics/prometheus`：

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `harness_queue_pending` | gauge | 排队中的任务数 |
| `harness_queue_processing` | gauge | 正在执行的任务数 |
| `harness_run_success_total` | counter | 累计成功 run |
| `harness_run_failed_total` | counter | 累计失败 run |
| `harness_guardrail_blocked_total` | counter | 护栏拦截次数 |
| `harness_os_sandbox_degraded_total` | counter | OS 沙箱降级次数 |
| `harness_errors_total` | counter | 累计错误数 |
| `harness_tokens_total` | counter | 累计 token 用量 |
| `harness_cost_total` | gauge | 累计 LLM 成本 |

## 看板面板

`Agent Harness · 运行总览`（uid `ah-overview`，30s 自动刷新，默认展示近 6 小时）：

- **总览**：服务可用性 / Run 成功率（10m） / 队列积压 / 累计成本
- **吞吐与队列**：运行队列深度（排队 vs 执行） / Run 速率（成功 vs 失败）
- **成本与用量**：Token 消耗速率 / 累计成本趋势
- **安全与可靠性**：护栏拦截 / 错误速率 / OS 沙箱降级

## 告警规则

`alert-rules.yml` 内置四组规则（阈值请按实际流量调整）：

| 规则 | 触发条件 | 级别 |
| --- | --- | --- |
| `AgentHarnessDown` | 抓取失败持续 1m | critical |
| `AgentHarnessHighFailureRate` | run 失败率 > 20% 持续 10m | warning |
| `AgentHarnessErrorSpike` | 错误速率 > 1/s 持续 10m | warning |
| `AgentHarnessGuardrailSpike` | 护栏拦截 > 0.5/s 持续 10m | warning |
| `AgentHarnessSandboxDegraded` | 15m 内出现沙箱降级 | warning |
| `AgentHarnessQueueBacklog` | pending > 50 持续 5m | warning |
| `AgentHarnessQueueStuck` | 有执行中任务但 10m 无完成 | critical |
| `AgentHarnessCostHigh` | 累计成本 > 100 持续 15m | warning |
| `AgentHarnessTokenBurnRate` | token 消耗 > 50 万/小时 持续 15m | warning |

### 告警链路（Prometheus → Alertmanager → Webhook）

本栈**已内置 Alertmanager**，完整链路：

```
alert-rules.yml（规则判定） → Prometheus → Alertmanager（分组/抑制/去重） → ALERTMANAGER_WEBHOOK_URL
```

- **分组**：按 `alertname + severity` 聚合，避免告警风暴；
- **抑制**：critical firing 时抑制同 `alertname` / 同 `service` 的 warning（避免衍生告警刷屏）；
- **分级节奏**：critical 10s 聚合 / 1h 重复；warning 30s / 4h；info 30s / 12h；
- **投递**：`ALERTMANAGER_WEBHOOK_URL` 可指向飞书 / 钉钉 / 企业微信群机器人或自研网关。

> 注意：Alertmanager 的 webhook 载荷是其**固定 JSON 结构**，不是各 IM 的原生格式。
> 若 IM 侧要求原生结构（如飞书的 `msg_type`），需在中间加一层轻量转发；
> Slack 可用 `alertmanager.yml` 中注释掉的 `slack_configs`（原生兼容，无需中转）。

规则在 Prometheus UI 的 **Alerts** 页可见，通知与静默状态在 Alertmanager UI（`:9093`）可见。

> 与**应用内告警**（`emitAlert` → `ALERT_WEBHOOK_URL`）的分工：前者是「事件级实时推送」
> （如某次 run 失败），后者是「指标级趋势判定」（如失败率持续超标）。两者互补，可同时启用。

## K8s 场景

`deploy/k8s/` 未内置 Prometheus Operator 清单。两种落地方式：

1. **Prometheus Operator**：为 `agent-harness` Service 创建 `ServiceMonitor`，`endpoints.path: /api/metrics/prometheus`，`interval: 15s`。
2. **静态抓取**：把 `prometheus.yml` 的 target 改为 Service DNS（如 `agent-harness.agent-harness.svc.cluster.local:4173`）。

## 停止与清理

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml --profile monitoring down
# 连同监控数据卷一并清理（谨慎：会删除历史指标）
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml --profile monitoring down -v
```
