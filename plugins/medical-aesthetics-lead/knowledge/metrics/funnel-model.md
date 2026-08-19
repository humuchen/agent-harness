---
title: 转化漏斗标准模型
updated: 2026-08-19
owner: 运营中台
confidence: medium
applies_to: [经营分析, 运营决策]
source: 医美行业通用漏斗；字段映射自 channels.csv / orders.csv
---

# 转化漏斗标准模型（曝光 → 留资 → 到店 → 成交 → 复购）

标准五层漏斗，用于定位流失最严重的环节并给优化建议。

```
曝光(impressions)
   │  曝光→留资率  = leads / impressions        【当前缺 impressions 字段】
   ▼
留资(leads)            ← channels.leads
   │  留资→到店率  = arrivals / leads
   ▼
到店(arrivals)         ← channels.arrivals
   │  到店→成交率  = deals / arrivals
   ▼
成交(deals)           ← channels.deals / orders
   │  成交→复购率  = 复购客户 / 成交客户
   ▼
复购(retention)        ← members + orders 跨期
```

## 各环节可计算性（基于现有数据）

| 环节 | 是否可算 | 数据来源 | 缺口 |
|------|----------|----------|------|
| 曝光→留资 | ❌ 不可算 | 需 impressions | 补投放平台曝光数据 |
| 留资→到店 | ✅ | channels.leads→arrivals | — |
| 到店→成交 | ✅ | channels.arrivals→deals | — |
| 成交→复购 | ⚠️ 近似 | members + orders 跨期 | 需订单时间跨度>1周期 |
| 新客→老客 | ✅ | orders.is_new_customer | — |

## 参考区间（低置信度，待 benchmark 核实）

| 环节 | 行业参考区间 | 说明 |
|------|--------------|------|
| 留资→到店率 | 25%–45% | 渠道差异大，抖音偏低、转介绍偏高 |
| 到店→成交率 | 20%–35% | 咨询师承接能力决定 |
| 成交→复购率 | 25%–45% | 项目性质影响（光电类复购高） |

> 上表为经验参考，**非本机构实测**，输出时须标注 `confidence: low` 并提示核实。
> 定位流失环节的方法：逐层算转化率，与参考区间和自身历史环比对比，找最大负向缺口。

## 优化动作映射（示例）

- 留资→到店低：强化邀约 SOP、到店礼、企微跟进节奏。
- 到店→成交低：咨询师话术/升单培训、项目组合设计。
- 成交→复购低：私域分层运营（见 `segmentation.md`）、会员权益。
