# IM 真实平台验证（P0-2）

本目录下的 `im-platform-verify.test.cjs` 与 `scripts/im-live-verify.cjs` 共同构成「IM 桥接真实平台验证」的两层保障。

## 一、协议级验证（单测，无需真实凭据 / 网络）

文件：`access/server/test/im-platform-verify.test.cjs`

用**与飞书 / 钉钉 / 企业微信线上完全一致的加密、签名算法**构造回调，再通过**真实的适配器**
（`FeishuAdapter` / `DingtalkAdapter` / `WecomAdapter`）跑通 `ImBridge` 全链路：

```
验签 → 解密(飞书/企微) → 解析 → 去重 → 立即 ack 200 → 后台执行 agent → 回发
```

覆盖的「真实平台」行为：

| 平台     | 加密                                   | 签名                                             | 验证点 |
| -------- | -------------------------------------- | ------------------------------------------------ | ------ |
| 飞书     | AES-256-CBC（key=sha256(encryptKey)）  | `X-Lark-Signature = sha256(ts+nonce+ek+body)`    | 握手回显 / 加密消息解密 / 签名篡改拒 401 / 群聊未 @ 忽略 / 重推去重 |
| 钉钉     | 无                                     | `sign = base64(HMAC-SHA256(ts+"\n"+secret))`     | 签名消息解析 / 错密钥拒 401 |
| 企业微信 | AES-256-CBC（key=base64(aesKey+"=")）  | `msg_signature = sha1(sort([token,ts,nonce,payload]))` | 握手解密 echostr / 加密消息解密 / 签名篡改拒 401 |

> 关键点：本脚本产出的 `rawBody` 若直接投递到生产 webhook，平台侧算法能与之逐字节对应——
> 即我们的「验签 / 解密」实现与官方 SDK 等价。

运行：

```bash
cd access/server
pnpm run build
node --test test/im-platform-verify.test.cjs
# 期望：# tests 11 / # pass 11 / # fail 0
```

## 二、连通性验证（真实环境，需凭据 + 公网可达）

脚本：`access/server/scripts/im-live-verify.cjs`

仅做**只读令牌获取**（`tenant_access_token` / `accessToken` / `gettoken`），不发送任何 IM 消息，
用于确认：

1. `IM_*` 凭据是否齐全、平台是否按 `createImRegistry` 入列；
2. 各平台凭据是否有效、网络是否可达。

运行：

```bash
cd access/server
pnpm run build   # 需 dist/im/index.js

# 配置真实凭据后执行（示例）
export IM_ENABLED=true
export IM_PROVIDERS=feishu,dingtalk,wecom
export IM_FEISHU_APP_ID=cli_xxx IM_FEISHU_APP_SECRET=xxx \
       IM_FEISHU_VERIFICATION_TOKEN=xxx IM_FEISHU_ENCRYPT_KEY=xxx
export IM_DINGTALK_CLIENT_ID=xxx IM_DINGTALK_CLIENT_SECRET=xxx
export IM_WECOM_CORP_ID=xxx IM_WECOM_AGENT_ID=1 IM_WECOM_SECRET=xxx \
       IM_WECOM_TOKEN=xxx IM_WECOM_AES_KEY=<43位EncodingAESKey>

node scripts/im-live-verify.cjs
```

输出示例：

```
[✓] 已启用平台：feishu, dingtalk, wecom
── feishu ───────────────────
  [✓] 凭据有效，成功换取令牌（长度 86）。
  回调地址（公网可达后配置到平台）：/api/im/feishu/events
```

失败会区分「密钥错误 / 网络不可达 / 沙箱无外网」。

## 三、端到端联调（生产 webhook）

1. 把服务部署到**公网可达**地址（或本地用 `cloudflared` / `ngrok` 等隧道暴露）。
2. 在各平台「事件订阅 / 回调配置」填入：`https://<你的域名>/api/im/<provider>/events`
   - 飞书：配置后平台会先发 `url_verification` 握手，本桥接自动回显 `challenge`。
   - 企业微信：配置 `Token` 与 `EncodingAESKey`，平台先发 GET 握手（验签+解密 echostr）。
3. 在平台侧发送一条 `@机器人 文本`，观察：
   - 服务端日志出现 `im.inbound` 与 `im.task`；
   - 机器人回复发回原平台会话；
   - `GET /api/im/status` 显示 `enabled` 含该平台、`inflight`/`counters` 随流量变化。
4. 多实例部署时：`REDIS_URL` 指向同一 Redis，`IM_DEDUP_BACKEND` 默认走 redis，
   平台重推 / 负载均衡重复投递均被去重（仅执行一次）。

## 四、回归保护

- `im-platform-verify.test.cjs` 随 `pnpm --filter @agent-harness/server test` 全量运行，
  任何「验签 / 解密 / 解析」实现回归都会在此暴露，避免悄悄破坏与真实平台的兼容性。
- 同时存在的 `im-bridge.test.cjs` 覆盖去重 / 身份派生 / 工厂 / 三平台单点验签解析，
  与本文件互补（本文件走真实适配器 + 端到端加密体）。
