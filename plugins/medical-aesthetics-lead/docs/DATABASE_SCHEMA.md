# 医美客资插件 · 数据库表结构文档

> 由 `scripts/db-schema-doc.cjs` 依据 `src/infra/db.ts` 的 `SCHEMA` 与 `runMigrations` 实时产出。
> 库文件默认 `<MA_DATA_DIR>/ma-lead.db`（sqlite；亦可经 `DB_BACKEND=turso` 切换云端 libSQL）。
> 所有表均带 `tenant_id`，多租户物理隔离。标注 **（推断）** 的字段为按字段名/上下文推断，需人工复核。

共 **17** 张表。

## 表关系总览

- `ma_appointment.lead_id` → `ma_lead.lead_id`
- `ma_appointment.clinic_id` → `ma_clinic.clinic_id`
- `ma_appointment.slot_id` → `ma_slot.slot_id`
- `ma_lead.clinic_id` → `ma_clinic.clinic_id`
- `ma_lead.appointment_id` → `ma_appointment.appointment_id`
- `ma_lead_message.lead_id` → `ma_lead.lead_id`
- `ma_slot.clinic_id` → `ma_clinic.clinic_id`
- `ma_ab_variant.experiment_id` / `ma_ab_assignment.experiment_id` → `ma_ab_experiment.experiment_id`
- `ma_project_intent.project_id` → `ma_project.project_id`
- `ma_schedule_job.lead_id` → `ma_lead.lead_id`

---

## ma_lead

**用途**：客资线索主表（业务系统记录，system of record）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `lead_id` | TEXT | 是 | — | 是 (PK) | 线索唯一标识（业务主键，由系统生成或外部渠道提供） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `channel` | TEXT | 否 (NOT NULL) | — | — | 获客渠道（wechat / douyin / xiaohongshu / meituan 等） |
| `intent` | TEXT | 是 | — | — | 客户意向诉求（自由文本，对话中提取） |
| `project` | TEXT | 是 | — | — | 归一化后的意向医美项目名 |
| `budget` | TEXT | 是 | — | — | 预算区间（客户自述，文本） |
| `city` | TEXT | 是 | — | — | 客户所在城市（用于就近匹配院区） |
| `grade` | TEXT | 是 | — | — | 线索等级 A-D（由意图分类与资质评估得出） |
| `stage` | TEXT | 否 (NOT NULL) | `'new'` | — | 线索阶段（new→contacted→qualified→captured→booked→arrived→deal / lost） |
| `reached` | TEXT | 否 (NOT NULL) | `'new'` | — | 触达状态（new/contacted…，单调推进） |
| `stage_updated_at` | INTEGER | 否 (NOT NULL) | `0` | — | 阶段最近一次变更时间戳（Unix 毫秒，漏斗耗时统计用） |
| `name` | TEXT | 是 | — | — | 客户姓名 |
| `phone` | TEXT | 是 | — | — | 客户手机号 |
| `wechat` | TEXT | 是 | — | — | 客户微信号 |
| `consent_at` | INTEGER | 是 | — | — | 授权同意时间戳（留资合规：采集前需取得同意） |
| `clinic_id` | TEXT | 是 | — | — | 关联院区ID → ma_clinic.clinic_id |
| `clinic_name` | TEXT | 是 | — | — | 院区名称（冗余存储，便于前端直接展示） |
| `booking_date` | TEXT | 是 | — | — | 预约日期（YYYY-MM-DD） |
| `booking_time` | TEXT | 是 | — | — | 预约时段（HH:MM） |
| `appointment_id` | TEXT | 是 | — | — | 关联预约单ID → ma_appointment.appointment_id |
| `handed_off` | INTEGER | 否 (NOT NULL) | `0` | — | 是否已转交人工（0/1） |
| `handoff_reason` | TEXT | 是 | — | — | 转交人工的原因说明 |
| `consulted_by` | TEXT | 是 | — | — | 接诊咨询师（工号/姓名） |
| `crm_id` | TEXT | 是 | — | — | 外部 CRM 系统回写的客户ID |
| `crm_sync_state` | TEXT | 否 (NOT NULL) | `'pending'` | — | CRM 同步状态（pending/synced/failed/disabled） |
| `crm_synced_at` | INTEGER | 是 | — | — | CRM 同步完成时间戳 |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 记录创建时间戳（Unix 毫秒） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 记录更新时间戳（Unix 毫秒） |

**索引**：`ix_lead_tenant_stage`、`ix_lead_tenant_updated`、`ix_lead_channel`、`ix_lead_handoff`

---

## ma_lead_message

**用途**：线索对话消息明细（已归属线索的对话记录）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `lead_id` | TEXT | 否 (NOT NULL) | — | — | 归属线索ID → ma_lead.lead_id |
| `run_id` | TEXT | 是 | — | — | 运行实例ID（对话会话标识） |
| `role` | TEXT | 否 (NOT NULL) | — | — | 消息角色（user / assistant / system） |
| `text` | TEXT | 否 (NOT NULL) | — | — | 消息文本内容 |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |

**索引**：`ix_msg_lead`

---

## ma_lead_stage_log

**用途**：线索阶段变更历史（运营分析用：漏斗留存耗时、阶段到达率）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `lead_id` | TEXT | 否 (NOT NULL) | — | — | 归属线索ID → ma_lead.lead_id |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `from_stage` | TEXT | 否 (NOT NULL) | — | — | 变更前阶段 |
| `to_stage` | TEXT | 否 (NOT NULL) | — | — | 变更后阶段 |
| `changed_at` | INTEGER | 否 (NOT NULL) | — | — | 变更时间戳（Unix 毫秒） |
| `operated_by` | TEXT | 是 | — | — | 操作方（system / 工号） |

**索引**：`ix_log_lead`、`ix_log_tenant`

---

## ma_transcript

**用途**：运行期对话暂存（尚未归属线索，qualify 时按 run_key 归集）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `run_key` | TEXT | 否 (NOT NULL) | — | — | 运行会话键（尚未归属线索时暂存对话） |
| `role` | TEXT | 否 (NOT NULL) | — | — | 消息角色（user / assistant / system） |
| `text` | TEXT | 否 (NOT NULL) | — | — | 消息文本内容 |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |

**索引**：`ix_transcript_run`

---

## ma_project

**用途**：项目知识库**本地库**（RAG 未配置时的回退检索源；运营导入或外部 KB 同步，源码不内置语料）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | — | 是 (PK) | 项目ID（主键） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `name` | TEXT | 否 (NOT NULL) | — | — | 项目名称 |
| `category` | TEXT | 是 | — | — | 项目分类（如 光电 / 注射 / 手术） |
| `aliases` | TEXT | 是 | — | — | 别名（逗号分隔，用于检索匹配） |
| `summary` | TEXT | 否 (NOT NULL) | — | — | 项目简介 |
| `indications` | TEXT | 是 | — | — | 适应症 |
| `contraindications` | TEXT | 是 | — | — | 禁忌症 |
| `recovery` | TEXT | 是 | — | — | 恢复期说明 |
| `price_range` | TEXT | 是 | — | — | 价格区间 |
| `faq` | TEXT | 是 | — | — | 常见问题（JSON 数组） |
| `source` | TEXT | 是 | — | — | 数据来源（db / 外部 KB 服务名） |
| `active` | INTEGER | 否 (NOT NULL) | `1` | — | 是否启用（1=是 / 0=否） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |
| `intent_tags` | TEXT | 是 | — | — | 意图标签（JSON 数组，检索增强） |
| `combo_with` | TEXT | 是 | — | — | 可组合项目 |
| `audience` | TEXT | 是 | — | — | 适合人群 |
| `seasonality` | TEXT | 是 | — | — | 季节性 |
| `duration_min` | INTEGER | 是 | — | — | 治疗时长（分钟） |
| `pain_level` | INTEGER | 是 | — | — | 痛感等级 |
| `downtime_days` | TEXT | 是 | — | — | 恢复期天数 |
| `course_sessions` | TEXT | 是 | — | — | 疗程次数 |
| `avg_price_tier` | TEXT | 是 | — | — | 价格档位 |
| `compliant_copy` | TEXT | 是 | — | — | 合规科普文案（先审后发用） |
| `compliance_reviewed` | INTEGER | 否 (NOT NULL) | `0` | — | 是否过合规审查（1/0） |
| `activity_title` | TEXT | 是 | — | — | 关联活动标题（未活跃客户提醒用） |
| `activity_id` | TEXT | 是 | — | — | 关联活动ID |
| `embedding` | TEXT | 是 | — | — | 语义向量（JSON 数组；未配置嵌入服务时为 NULL） |

**索引**：`ix_project_tenant`

---

## ma_project_intent

**用途**：意图 → 项目 映射（意图归一检索；`knowledge/domain/intent-map.json` 落库）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `intent` | TEXT | 否 (NOT NULL) | — | 是 (PK) | 意图标签 |
| `project_id` | TEXT | 否 (NOT NULL) | — | 是 (PK) | 项目ID → ma_project.project_id |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | 是 (PK) | 租户ID（多租户隔离） |
| `weight` | INTEGER | 否 (NOT NULL) | `1` | — | 匹配权重 |
| `keywords` | TEXT | 是 | — | — | 关键词（JSON 数组） |

**索引**：`ix_intent_tenant`

---

## ma_clinic

**用途**：院区信息（HIS 权威副本，查询用）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | TEXT | 是 | — | 是 (PK) | 院区ID（主键） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `name` | TEXT | 否 (NOT NULL) | — | — | 院区名称 |
| `city` | TEXT | 是 | — | — | 院区所在城市 |
| `address` | TEXT | 是 | — | — | 院区地址 |
| `phone` | TEXT | 是 | — | — | 院区联系电话 |
| `active` | INTEGER | 否 (NOT NULL) | `1` | — | 是否启用（1=是 / 0=否） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**索引**：`ix_clinic_city`

---

## ma_slot

**用途**：号源（capacity/booked 支持并发占用，事务防超卖；同院区同时段唯一）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `slot_id` | TEXT | 是 | — | 是 (PK) | 号源ID（主键） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `clinic_id` | TEXT | 否 (NOT NULL) | — | — | 关联院区ID → ma_clinic.clinic_id |
| `slot_date` | TEXT | 否 (NOT NULL) | — | — | 号源日期（YYYY-MM-DD） |
| `slot_time` | TEXT | 否 (NOT NULL) | — | — | 号源时段（HH:MM） |
| `capacity` | INTEGER | 否 (NOT NULL) | `1` | — | 该时段可预约上限 |
| `booked` | INTEGER | 否 (NOT NULL) | `0` | — | 已占用数量（capacity - booked = 剩余） |
| `status` | TEXT | 否 (NOT NULL) | `'open'` | — | 号源状态（open / closed） |
| `doctor` | TEXT | 是 | — | — | 接诊医生 |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**唯一约束**：`UNIQUE(tenant_id, clinic_id, slot_date, slot_time)`
**索引**：`ix_slot_lookup`

---

## slot_cache

**用途**：号源缓存（HIS 同步用，TTL 缓存避免抖动）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | TEXT | 否 (NOT NULL) | — | 是 (PK) | 院区ID |
| `date` | TEXT | 否 (NOT NULL) | — | 是 (PK) | 日期（YYYY-MM-DD） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | 是 (PK) | 租户ID（多租户隔离） |
| `slots_json` | TEXT | 否 (NOT NULL) | — | — | 号源快照（JSON） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

---

## ma_appointment

**用途**：预约单（占用号源后生成）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `appointment_id` | TEXT | 是 | — | 是 (PK) | 预约单ID（主键） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `lead_id` | TEXT | 否 (NOT NULL) | — | — | 关联线索ID → ma_lead.lead_id |
| `clinic_id` | TEXT | 否 (NOT NULL) | — | — | 关联院区ID → ma_clinic.clinic_id |
| `slot_id` | TEXT | 否 (NOT NULL) | — | — | 关联号源ID → ma_slot.slot_id |
| `slot_date` | TEXT | 否 (NOT NULL) | — | — | 预约日期（冗余自号源，便于查询） |
| `slot_time` | TEXT | 否 (NOT NULL) | — | — | 预约时段（冗余自号源，便于查询） |
| `status` | TEXT | 否 (NOT NULL) | `'booked'` | — | 预约状态（booked / arrived / completed / cancelled） |
| `external_id` | TEXT | 是 | — | — | 外部 HIS 回写的预约单号 |
| `external_status` | TEXT | 是 | — | — | 外部 HIS 回写的预约状态 |
| `arrived_at` | INTEGER | 是 | — | — | 到院时间戳（Unix 毫秒） |
| `completed_at` | INTEGER | 是 | — | — | 完成时间戳（Unix 毫秒） |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**索引**：`ix_appt_lead`、`ux_appt_slot_active`（仅 `status='booked'` 的 `UNIQUE(slot_id, lead_id)`）

---

## ma_outbox

**用途**：CRM/HIS 同步发件箱（至少一次投递，避免抖动丢客资）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `topic` | TEXT | 否 (NOT NULL) | — | — | 事件主题（lead.upsert / appt.create / outreach.send） |
| `idempotency_key` | TEXT | 否 (NOT NULL) | — | — | 幂等键（UNIQUE，去重，保证至少一次投递） |
| `payload` | TEXT | 否 (NOT NULL) | — | — | 事件载荷（JSON 字符串） |
| `state` | TEXT | 否 (NOT NULL) | `'pending'` | — | 投递状态（pending / sent / failed） |
| `attempts` | INTEGER | 否 (NOT NULL) | `0` | — | 已投递尝试次数 |
| `last_error` | TEXT | 是 | — | — | 最近一次投递错误 |
| `next_retry_at` | INTEGER | 否 (NOT NULL) | `0` | — | 下次重试时间戳（Unix 毫秒） |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**索引**：`ix_outbox_due`

---

## ma_inbound_message

**用途**：渠道入站消息（webhook 落库，去重 + 可重放）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `channel` | TEXT | 否 (NOT NULL) | — | — | 来源渠道 |
| `external_id` | TEXT | 否 (NOT NULL) | — | — | 渠道侧消息ID（去重键组成部分） |
| `lead_key` | TEXT | 否 (NOT NULL) | — | — | 线索关联键（用于归并到同一客户） |
| `text` | TEXT | 否 (NOT NULL) | — | — | 入站消息文本 |
| `state` | TEXT | 否 (NOT NULL) | `'received'` | — | 处理状态（received / dispatched / processed / error） |
| `run_id` | TEXT | 是 | — | — | 关联运行实例ID |
| `error` | TEXT | 是 | — | — | 处理失败时的错误信息 |
| `received_at` | INTEGER | 否 (NOT NULL) | — | — | 接收时间戳（Unix 毫秒） |
| `processed_at` | INTEGER | 是 | — | — | 处理完成时间戳（Unix 毫秒） |

**唯一约束**：`UNIQUE(tenant_id, channel, external_id)`
**索引**：`ix_inbound_state`

---

## ma_schedule_job

**用途**：定时调度任务（回捞 2h/24h / 欢迎语 / 生日 / 复购提醒）。`scheduled_key` 唯一保证同一（线索, 节点）只排一次；到期由 scheduler tick 消费，产出对客消息进 `ma_outbox`（topic=outreach.send）。

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `job_type` | TEXT | 否 (NOT NULL) | — | — | 任务类型（welcome / recall_first / recall_second / birthday / repurchase） |
| `lead_id` | TEXT | 否 (NOT NULL) | — | — | 关联线索ID → ma_lead.lead_id |
| `scheduled_key` | TEXT | 否 (NOT NULL) | — | — | 调度去重键（UNIQUE） |
| `due_at` | INTEGER | 否 (NOT NULL) | — | — | 到期时间戳（Unix 毫秒） |
| `status` | TEXT | 否 (NOT NULL) | `'pending'` | — | 状态（pending / done / error） |
| `attempts` | INTEGER | 否 (NOT NULL) | `0` | — | 已尝试次数 |
| `last_error` | TEXT | 是 | — | — | 最近一次错误 |
| `payload` | TEXT | 是 | — | — | 任务载荷（JSON） |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**索引**：`ix_sched_due`、`ix_sched_lead`

---

## ma_content

**用途**：内容生产与先审后发（D8/D9）：草稿 → 送审 → 过审/驳回 → 发布。约束：入审文案必须先过 `medicalAdRules` 筛查；未过审（approved 之前）绝不发布；发布经渠道网关 `POST /v1/content/publish`，幂等键 `content:{content_id}`。

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `content_id` | TEXT | 是 | — | 是 (PK) | 内容ID（主键） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `platform` | TEXT | 否 (NOT NULL) | — | — | 发布平台 |
| `title` | TEXT | 否 (NOT NULL) | — | — | 标题 |
| `body` | TEXT | 否 (NOT NULL) | — | — | 正文 |
| `project` | TEXT | 是 | — | — | 关联项目 |
| `source` | TEXT | 否 (NOT NULL) | `'manual'` | — | 来源（manual / llm / template） |
| `state` | TEXT | 否 (NOT NULL) | `'draft'` | — | 状态（draft / review / approved / rejected / published） |
| `review_reason` | TEXT | 是 | — | — | 驳回原因 |
| `reviewed_by` | TEXT | 是 | — | — | 审核人 |
| `reviewed_at` | INTEGER | 是 | — | — | 审核时间戳（Unix 毫秒） |
| `published_at` | INTEGER | 是 | — | — | 发布时间戳（Unix 毫秒） |
| `publish_ref` | TEXT | 是 | — | — | 发布回执引用 |
| `publish_error` | TEXT | 是 | — | — | 发布失败原因（保留 approved 可重试） |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**索引**：`ix_content_state`、`ix_content_platform`

---

## ma_ab_experiment

**用途**：A/B 分流实验定义（E 组）。`topic` 精确匹配 SOP 任务 topic（welcome / recall_first / recall_second / birthday / repurchase）；`metric` 决定转化口径 `reply|booking|arrived`。

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `experiment_id` | TEXT | 是 | — | 是 (PK) | 实验ID（主键） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `name` | TEXT | 否 (NOT NULL) | — | — | 实验名称 |
| `topic` | TEXT | 否 (NOT NULL) | — | — | 匹配的 SOP 任务 topic |
| `metric` | TEXT | 否 (NOT NULL) | `'booking'` | — | 转化口径（reply / booking / arrived） |
| `status` | TEXT | 否 (NOT NULL) | `'running'` | — | 状态（running / stopped） |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |
| `stopped_at` | INTEGER | 是 | — | — | 停止时间戳（Unix 毫秒） |

**索引**：`ix_ab_exp_topic`

---

## ma_ab_variant

**用途**：A/B 变体文案（入表前过医疗广告合规筛查；发送时统一追加风险提示）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `experiment_id` | TEXT | 否 (NOT NULL) | — | 是 (PK) | 实验ID → ma_ab_experiment.experiment_id |
| `variant_key` | TEXT | 否 (NOT NULL) | — | 是 (PK) | 变体键 |
| `text` | TEXT | 否 (NOT NULL) | — | — | 变体文案 |
| `weight` | INTEGER | 否 (NOT NULL) | `50` | — | 分流权重（缺省 50/50） |

---

## ma_ab_assignment

**用途**：sticky 分流落库（确定性哈希 + `UNIQUE(experiment_id, lead_id)`——同一线索永远同一变体）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `experiment_id` | TEXT | 否 (NOT NULL) | — | — | 实验ID → ma_ab_experiment.experiment_id |
| `lead_id` | TEXT | 否 (NOT NULL) | — | — | 关联线索ID → ma_lead.lead_id |
| `variant_key` | TEXT | 否 (NOT NULL) | — | — | 分配到的变体键 |
| `assigned_at` | INTEGER | 否 (NOT NULL) | — | — | 分配时间戳（Unix 毫秒） |

**唯一约束**：`UNIQUE(experiment_id, lead_id)`
**索引**：`ix_ab_assign_exp`
