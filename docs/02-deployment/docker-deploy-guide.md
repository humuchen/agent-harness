# Agent Harness · 本地 Docker 部署到落地使用完整流程

> 适用对象：在本机（已安装 Docker）上把 `agent-harness-ts` 跑起来并实际使用「运行时面板」。
> 本机已验证环境：Docker 29.6.2 / Docker Compose v5.3.1，项目根目录 `access/server` + `frontend/webapp` 均就绪。

---

## 0. 前置条件

- 已安装并启动 Docker（Docker Desktop 或 daemon）。
- 本机已 `git clone` 项目到本地路径，如 `C:\Users\Administrator\Documents\WorkBuddy\App\agent-harness-ts`。
- （可选）想要**真实 LLM** 时准备 `OPEN_API_KEY`；不准备也能跑——内置 **Mock LLM 离线模式** 可直接演示运行时面板。

---

## 1. 架构速览（先搞清楚跑起来的是什么）

| 项       | 说明                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 构建     | `Dockerfile` 多阶段：node:22-bookworm 构建 → node:22-bookworm-slim 运行 |
| 进程     | `node access/server/dist/server.js`                                     |
| 监听     | `PORT`（默认 4173）/ `UI_HOST`（默认 0.0.0.0）                          |
| 托管     | server 优先托管 `frontend/webapp/dist`（即我们做的「运行」面板 UI）     |
| 健康检查 | `GET /api/state`（开放端点，无需令牌，返回 200 JSON）                   |
| 运行队列 | 默认内存模式；启用 `redis` profile 后由 Redis 接管（支持多副本）        |
| 运行用户 | 镜像内已用非 root 用户 `ah` 运行                                        |

> 注意：服务器真实健康端点是 `/api/state`（server.ts:283）。早期健康检查误写为 `/api/v1/state`（仅存在于 OpenAPI 文档定义，无真实 handler），现已修正为 `/api/state`，部署后 `docker ps` 应显示 `healthy`。

---

## 2. 快速部署（内存模式，推荐先跑通）

```bash
cd C:\Users\Administrator\Documents\WorkBuddy\App\agent-harness-ts

# 内存模式（无 Redis，单副本）——本地演示首选
docker compose up --build -d
```

- `--build`：首次或代码变更后重建镜像。
- `-d`：后台运行（detached）。
- 构建较慢：会联网拉依赖 + `pnpm -r build`（含 webapp Vite 全量构建），通常几分钟级，请耐心等。

浏览器打开 **http://localhost:4173** 即进入 webapp。

---

## 3. 带运行队列 + 鉴权的部署（redis overlay，推荐用于内网多人）

> ⚠️ **关键坑**：纯 `docker compose --profile redis up` 只会拉起 Redis **容器**，但 base `docker-compose.yml` 里的 `REDIS_URL` 读宿主机环境变量（默认空），应用仍走**内存队列**——Redis 在空转。必须用 `docker-compose.redis.yml` overlay 才会真正把 `REDIS_URL=redis://redis:6379` 注入 ui，并强制要求 `UI_AUTH_TOKEN`。

```bash
# 0) 准备令牌（已为你生成在 .env；如需自签任选其一）
openssl rand -base64 32
# 或：node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 1) 从模板建 .env 并填入令牌（本项目已预置 .env，可直接用）
cp .env.example .env
#   编辑器打开 .env，把 UI_AUTH_TOKEN= 后面填上上面生成的令牌

# 2) 停旧容器 + 用 overlay 重建（redis profile 自动把 REDIS_URL 注入 ui）
docker compose down
docker compose -f docker-compose.yml -f docker-compose.redis.yml --profile redis up --build -d
```

- 自动拉起 `redis:7-alpine` 并挂载数据卷 `redis-data`。
- ui 容器 `REDIS_URL=redis://redis:6379` → 应用日志出现 `[queue-backend] using Redis backend`，运行队列由 Redis 接管（验证：`docker logs <项目名>-ui-1 | grep queue-backend`）。
- `docker-compose.redis.yml` 把 `UI_AUTH_TOKEN` 设为**必填**（`${UI_AUTH_TOKEN:?...}`）：未设令牌则 `up` 直接报错退出，杜绝"开放 UI"误部署。设了令牌后，浏览器需在顶栏「Bearer 令牌」填入同一值。
- 适用：内网多人低并发、需要跨实例共享运行队列 / 水平扩展多个 `ui` 副本时。

---

## 4. 手动 build + run（不依赖 compose）

```bash
# 构建镜像
docker build -t agent-harness:local .

# 运行容器
docker run -d -p 4173:4173 \
  --name ah \
  -e UI_AUTH_TOKEN=change-me \
  -e OPEN_API_KEY=sk-or-xxx \
  -e OPEN_MODEL=agnes-2.5-flash \
  agent-harness:local
```

- `-p 4173:4173`：宿主机端口:容器端口。宿主机端口被占用就改，如 `-p 8080:4173`，访问用 `http://localhost:8080`。
- `--name ah`：给容器命名，便于后续 `docker logs/stop/start ah`。

---

## 5. 环境变量清单

| 变量            | 必填 | 默认            | 说明                                                                           |
| --------------- | ---- | --------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`      | 否   | production      | 运行环境                                                                       |
| `PORT`          | 否   | 4173            | 容器内监听端口                                                                 |
| `UI_HOST`       | 否   | 0.0.0.0         | 绑定地址                                                                       |
| `UI_AUTH_TOKEN` | 否   | 空              | 接口鉴权令牌。**留空 → UI 开放（仅本地演示可接受）；生产务必设强随机值**       |
| `OPEN_API_KEY`  | 否   | 空              | 真实 LLM 密钥。**留空 → 内置 Mock LLM 离线运行**（无需密钥即可演示运行时面板） |
| `OPEN_MODEL`    | 否   | agnes-2.5-flash | OpenRouter 模型名                                                              |
| `REDIS_URL`     | 否   | 空              | 运行队列后端；启用 redis profile 后自动填                                      |

> 本地演示最简形态：两个密钥都**留空**即可。`docker compose up --build -d` 后 Mock 模式直接可用。

---

## 6. 验证部署成功

```bash
# 1) 看容器状态（应为 Up + healthy，start_period 10s 后变 healthy）
docker ps

# 2) 看启动日志（确认 "listening on ..." 之类输出）
docker logs -f ah            # compose 方式：docker logs -f <项目名>-ui-1

# 3) 健康端点
curl http://localhost:4173/api/state
# 期望返回 200 JSON，如 {"ok":true,...}

# 4) 浏览器打开
# http://localhost:4173  → webapp 首页
```

---

## 7. 落地使用：运行时面板（思考 + 结果）

1. 打开 **http://localhost:4173**，左侧导航点 **「运行」**。
2. 在任务输入框填写提示词（如「列出当前目录的 .ts 文件」）。
3. 点 **运行**：
   - **左卡「思考 Trace」** 实时流式展示——阶段步进器（理解 → 规划 → 调用工具 → 推理 → 总结）+ 流式思考块 + 闪烁光标，体现「正在想」。
   - **右卡「最终结果」** 运行中显示 spinner + 骨架占位；完成后显示交付物（步数/花费/工具数）+ 最终答复 + `复制 / 导出 / 重试`。
4. **停止**：运行中可随时中止。
5. **重新运行**：完成后一键重投。
6. **复制 / 导出**：把最终答复或整段轨迹导出为自包含 `.html`。
7. 顶部分段控制 `思考 / 结果 / 全览` 切换主视区；状态 pill 显示 空闲 / 运行中 / 已完成。

> 未配 `OPEN_API_KEY` 时走 Mock，事件流仍是真实的 `StreamEvent` 协议（run:start / step:start / llm:response / tool:result / run:end …），面板交互与真实 LLM 完全一致，只是「思考内容」是 mock 生成。

---

## 8. 日常运维

```bash
# 看日志
docker logs -f ah
# compose 方式：
docker compose logs -f

# 停止
docker stop ah                       # 或 docker compose down（停止并移除容器）
# 重启
docker start ah                      # 或 docker compose restart

# 升级版本（拉新代码后重建）
git pull
docker compose up --build -d         # 会重建镜像并替换容器

# 彻底清理（含 redis 数据卷，数据不可恢复）
docker compose down -v
```

---

## 9. 生产加固建议（上线前看）

- **鉴权**：`UI_AUTH_TOKEN` 务必设为强随机值（如 `openssl rand -hex 32`）；不要让 UI 裸奔公网。
- **TLS / 反代**：在容器前加 Nginx / Caddy 做 HTTPS 与域名转发，不要把 4173 直接暴露公网。
- **持久化**：
  - 运行队列 → 启用 `redis` profile（数据卷 `redis-data`）。
  - 长期记忆 → 配置 `memory.persistencePath` 挂载宿主机卷。
- **严格可复现构建（可选）**：Dockerfile 当前 `corepack prepare pnpm@9 --activate`，但根 `package.json` 的 `packageManager` 是 `pnpm@11.9.0`、锁文件由 11 生成，故 `--frozen-lockfile` 可能版本不一致失败，靠 `|| pnpm install --no-frozen-lockfile` 自愈（依赖会重排）。要严格可复现，把 Dockerfile 的 `pnpm@9` 改为 `pnpm@11`。
- **资源限制**：compose 可加 `deploy.resources` / 裸 `docker run --memory=512m` 防止失控。
- 镜像已默认非 root 运行，无需额外处理。

---

## 10. 常见问题（FAQ）

**Q1：构建特别慢 / 卡在 install？**
A：首次构建需联网拉全部依赖 + Vite 全量构建，几分钟级属正常。若卡死，确认 Docker 有网络访问；`pnpm` 版本不一致时 build 会自动 `--no-frozen-lockfile` 自愈。

**Q2：`docker ps` 显示 unhealthy？**
A：旧镜像打的是 `/api/v1/state`（404）。当前代码已修正为 `/api/state`。若仍 unhealthy，确认是用最新代码 `up --build` 重建的；或手动 `curl http://localhost:4173/api/state` 验证。

**Q3：浏览器打不开 / 端口被占用？**
A：换映射端口，如 `docker run -p 8080:4173 ...`，访问 `http://localhost:8080`。compose 改 `ports: ["8080:4173"]`。

**Q4：没密钥能跑吗？**
A：能。`OPEN_API_KEY` 留空即 Mock LLM 离线模式，运行时面板交互完整可演示。

**Q5：数据重启后没了？**
A：内存模式作业/记忆重启即丢。挂 Redis（redis profile）或配置 `memory.persistencePath` 持久化。

---

## 11. 进阶：上 Kubernetes（可选）

`deploy/k8s/` 目录已含现成 manifests，可作为容器化部署到 K8s 的起点（Deployment + Service + 可选 Redis）。本地先跑通 Docker/Compose 验证镜像行为，再据此调整 K8s 清单。

---

## 附：一键命令速查

```bash
# 内存模式起
docker compose up --build -d
# 带 Redis + 鉴权 起（需先 cp .env.example .env 并填 UI_AUTH_TOKEN）
docker compose -f docker-compose.yml -f docker-compose.redis.yml --profile redis up --build -d
# 看状态
docker ps
# 看健康
curl http://localhost:4173/api/state
# 看日志
docker compose logs -f
# 停
docker compose down
# 停 + 清数据
docker compose down -v
```
