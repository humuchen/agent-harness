---
title: 指标口径字典
updated: 2026-08-19
owner: 运营中台
confidence: high
applies_to: [经营分析, 数据整合]
source: 内部口径对齐；字段映射自 data/members.csv、orders.csv、channels.csv
---

# 指标口径字典（权威定义）

> 所有指标必须「注明口径」再对外输出。公式中的字段名对应当前 `data/` 下的 CSV。
> 金额单位：元（实收）。成本字段 `cost` 为项目成本，用于算毛利。

## 一、经营类

| 指标 | 定义 | 公式（字段映射） | 口径注意 |
|------|------|------------------|----------|
| 营收（实收） | 实际成交金额 | `SUM(orders.amount)` | 区分毛收入与实收；本库默认 amount=实收 |
| 毛利 | 营收减项目成本 | `SUM(orders.amount - orders.cost)` | cost 为项目成本，不含房租/人力 |
| 毛利率 | 毛利 / 营收 | `毛利 / 营收` | 高毛利≠高净利，需提示 |
| 客单价 | 单笔订单均价 | `SUM(orders.amount) / COUNT(orders.order_id)` | 也可按去重客户算 ARPU |
| 项目结构 | 各 `project_category` 营收占比 | 分组聚合 `orders.project_category` | 用于找利润贡献组合 |

## 二、渠道 / 转化类（维度：`channels.csv`）

| 指标 | 定义 | 公式 | 口径注意 |
|------|------|------|----------|
| 留资数 leads | 渠道带来的线索 | `channels.leads` | 当前 CSV 已有 |
| 到店数 arrivals | 实际到店 | `channels.arrivals` | 当前 CSV 已有 |
| 成交数 deals | 渠道成交 | `channels.deals` | 当前 CSV 已有 |
| 到店率 | 到店 / 留资 | `arrivals / leads` | 渠道质量核心指标 |
| 成交率（到店成交） | 成交 / 到店 | `deals / arrivals` | 咨询师承接能力 |
| 留资成交率 | 成交 / 留资 | `deals / leads` | 全链路效率 |
| CAC（线索成本） | 单线索成本 | `channels.spend / leads` | 评估投放效率 |
| CAC（成交成本） | 单成交成本 | `channels.spend / deals` | 更贴近 ROI 决策 |
| 渠道 ROI | 投放回报 | `(归因营收 - spend) / spend` | 需先解决「营收归因到渠道」口径 |

> 缺口：当前 `channels.csv` 无「曝光/impressions」字段，**曝光→留资** 一环无法计算，需补充投放平台的曝光数据。

## 三、客户 / 留存类（维度：`members.csv` + `orders.csv`）

| 指标 | 定义 | 公式 | 口径注意 |
|------|------|------|----------|
| 新客 | 首次成交客户 | `orders.is_new_customer = true` 的首单 | 与 `members.source_channel` 交叉 |
| 老客占比 | 老客 / 总客户 | `1 - 新客数 / 总客户数` | — |
| 复购率 | 有≥2笔订单客户占比 | `COUNT(DISTINCT member_id HAVING COUNT(order_id)>=2) / COUNT(DISTINCT member_id)` | 需跨月口径 |
| 沉睡客户 | 超阈值未到店 | `DATEDIFF(今天, last_visit_date) > 180` | **阈值默认 180 天，见 org-config.json** |
| 沉睡客户率 | 沉睡 / 总客户 | 沉睡数 / `COUNT(members.member_id)` | — |
| LTV（客户生命周期价值） | 预估终身价值 | `ARPU × 预估留存期` 或 `AVG(total_spend)` 近似 | 简化模型，标注假设 |
| 升单率 | 二单>首单客户占比 | 同客户二单金额 > 首单金额 的占比 | 需同客户多单序列 |
| VIP 占比 | VIP 客户占比 | `is_vip = true` 数 / 总客户数 | — |

## 四、输出要求

- 任何一个指标都必须写清「分子/分母用了哪些字段、时间窗口、是否去重」。
- 行业参考值见 `benchmark/industry-benchmark.json`（低置信度，需核实）。
- 口径与 `data/README.md` 冲突时，以本字典为准，并同步修订 `data/README.md`。
