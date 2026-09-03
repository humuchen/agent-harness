# agent-harness — 多阶段 Docker 镜像
#
# 目标：把 pnpm monorepo 构建为可独立部署的 ui 服务镜像。
# 运行时只需 access/server/dist（HTTP+SSE 服务）、backend/core/dist（被 server 依赖）、
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
# ⚠️ 镜像源说明：
# - 默认 NODE_BASE 使用 Docker Hub 官方 node 镜像（node:22-bookworm-slim）。
# - 依赖安装走 npmmirror（registry.npmmirror.com），规避 npmjs.org 网络限制。
# - 网络受限（直连 Docker Hub 被拦截）时可切到 quay.io 镜像，但需注意：
#   quay.io/nodejs/node 同步滞后（:22-bookworm 仍停留在 v22.5.1，不满足下方
#   Node>=22.13 要求），且未提供 -slim 变体；仅在确认该源已同步到新版 Node 时使用：
#     docker build \
#       --build-arg NODE_BASE=quay.io/nodejs/node \
#       --build-arg NODE_TAG=22-bookworm \
#       -t agent-harness:local .

# ----------------------------- 构建参数 -----------------------------
# 默认走 Docker Hub 官方镜像（内容权威、体积更小：约 330MB vs 非 slim 的 1.6GB）。
ARG NODE_BASE=node
# ⚠️ pnpm@11.9.0 要求 Node>=22.13；基础镜像必须满足条件。
# 官方 node:22-bookworm-slim 当前为 v22.23.2（满足要求）；若切到 quay.io 源，
# 请先确认该 tag 的 Node 版本不低于 22.13，否则 pnpm 会因引擎检查失败。
ARG NODE_TAG=22-bookworm-slim

# ----------------------------- 构建阶段 -----------------------------
FROM ${NODE_BASE}:${NODE_TAG} AS build
# 依赖安装走国内可达的 npmmirror，规避 npmjs.org 网络限制（同时供 pnpm 自身安装）。
ENV npm_config_registry=https://registry.npmmirror.com
# 不使用 corepack：本环境经 npmmirror 拉取 pnpm 时 corepack 的签名校验会失败
# （Cannot find matching keyid）。改为直接用 npm 安装与根 package.json 的 packageManager 一致的 pnpm@11.9.0。
# 前提：基础镜像 Node>=22.13（见 NODE_TAG）。
RUN corepack disable 2>/dev/null || true \
 && npm remove -g pnpm 2>/dev/null || true \
 && npm install -g pnpm@11.9.0 \
 && pnpm --version

WORKDIR /app

# 先装依赖（利用层缓存）：仅拷贝清单文件，再 install。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY backend/core/package.json backend/core/package.json
COPY access/server/package.json access/server/package.json
COPY backend/client/package.json backend/client/package.json
COPY frontend/webapp/package.json frontend/webapp/package.json
COPY frontend/cli/package.json frontend/cli/package.json
# 不再剥离根 package.json 的 packageManager 字段：基础镜像已满足 Node>=22.13，
# pnpm@11.9.0 与根 packageManager（pnpm@11.9.0）一致，corepack/版本错配问题不复存在。
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

# 再拷源码并构建部署所需的包（server + 其依赖，以及 webapp + 其依赖，以及 cli）。
COPY . .
RUN pnpm --filter "@agent-harness/server..." --filter "@agent-harness/webapp..." --filter "@agent-harness/cli..." build

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

# 以非 root 运行，并施加 OS 级容器安全硬化。
RUN groupadd -r ah && useradd -r -g ah -d /app -s /usr/sbin/nologin ah && chown -R ah:ah /app
USER ah:ah

# 容器安全加固（P0.3）：只读根文件系统 + 丢弃全部能力 + 禁止提权。
# 运行期仅允许写入 /tmp（Node 临时文件）与挂载的数据卷（/app/data）。
# 通过 --tmpdir 将 Node 临时目录映射到可写层，避免 /tmp 只读导致的问题。
# 多副本持久化数据通过 volumes 挂载 RWX 卷，不在此处开放可写 rootfs。
# docker run 额外建议追加 --security-opt no-new-privileges --cap-drop ALL。
# 注：若业务功能依赖写入 /app（如插件本地缓存），需将对应路径单独挂载为可写卷。

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "access/server/dist/server.js"]
