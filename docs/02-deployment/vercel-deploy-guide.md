# 在 Vercel 部署 agent-harness

> **⚠️ 架構約束聲明**：`access/server` 是一個 **長運行的 `node:http` 進程** —— 同時提供 HTTP+SSE 服務、托管前端 SPA，並依賴 **持久化磁碟**（SQLite / File memory store）、**背景工作隊列**、**OS 沙箱子進程**。Vercel Serverless/Edge Functions 在「無伺服器」模型下存在冷啟動、無持久磁碟、無背景進程等限制，**與本項目的運行模型存在根本衝突**。
>
> **推薦方案**：將 `access/server` 部署到 **Vercel Node.js Server** (Long-Running Server) 模式，而非傳統 Serverless Functions。此模式保持單一 Node.js 進程常駐，支援 SSE 流式、本地檔案系統與背景工作 —— 符合本項目的運行模型。
>
> 生產級多副本水平擴展請改用 **Docker Compose** 或 **Kubernetes**（見 `render.yaml` / `deploy/k8s/`）。

---

## 方法一：Node.js Server（推薦 —— 長運行模式）

### 1. 配置概述

專案根目錄的 `vercel.json` 定義了部署配置：

```json
{
  "builds": [
    {
      "src": "access/server/package.json",
      "use": "@vercel/node",
      "config": {
        "includeFiles": [
          "frontend/webapp/dist/**",
          "backend/core/dist/**",
          "backend/client/dist/**",
          "services/rag/dist/**",
          "plugins/**/dist/**",
          "scripts/**",
          "pnpm-workspace.yaml"
        ],
        "maxLambdaSize": "50mb"
      }
    }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/access/server/package.json" },
    { "src": "/(.*)", "dest": "/access/server/package.json" }
  ],
  "outputDirectory": "frontend/webapp/dist"
}
```

`@vercel/node` builder 會讀取 `access/server/package.json` 中的 `main` 字段（`dist/server.js`），並在部署前執行 `vercel-build` 腳本。

### 2. 預構建腳本

`access/server/package.json` 中定義了 `vercel-build` 腳本，指向 monorepo 的構建腳本 `scripts/vercel-build.sh`：

```bash
#!/usr/bin/env bash
# Vercel build hook for agent-harness monorepo.
set -euo pipefail

pnpm install --no-frozen-lockfile
pnpm -r build
# 驗證關鍵構建產物
test -f "access/server/dist/server.js"
test -f "frontend/webapp/dist/index.html"
test -f "backend/core/dist/index.js"
```

構建順序（`pnpm -r build` 按依賴拓撲排序）：
1. `backend/core` — 框架庫
2. `backend/client` — 客戶端 SDK
3. `access/server` — HTTP+SSE 服務器
4. `frontend/webapp` — Vite+Lit SPA
5. `services/rag` — RAG MCP 服務
6. `plugins/*/dist` — 业务插件

### 3. 環境變數

在 **Vercel Dashboard → 專案 → Settings → Environment Variables** 中配置：

| 變數 | 必填 | 說明 |
|---|---|---|
| `ADMIN_API_KEY` | 生產必填 | 站點 admin 密鑰，與 LLM 密鑰分離。生成：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `AH_CRYPTO_KEY` | 生產必填 | AES-256-GCM 主密鑰，用於加密用戶 BYOK Provider Key。64 位 hex。 |
| `AH_AUTH_SECRET` | 建議 | 账户密码 token 簽名密鑰。缺失則回退 `AH_CRYPTO_KEY`。 |
| `OPEN_API_KEY` | 可選 | 平台兒鑰（默認關閉）。不配置時，用戶可在前端「設置 → 模型服務商」自填。 |
| `DB_BACKEND` | 可選 | `sqlite`（默）\| `turso`。**Vercel 臨時磁碟不可靠，強烈建議設為 `turso`**。 |
| `TURSO_URL` | `DB_BACKEND=turso` 時必填 | 如 `libsql://xxx.turso.io` |
| `TURSO_TOKEN` | `DB_BACKEND=turso` 時必填 | Turso 訪問令牌 |
| `MEMORY_BACKEND` | 可選 | `sqlite`（默，可用 Turso）\| `file` \| `volatile`。生產建議配 Turso。 |
| `MCP_SERVERS` | 可選 | MCP server JSON 數組。stdio 模式在 Vercel 長運行進程中可用，但 /tmp 僅可寫。 |
| `REDIS_URL` | 可選 | 運行隊列後端（多副本必須）。Vercel 單實例可省略。 |
| `PORT` | Vercel 自動注入 | server 已自動讀取 `PORT ?? UI_PORT ?? DEFAULTS.PORT`。 |
| `UI_HOST` | Vercel 自動注入 | 設為 `0.0.0.0`（Vercel 反向代理）。 |
| `UI_CORS_ORIGIN` | 可選 | 跨域白名單，逗號分隔。Vercel 單域名同源，通常留空。 |
| `NODE_ENV` | 固定 | 設為 `production`。 |
| `SANDBOX_BACKEND` | 可選 | Vercel 容器環境建議設為 `local` 或 `container`，OS 沙箱可能受限。 |

### 4. 部署

```bash
# 安裝 Vercel CLI
npm i -g vercel

# 登入
vercel login

# 首次部署（會提示選擇專案/作用域）
vercel

# 後續部署
vercel --prod
```

### 5. 啟動前提與限制

- **SSE 流式**：Vercel Node.js Server 支援 SSE，前端 `chat-sync.ts` 內建 2 次重連機制。
- **持久化存儲**：Vercel /tmp 是臨時的，重啟即清空。**必須使用 `DB_BACKEND=turso`** + 外部 Redis，否則會話記憶、账户資料、插件數據將在重啟後丟失。
- **OS 沙箱**：`backend/core` 的原生沙箱執行器需要 Linux namespace/seccomp 支持。在 Vercel 容器環境中可能受限，建議設置 `SANDBOX_BACKEND=local`。
- **MCP stdio 服務**：如需 stdio 模式 MCP server（例如 RAG），在 `MCP_SERVERS` 中配置 `command: "node"`，Vercel 將在同進程中啟動子進程。

### 6. 健康檢查

```bash
# 健康檢查端點（無需鉴權）
curl https://<your-vercel-domain>/api/state
# 預期回應 200 + JSON 狀態
```

### 7. 回滄

```bash
vercel ls           # 列出部署歷史
vercel deploy --redeploy <deployment-url>  # 回滄到指定部署
```

---

## 方法二：Serverless Functions（不推薦）

> ❌ **不推薦**：每次請求冷啟動，SSE 斷流，無持久化存儲，無法背景進程。僅適合極簡無狀態 API。

---

## 相關資源

- [Vercel 官方文檔 — Node.js Servers](https://vercel.com/docs/concepts/functions/serverless-functions)
- [Render 部署](../../../../render.yaml) — 更簡單的備選方案
- [Docker 部署](../../../../docker-compose.yml) — 本地/內網多人
- [Kubernetes 部署](../../../../deploy/k8s/) — 生產級多副本
- [Docker 部署指南](./docker-deploy-guide.md)
- [Kubernetes 部署指南](./k8s-deploy-guide.md)
