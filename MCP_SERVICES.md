# 可直接通过 URL 访问的远程 MCP 服务清单

> 适用对象：本仓库的 agent-harness（`packages/core` + `packages/ui`）。
> 你的 harness 已支持远程 MCP：通过 `serverUrl` 连接，传输方式自动判定
> （URL 以 `/sse` 结尾走 SSE，否则走 Streamable HTTP）。

---

## 一、你的 harness 如何接入一个远程 MCP

**方式 A — UI 面板**
打开 Web Playground → 「MCP 服务」面板 → 添加，填 `name` + `url`（可选 `headers`）。

**方式 B — HTTP 接口**
```bash
# 远程 Streamable HTTP（默认，无需指定 transportType）
curl -X POST https://<你的服务>/api/mcp/add \
  -H "Content-Type: application/json" \
  -d '{"name":"context7","url":"https://mcp.context7.com/mcp","headers":{}}'

# 远程 SSE（强制指定 transportType，适用于只提供 SSE 且 URL 不以 /sse 结尾的服务）
curl -X POST https://<你的服务>/api/mcp/add \
  -H "Content-Type: application/json" \
  -d '{"name":"my-sse","url":"https://example.com/mcp","transportType":"sse","headers":{"Authorization":"Bearer <TOKEN>"}}'

# 本地 stdio（command + args 启动子进程；可选 env 注入环境变量）
curl -X POST https://<你的服务>/api/mcp/add \
  -H "Content-Type: application/json" \
  -d '{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"]}'
```
接口字段：`{ name?: string, url?: string, serverUrl?: string, command?: string, args?: string[], env?: Record<string,string>, headers?: Record<string,string>, transportType?: 'auto' | 'sse' | 'streamable-http' }`
- `url` 与 `serverUrl` 等价（兼容旧字段）；`transportType` 缺省时按 URL 自动判定（非 `/sse` 结尾走 Streamable HTTP）。

**方式 C — 环境变量预置（启动即连）**
在 Render 环境变量加：
```
MCP_SERVERS=[{"name":"context7","url":"https://mcp.context7.com/mcp","headers":{}}]
```
支持数组，多个服务逗号分隔。

---

## 二、已核实的公共远程 MCP 服务

| 名称 | URL | 传输 | 鉴权 | 能力 | 备注 |
|---|---|---|---|---|---|
| **Context7**（Upstash） | `https://mcp.context7.com/mcp` | Streamable HTTP | 可选：`Authorization: Bearer <CONTEXT7_API_KEY>`；免费档免 key 也能用 | 拉取任意库的最新文档（`resolve-library-id` / `get-library-docs`） | **最推荐**，零配置即可用，专治 LLM 用陈旧训练数据 |
| **GitHub** | `https://api.githubcopilot.com/mcp/` | Streamable HTTP | OAuth（Copilot）或 PAT：`Authorization: Bearer <GH_PAT>` | 仓库 / Issue / PR 操作 | 需要 GitHub Copilot 订阅；可用 `X-MCP-Toolsets: default,copilot_spaces` 头启用工具集 |
| **Composio** | `https://connect.composio.dev/mcp` | Streamable HTTP | Composio API Key（`Authorization: Bearer ck_...`） | 单端点覆盖 1000+ 集成（Gmail / Slack / Notion / Linear / GitHub …） | 一个 URL 动态发现全部工具，治理/鉴权由 Composio 托管 |
| **Zapier** | `https://mcp.zapier.com/api/v1/connect` | Streamable HTTP | Zapier 账号（每个 server 生成一个 secret URL） | 9000+ App、30000+ 动作 | 在 mcp.zapier.com 创建 server 后复制其专属 URL 填入 |

### 各服务接入示例

```bash
# Context7（免 key）
curl -X POST https://<你的服务>/api/mcp/add -H "Content-Type: application/json" \
  -d '{"name":"context7","url":"https://mcp.context7.com/mcp","headers":{}}'

# GitHub（用 PAT）
curl -X POST https://<你的服务>/api/mcp/add -H "Content-Type: application/json" \
  -d '{"name":"github","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer <GH_PAT>"}}'

# Composio
curl -X POST https://<你的服务>/api/mcp/add -H "Content-Type: application/json" \
  -d '{"name":"composio","url":"https://connect.composio.dev/mcp","headers":{"Authorization":"Bearer ck_你的key"}}'

# Zapier（填入在 mcp.zapier.com 生成的专属 URL）
curl -X POST https://<你的服务>/api/mcp/add -H "Content-Type: application/json" \
  -d '{"name":"zapier","url":"https://mcp.zapier.com/api/v1/connect/<你的secret>","headers":{}}'
```

---

## 三、自托管（靠 URL 暴露，非公共 SaaS）

| 名称 | 怎么拿到 URL | 传输 |
|---|---|---|
| **Playwright MCP** | 自起：`npx @playwright/mcp@latest --port 8931`（容器内加 `--host 0.0.0.0`），连 `http://localhost:8931/mcp` | Streamable HTTP |

> Playwright 官方主要推本地 stdio（`npx @playwright/mcp`），但它也支持 standalone
> HTTP transport。想让它被远程 harness 访问，就在某台机器上起服务并暴露端口/反代。

---

## 四、去哪里发现更多远程 MCP

- **官方注册表（最权威）**：https://modelcontextprotocol.io/registry/remote-servers
  （`server.json` 里用 `remotes[].url` + `remotes[].type` 描述，可直接抄 URL）
- **MCP.run**（Tend）：托管式远程 MCP 市场
- **Smithery.ai**：MCP 服务器目录，部分支持远程 URL

---

## 五、选型建议（针对你的基础设施助手场景）

1. 想让 agent 读**最新库文档** → 接 **Context7**（零成本、零配置）。
2. 想让 agent 操作 **GitHub 仓库** → 接 **GitHub**（需 Copilot + PAT）。
3. 想让 agent 调度 **Slack / 邮件 / 日历 / CRM** 等办公套件 → 接 **Composio** 或 **Zapier**（一个 URL 覆盖众多 App，鉴权由平台托管）。
4. 想让 agent **自动化网页 / 填报 / 抓取** → 自托管 **Playwright MCP** 并暴露 URL。
