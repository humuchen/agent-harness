---
title: 医美客资 Agent（medical-aesthetics-lead）知识库索引
updated: 2026-08-19
owner: 运营中台
confidence: high
applies_to: [客资转化, 项目咨询, 合规护栏]
source: 内部口径对齐 + 医美行业通用实践
---

# 医美客资 Agent · 知识库索引

本目录存放**静态、跨会话复用的领域知识资产**。注意：客资 Agent 的知识检索**不走文件直读**，
而是走真实数据源——项目知识存 SQLite `ma_project` 表，由 `project_kb_search` 工具检索（见
`src/services/kb-service.ts` / `src/repo/kb-repo.ts` / `src/tools/kb.ts`）。

因此本目录的角色是**知识母版（content source）**，与运行期数据的关系如下：

```
knowledge/（本目录，人工维护的知识母版）
   │  project-catalog.json ──► 运营按 kb-template.csv 10 列整理 ──► POST /kb/import ──► ma_project 表
   │                                                                    （或外部 KB 服务 MA_KB_SOURCE=http 同步）
   ▼
ma_project (SQLite) ──► project_kb_search 工具 ──► Agent 应答（合规描述）
```

**铁律（与插件设计一致）**：源码零内置语料，`ma_project` 空则工具返回 found:false，
绝不回退到本目录或其他硬编码数据。**知识必须显式导入/同步才生效。**

## 知识资产与用途

| 资产                                | 内容                                                       | 用途                                                                                                                                     | 置信度 |
| ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `domain/project-catalog.json`       | 项目库母版：分类/别名/简介/适应症/禁忌/恢复期/价格区间/FAQ | 对齐 `kb-template.csv` 10 列后导入 `ma_project`，供 `project_kb_search` 检索                                                             | medium |
| `compliance/ad-compliance-rules.md` | 医疗广告合规规则与话术替换表                               | 人工审查话术；与 `src/prompts.ts` 合规红线、`@agent-harness/medical-ad-guard` 输出护栏配套                                               | high   |
| `compliance/risk-lexicon.json`      | 机检风险词表（绝对化/保证性表述）                          | 供人工自检；运行时输出拦截由 `@agent-harness/medical-ad-guard`（packages/medical-ad-guard，6 条医疗广告法规则，已在插件 setup 注册）承担 | high   |
| `benchmark/qingdao-market.md`       | 市场区域市场基准、竞争格局                                 | 城市获客决策参考（**待填入调研产物**）                                                                                                   | low    |
| `benchmark/industry-benchmark.json` | 行业参考值 P50/P90                                         | 获客/客单参考（**待核实**）                                                                                                              | low    |
| `metrics/metric-dictionary.md`      | 指标口径字典                                               | 获客 KPI 口径对齐：留资率/预约到店率/到店成交率/CAC（**内容为经营指标初版，需按客资 KPI 复核**）                                         | high   |
| `metrics/funnel-model.md`           | 转化漏斗模型                                               | 曝光 → 留资 → 到店 → 成交 → 复购各环节流失定位                                                                                           | medium |
| `metrics/segmentation.md`           | RFM/客户分层 + 唤醒 SOP                                    | 高价值/沉睡线索跟进策略                                                                                                                  | medium |
| `domain/channel-playbook.md`        | 各渠道特性与打法（抖音/小红书/微信/美团）                  | 渠道识别与话术策略                                                                                                                       | medium |
| `org/org-config.json`               | 机构配置：院区/成本/财年口径                               | 运营侧参考（插件院区权威在 `ma_clinic` 表，本文件为其母版示例）                                                                          | high   |

> 约定：每个知识文件头部带 frontmatter（`confidence`）。`confidence: low` 时引用必须提示
> 用户核实，不得当作事实直接输出。

## 知识导入流程（把知识变成 Agent 可用能力）

1. **项目知识**（核心）：用 `data/kb-template.csv` 的 10 列格式整理项目
   （项目名,分类,别名,简介,适应症,禁忌,恢复期,价格区间,常见问题,来源），然后二选一：
   - 本地：运行 `node scripts/kb-seed.cjs`（把模板/母版写入 `ma_project`，参数化 upsert）；或
   - 线上：`POST /kb/import`（body `{projects:[...]}`，需管理令牌），或配置 `MA_KB_SOURCE=http` 走外部 KB 服务。
2. **院区**：`POST /clinics/import` 写入 `ma_clinic`（预约能力依赖）。
3. **合规**：话术人工审查用 `compliance/`；输出拦截待 `medical-ad-guard` 包落地后接线。
4. 导入后验证：`GET /kb` 应返回项目清单；`project_kb_search` 检索应命中。

## 维护说明

- 新增项目知识：更新 `project-catalog.json`（或直接改 `kb-template.csv`）→ 重跑 seed / 调导入接口。
- 口径变更：同步更新 `metrics/` 与 `org/org-config.json`，避免漂移。
- 版本：以 `updated` 字段记录最后修订日期；重大变更在 git 提交注明。
