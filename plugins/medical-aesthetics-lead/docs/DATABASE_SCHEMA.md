# 医美客资插件 · 数据库表结构文档

> 自动生成时间：2026-08-18T02:51:43.734Z
> 数据库文件：`C:\Users\Administrator\Documents\WorkBuddy\App\agent-harness\plugins\medical-aesthetics-lead\data\ma-lead\ma-lead.sqlite`
> 注释来源：本脚本内置领域字典。标注 **（推断）** 的字段为按字段名/上下文自动推断，需人工复核。

共 **9** 张表。

## 表关系总览

- `ma_appointment.lead_id` → `ma_lead.lead_id`
- `ma_appointment.clinic_id` → `ma_clinic.clinic_id`
- `ma_appointment.slot_id` → `ma_slot.slot_id`
- `ma_lead.clinic_id` → `ma_clinic.clinic_id`
- `ma_lead.appointment_id` → `ma_appointment.appointment_id`
- `ma_lead_message.lead_id` → `ma_lead.lead_id`
- `ma_slot.clinic_id` → `ma_clinic.clinic_id`

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
| `status` | TEXT | 否 (NOT NULL) | `'booked'` | — | 预约状态（booked / cancelled / arrived / completed） |
| `external_id` | TEXT | 是 | — | — | 外部 HIS 回写的预约单号 |
| `external_status` | TEXT | 是 | — | — | 外部 HIS 回写的预约状态 |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**索引**：`ux_appt_slot_active`、`ix_appt_lead`、`sqlite_autoindex_ma_appointment_1`

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

**索引**：`ix_clinic_city`、`sqlite_autoindex_ma_clinic_1`

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

**索引**：`ix_inbound_state`、`sqlite_autoindex_ma_inbound_message_1`

---

## ma_lead

**用途**：客资线索主表（业务系统记录，system of record）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `lead_id` | TEXT | 是 | — | 是 (PK) | 线索唯一标识（业务主键，由系统生成或外部渠道提供） |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离字段，默认 default） |
| `channel` | TEXT | 否 (NOT NULL) | — | — | 获客渠道（wechat / douyin / xiaohongshu / meituan 等） |
| `intent` | TEXT | 是 | — | — | 客户意向诉求（自由文本，对话中提取） |
| `project` | TEXT | 是 | — | — | 归一化后的意向医美项目名 |
| `budget` | TEXT | 是 | — | — | 预算区间（客户自述，文本） |
| `city` | TEXT | 是 | — | — | 客户所在城市（用于就近匹配院区） |
| `grade` | TEXT | 是 | — | — | 线索等级 A-D（由意图分类与资质评估得出） |
| `stage` | TEXT | 否 (NOT NULL) | `'new'` | — | 线索阶段（new→reach→qualify→book→consult→deal / lost） |
| `reached` | TEXT | 否 (NOT NULL) | `'new'` | — | 触达状态（new/contacted…，单调推进） |
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

**索引**：`ix_lead_handoff`、`ix_lead_channel`、`ix_lead_tenant_updated`、`ix_lead_tenant_stage`、`sqlite_autoindex_ma_lead_1`

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

## ma_outbox

**用途**：CRM/HIS 同步发件箱（至少一次投递，避免抖动丢客资）

| 字段名 | 数据类型 | 可空 | 默认值 | 主键 | 注释 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 是 | — | 是 (PK) | 自增主键 |
| `tenant_id` | TEXT | 否 (NOT NULL) | `'default'` | — | 租户ID（多租户隔离） |
| `topic` | TEXT | 否 (NOT NULL) | — | — | 事件主题（lead.upsert / appt.create） |
| `idempotency_key` | TEXT | 否 (NOT NULL) | — | — | 幂等键（UNIQUE，去重，保证至少一次投递） |
| `payload` | TEXT | 否 (NOT NULL) | — | — | 事件载荷（JSON 字符串） |
| `state` | TEXT | 否 (NOT NULL) | `'pending'` | — | 投递状态（pending / sent / failed） |
| `attempts` | INTEGER | 否 (NOT NULL) | `0` | — | 已投递尝试次数 |
| `last_error` | TEXT | 是 | — | — | 最近一次投递错误 |
| `next_retry_at` | INTEGER | 否 (NOT NULL) | `0` | — | 下次重试时间戳（Unix 毫秒） |
| `created_at` | INTEGER | 否 (NOT NULL) | — | — | 创建时间戳（Unix 毫秒） |
| `updated_at` | INTEGER | 否 (NOT NULL) | — | — | 更新时间戳（Unix 毫秒） |

**索引**：`ix_outbox_due`、`sqlite_autoindex_ma_outbox_1`

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

**索引**：`ix_project_tenant`、`sqlite_autoindex_ma_project_1`

---

## ma_slot

**用途**：号源（capacity/booked 支持并发占用，事务防超卖）

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

**索引**：`ix_slot_lookup`、`sqlite_autoindex_ma_slot_2`、`sqlite_autoindex_ma_slot_1`

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
