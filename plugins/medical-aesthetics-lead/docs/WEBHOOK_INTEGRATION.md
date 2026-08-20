# 渠道 Webhook 对接说明（入口 B）

本文档面向**外部渠道系统 / 对接网关**的开发者，说明如何把客资消息主动推送到 `medical-aesthetics-lead` 插件，以及签名怎么算。所有规则与插件源码严格一致（`src/server/routes.ts` → `webhook` handler；`src/infra/signature.ts` → `verifyWebhook`）。

---

## 1. 接口概览

| 项 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/api/plugins/medical-aesthetics-lead/webhook` |
| Content-Type | `application/json`（必须） |
| 鉴权 | HMAC-SHA256 签名（见 §3） |
| 成功响应 | `202 Accepted`，立即返回，agent 异步处理 |
| 失败响应 | `401 UNAUTHORIZED`（验签失败/缺签名/超窗）、`400 INVALID_ARGUMENT`（缺 externalId）、`503 NOT_CONFIGURED`（服务端未配置密钥） |

> 路径前缀 `/api/plugins/<pluginId>/` 由宿主服务端统一收敛，对接方只需关注末尾的 `/webhook`。

---

## 2. 请求体（JSON）

```json
{
  "channel": "douyin",          // 渠道标识（自定义字符串，如 wechat / xhs / meituan / h5）
  "externalId": "msg_8f3a2b",   // 【必填】渠道侧该条消息的唯一 ID（去重键）
  "leadKey": "user_12345",      // 【可选】归属客户标识；缺省时回退为 externalId
  "text": "请问你们家双眼皮大概多少钱？"  // 客户咨询原文
}
```

字段约束：

| 字段 | 必填 | 说明 |
|---|---|---|
| `channel` | 否 | 缺省按 `"unknown"` 处理；仅用于统计与落库标记 |
| `externalId` | **是** | 与 `channel` 共同构成去重键 `UNIQUE(tenant, channel, external_id)`。**必须稳定且唯一**（建议用渠道消息 ID），否则重试无法去重 |
| `leadKey` | 否 | 标识同一客户的不同消息归属；缺省回退为 `externalId` |
| `text` | 否 | 客户咨询原文；会写入 `ma_inbound_message.text` 并最终归集进线索对话 |

> ⚠️ **签名与报文一致性**：签名是对「原始请求体字节」计算的（见 §3）。请发送**紧凑 JSON（无多余空格/换行）**，并对**你实际发送的那串字节**签名，否则服务端复算必然不一致。

---

## 3. 签名算法

### 3.1 公式

```
timestamp = 当前 Unix 时间（秒，字符串，如 "1755489600"）
rawBody   = 实际发送的完整请求体字符串（紧凑 JSON）
signature = 小写 hex( HMAC-SHA256( MA_WEBHOOK_SECRET, `${timestamp}.${rawBody}` ) )
```

即：**用共享密钥对 `"{timestamp}.{rawBody}"` 做 HMAC-SHA256，结果转十六进制小写**。

### 3.2 请求头

| Header | 值 |
|---|---|
| `Content-Type` | `application/json` |
| `x-ma-timestamp` | 上述 `timestamp`（秒，字符串） |
| `x-ma-signature` | 上述 `signature`（hex 串；大小写均可，服务端会比较时转小写） |

### 3.3 时间窗

服务端校验 `|now - timestamp| ≤ 300` 秒（5 分钟）。超出即视为重放，返回 `401`。**务必保证对接方服务器时钟同步（NTP）**。

### 3.4 安全边界（fail-closed）

- 服务端未配置 `MA_WEBHOOK_SECRET` → 直接 `503 NOT_CONFIGURED`，不接受任何请求（无裸奔入口）。
- 缺签名头 / 时间戳非法 / 时间窗外 / 签名不符 → 一律 `401`，且**不落库、不触发 agent**。

---

## 4. 对接示例

下面示例发送同一条消息：`channel=douyin`、`externalId=msg_8f3a2b`、`text=请问双眼皮多少钱`。

### 4.1 Bash + curl（手动拼签名）

```bash
SECRET="your_shared_secret"
TS=$(date +%s)
BODY='{"channel":"douyin","externalId":"msg_8f3a2b","text":"请问双眼皮多少钱"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)

curl -sS -X POST "https://your-host/api/plugins/medical-aesthetics-lead/webhook" \
  -H "Content-Type: application/json" \
  -H "x-ma-timestamp: $TS" \
  -H "x-ma-signature: $SIG" \
  -d "$BODY"
```

### 4.2 Node.js

```js
const crypto = require('node:crypto');

const SECRET = process.env.MA_WEBHOOK_SECRET;
const url = 'https://your-host/api/plugins/medical-aesthetics-lead/webhook';

function sign(secret, ts, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
}

const body = JSON.stringify({          // 注意：用紧凑序列化，且签名对象 = 发送字节
  channel: 'douyin',
  externalId: 'msg_8f3a2b',
  text: '请问双眼皮多少钱',
});
const ts = String(Math.floor(Date.now() / 1000));
const sig = sign(SECRET, ts, body);

fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-ma-timestamp': ts,
    'x-ma-signature': sig,
  },
  body,
}).then(async (r) => {
  console.log(r.status, await r.json());
});
```

### 4.3 Python

```python
import hmac, hashlib, time, json, urllib.request

SECRET = "your_shared_secret"
URL = "https://your-host/api/plugins/medical-aesthetics-lead/webhook"

body = json.dumps(            # 紧凑序列化（separators 去空格），签名对象 = 发送字节
    {"channel": "douyin", "externalId": "msg_8f3a2b", "text": "请问双眼皮多少钱"},
    separators=(",", ":"),
    ensure_ascii=False,
).encode("utf-8")

ts = str(int(time.time()))
msg = f"{ts}.".encode("utf-8") + body
sig = hmac.new(SECRET.encode("utf-8"), msg, hashlib.sha256).hexdigest()

req = urllib.request.Request(URL, data=body, method="POST")
req.add_header("Content-Type", "application/json")
req.add_header("x-ma-timestamp", ts)
req.add_header("x-ma-signature", sig)

with urllib.request.urlopen(req) as resp:
    print(resp.status, resp.read().decode("utf-8"))
```

---

## 5. 响应

### 5.1 成功

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
```
```json
{ "ok": true, "accepted": true, "inboundId": 42, "dispatched": true }
```

- `inboundId`：落库后的 `ma_inbound_message.id`，可用于后续对账/排障。
- `dispatched`：是否成功经 A2A 唤起 agent。**为 `false` 不代表失败**——消息已落库（状态 `received`，不会丢），只是本次未触发 agent（如 `AGENT_A2A_BASE_URL` 未配置），可安全重试。

### 5.2 失败

| 状态码 | `code` | 含义 | 对接方处理 |
|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | 缺 `externalId` | 修正报文后重试 |
| 401 | `UNAUTHORIZED` | 缺签名头 / 时间戳非法 / 超窗 / 签名不符 | 检查时钟同步、密钥、报文一致性后重试 |
| 503 | `NOT_CONFIGURED` | 服务端未配 `MA_WEBHOOK_SECRET` | 联系平台侧配置，勿反复高频重试 |

---

## 6. 重试与幂等

- **天然去重**：同一 `(channel, externalId)` 重复推送会返回既有入库记录，不会重复建档。因此对接方可对网络超时**放心重试**，但务必保证 `externalId` 同一消息恒定不变。
- **at-least-once**：消息先落库再去触发 agent，即使触发瞬间失败，消息已在 `ma_inbound_message`（状态 `received`/`error`），运维可重试或排查，客资不丢。
- **建议**：对接方对 `5xx` / 网络错误采用**指数退避重试**（如 1s、2s、4s，上限 5 次）；`401` 不要盲目重试，先排查签名/时钟。

---

## 7. 服务端配置（平台侧）

对接前需由平台运维在插件运行环境设置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `MA_WEBHOOK_SECRET` | **是** | 共享密钥，对接方与服务端须完全一致；未配则入口全拒 |
| `MA_TENANT_ID` | 否 | 多租户隔离字段，写库时按 tenant 分片 |
| `AGENT_A2A_BASE_URL` | 否 | agent 触发地址（默认宿主 `/api/a2a/tasks`）；未配则 `dispatched=false` 但不丢消息 |

密钥建议通过环境变量 / Secret 注入，**不要**写进代码或提交到仓库。

---

## 8. 端到端自检清单

- [ ] 服务端已设 `MA_WEBHOOK_SECRET`，对接方持有相同值
- [ ] 对接方服务器时钟已 NTP 同步（误差 < 5 分钟）
- [ ] 发送紧凑 JSON，且签名对象 = 实际发送字节
- [ ] 请求带 `x-ma-timestamp`（秒）+ `x-ma-signature`（hex）
- [ ] `externalId` 对同一消息恒定唯一（保证去重）
- [ ] 收到 `202 { dispatched: true }` 即接入成功；`dispatched:false` 查 `AGENT_A2A_BASE_URL`
- [ ] 用错误密钥发一次，确认返回 `401`（验证鉴权生效）

---

## 9. 下行回写 / 状态回执（反向通道）

§2–§6 解决的是**外部系统 → 我们**的入站（客户咨询推送）。但 HIS/CRM 往往是**异步**处理：预约在 HIS 侧被医生确认/取消、线索在 CRM 侧状态流转——这些结果需要**反向推回给我们**，本地预约单/线索才能与上游保持一致。这就是下行回写（callback）。

### 9.1 接口

| 项 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/api/plugins/medical-aesthetics-lead/callback` |
| 鉴权 | 与入站 webhook **同一套** HMAC-SHA256（复用 `MA_WEBHOOK_SECRET`，见 §3） |
| 成功 | `200 OK` |
| 失败 | `401 UNAUTHORIZED`（验签失败）、`400 INVALID_ARGUMENT`、`404 NOT_FOUND`（预约单未匹配） |

### 9.2 回执类型

**a) 预约状态回执（`appt.status`）** —— HIS 确认/取消后推回：

```json
{
  "type": "appt.status",
  "appointmentId": "appt_xxx",   // 优先：本地预约单号（建单时我们返回给 HIS 的）
  "externalId": "HIS20260901A", // 可选：HIS 侧单号，用于反查
  "status": "confirmed"         // 任意 HIS 侧状态串，原样落 external_status
}
```

服务端按 `appointmentId` 优先、`externalId` 反查兜底，写入 `ma_appointment.external_status`（同时回填 `external_id`）。这样本地既能查到 HIS 单号，也能反映 HIS 侧的确认/取消状态——**闭合 §4.4 提到的外部同步链路缺口**。

**b) 线索状态回执（`lead.status`）** —— CRM 侧线索状态变更推回：

```json
{
  "type": "lead.status",
  "leadId": "douyin_001",
  "crmId": "CRM-7788",          // 可选：CRM 侧线索 ID
  "status": "synced"            // 非 "failed" 即记为 synced
}
```

服务端据 `status` 更新线索 `crmSync` 为 `synced` / `failed`，并回填 `crmId`。

### 9.3 示例（curl，复用以太 §3 签名）

```bash
SECRET="your_shared_secret"
TS=$(date +%s)
BODY='{"type":"appt.status","appointmentId":"appt_xxx","externalId":"HIS20260901A","status":"confirmed"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)

curl -sS -X POST "https://your-host/api/plugins/medical-aesthetics-lead/callback" \
  -H "Content-Type: application/json" \
  -H "x-ma-timestamp: $TS" \
  -H "x-ma-signature: $SIG" \
  -d "$BODY"
# => {"ok":true,"appointmentId":"appt_xxx","externalStatus":"confirmed"}
```

### 9.4 幂等与可靠性

- 同一回执重复推送**安全**：写入是覆盖式 UPDATE（按 `appointmentId`），不新增记录。
- 全程复用 `MA_WEBHOOK_SECRET` 验签，未配密钥时入口全拒，无裸奔。
- 回执是**异步、尽力**的：即使本次回执丢失，HIS/CRM 也应在下次状态变更时重新推送（建议对接方对回执也做指数退避重试）。

> 注：当前 agent 的**文本回复下行**（把 agent 答复推回客户所在的微信/抖音会话）尚未实现——这属于「渠道下发适配器」，需各渠道提供主动发送 API（如微信公众号客服消息接口）。本插件已预留 outbox 同构机制，后续可新增 `reply.send` topic + 渠道适配器接入，不在本次范围。

