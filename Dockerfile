# agent-harness —— 多阶段 Docker 镜像
#
# 目标：把 pnpm monorepo 构建为可独立部署的 ui 服务镜像。
# 运行时只需 access/server/dist（HTTP+SSE 服务）、backend/core/dist（被 server 依赖）
# 以及生产依赖（MCP SDK / 可选 ioredis）。
#
# 构建（需联网拉取依赖）：
#   docker build -t agent-harness:local .
# 运行：
#   docker run -p 4173:4173 \
#     -e OPEN_API_KEY=sk-or-... \
#     -e REDIS_URL=redis://redis:6379 \
#     agent-harness:local
#
# 说明：
# - 基础镜像锁定 Node 22（与 engines: 22.x / render.yaml 一致）。
# - 使用 corepack 提供的 pnpm；锁文件漂移时降级为 --no-frozen-lockfile 自愈。
# - webapp（Vite+Lit）在 `pnpm -r build` 阶段一并构建，server 会优先托管
#   frontend/webapp/dist（无 public 兜底目录）。
# - runtime 用 slim 镜像；此处采用“复制 builder 已构建产物”的稳妥策略，
#   保证 pnpm 的 workspace 软链（node_modules/@agent-harness/*）与 frontend/* / access/* / backend/*
#   相对布局一致、可被 Node 解析。若追求更小体积，可改用 `pnpm deploy`
#   （见下方注释的进阶方案）。
#
# ⚠️ 镜像源说明（网络受限环境）：
# - 默认 NODE_BASE 使用 quay.io 的 node 镜像（quay.io/nodejs/node），
#   因为本环境直连 Docker Hub 被网络策略拦截；quay.io 镜像与 Docker Hub
#   官方 node 镜像内容一致（同为官方 node 构建产物）。
# - 依赖安装走 npmmirror（registry.npmmirror.com），规避 npmjs.org 网络限制。
# - 若你的生产集群可直连 Docker Hub（或自建 registry 代理），切换回官方镜像并去掉
#   npmmirror 即可：
#     docker build \
#       --build-arg NODE_BASE=node \
#       --build-arg NODE_TAG=22-bookworm-slim \
#       -t agent-harness:local .

# ----------------------------- 构建参数 -----------------------------
# 默认走 quay.io 镜像（Docker Hub 在本环境被拦截时的可达替代源）。
ARG NODE_BASE=quay.io/nodejs/node
ARG NODE_TAG=22-bookworm

# ----------------------------- 构建阶段 -----------------------------
FROM ${NODE_BASE}:${NODE_TAG} AS build
# 依赖安装走国内可达的 npmmirror，规避 npmjs.org 网络限制（同时供 pnpm 自身安装）。
ENV npm_config_registry=https://registry.npmmirror.com
# 不使用 corepack：本环境经 npmmirror 拉取 pnpm 时 corepack 的签名校验会失败
# （Cannot find matching keyid）。改为直接用 npm 安装 pnpm。
# 注意：quay.io 上的 node 镜像停留在 v22.5.1，而 pnpm 11.9 要求 Node>=22.13，
# 因此这里用 pnpm@10（lockfileVersion 同为 9.0，可正常消费现有锁文件）。
# 生产环境若用官方 node:22-bookworm-slim（Node>=22.13），可改回 pnpm@11.9.0。
# 先禁用 corepack 并清理可能残留的 pnpm，再安装并校验版本，避免命中缓存中的旧 pnpm。
RUN corepack disable 2>/dev/null || true \
 && npm remove -g pnpm 2>/dev/null || true \
 && npm install -g pnpm@10 \
 && pnpm --version

WORKDIR /app

# 先装依赖（利用层缓存）：仅拷贝清单文件，再 install。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY backend/core/package.json backend/core/package.json
COPY access/server/package.json access/server/package.json
COPY backend/client/package.json backend/client/package.json
COPY frontend/webapp/package.json frontend/webapp/package.json
# 去掉根 package.json 的 packageManager 字段：否则 pnpm@10 会按该字段
# （pnpm@11.9.0）通过 corepack 重新拉起 11.9.0，而 11.9.0 要求 Node>=22.13，
# 在本环境的 node 22.5.1 上会直接报错。仅影响构建容器内副本，不改动源码。
RUN node -e "const fs=require('fs');const f='package.json';const p=JSON.parse(fs.readFileSync(f));delete p.packageManager;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

# 再拷源码并构建部署所需的包（server + 其依赖 core/mcp-sdk，以及 webapp + 其依赖 client）。
# 不构建 cli：cli 是开发期命令行工具，不进入运行镜像；且在 pnpm@10（本环境受 node 22.5.1
# 限制而使用）下 cli 的 tsc 解析有兼容性问题，官方环境用 pnpm@11.9 不受影响。
COPY . .
# COPY . . 会把带 packageManager 的根 package.json 覆盖回来，这里再次剥离，
# 否则 pnpm 会按 packageManager(pnpm@11.9.0) 重新拉起高版本 pnpm 而失败。
RUN node -e "const fs=require('fs');const f='package.json';const p=JSON.parse(fs.readFileSync(f));delete p.packageManager;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
RUN pnpm --filter "@agent-harness/server..." --filter "@agent-harness/webapp..." build

# 编译 OS 级沙箱原生 helper（Linux only）。
# 生产镜像必须产出 helper：用 HARNESS_NATIVE_STRICT=1 使「非 Linux / 缺编译器 / 缺库」一律失败，
# 杜绝「以为有强隔离、其实静默降级为弱隔离」的安全错配（曾为稳定性隐患）。
# 若确有理由不启用 OS 沙箱，应在构建期显式 HARNESS_NATIVE_STRICT=0 并以
# SANDBOX_BACKEND=local/container 覆盖默认隔离级别，而非依赖静默降级。
# 先 best-effort 装 C 工具链与可选依赖库（libseccomp/libcap）。
RUN (apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libseccomp-dev libcap-dev && rm -rf /var/lib/apt/lists/*) 2>/dev/null || true
ARG HARNESS_NATIVE_STRICT=1
RUN HARNESS_NATIVE_STRICT=${HARNESS_NATIVE_STRICT} bash scripts/build-native.sh

# ----------------------------- 运行阶段 -----------------------------
FROM ${NODE_BASE}:${NODE_TAG} AS runtime
ENV NODE_ENV=production
ENV PORT=4173
ENV UI_HOST=0.0.0.0
WORKDIR /app

# 复制运行所需：node_modules（含 workspace 软链）与 packages 编译产物。
# 注意：backend 全量复制已包含原生 helper 产物 backend/core/native/sandbox-exec/build/sandbox-exec，
# 无需再单独 COPY（单独 COPY 在「未编译出 build 目录」时反而会导致构建失败）。
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/access ./access
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend ./frontend
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json
# 运行期共享库：若 helper 以 libseccomp/libcap 编译，则运行需对应 .so（best-effort，失败不阻断）。
RUN (apt-get update && apt-get install -y --no-install-recommends libseccomp2 libcap2 && rm -rf /var/lib/apt/lists/*) 2>/dev/null || true

# 以非 root 运行。
RUN groupadd -r ah && useradd -r -g ah -d /app -s /usr/sbin/nologin ah && chown -R ah:ah /app
USER ah:ah

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "access/server/dist/server.js"]

# ----------------------------- 进阶：pnpm deploy 体积精简（可选） -----------------------------
# 若想进一步减小镜像，可放弃“复制 builder 全量 node_modules”，改为在 build 阶段末尾执行：
#   RUN pnpm --filter @agent-harness/server deploy --legacy --prod /out
# 并在 runtime 仅 COPY --from=build /out ./  （/out 已含 ui + core 运行产物 + 生产依赖）。
# 注意：server 当前标记 private:true；若使用 deploy 方案，需先评估 pnpm 对 private 包的部署限制（或改为可发布包）。
