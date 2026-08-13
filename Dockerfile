# agent-harness —— 多阶段 Docker 镜像
#
# 目标：把 pnpm monorepo 构建为可独立部署的 ui 服务镜像。
# 运行时只需 packages/server/dist（HTTP+SSE 服务）、packages/core/dist（被 server 依赖）
# 以及生产依赖（MCP SDK / 可选 ioredis）。
#
# 构建（需联网拉取依赖）：
#   docker build -t agent-harness:local .
# 运行：
#   docker run -p 4173:4173 \
#     -e OPENROUTER_API_KEY=sk-or-... \
#     -e UI_AUTH_TOKEN=change-me \
#     -e REDIS_URL=redis://redis:6379 \
#     agent-harness:local
#
# 说明：
# - 基础镜像锁定 Node 22（与 engines: 22.x / render.yaml 一致）。
# - 使用 corepack 提供的 pnpm；锁文件漂移时降级为 --no-frozen-lockfile 自愈。
# - webapp（Vite+Lit）在 `pnpm -r build` 阶段一并构建，server 会优先托管
#   packages/webapp/dist（无 public 兜底目录）。
# - runtime 用 slim 镜像；此处采用“复制 builder 已构建产物”的稳妥策略，
#   保证 pnpm 的 workspace 软链（node_modules/@agent-harness/*）与 packages/*
#   相对布局一致、可被 Node 解析。若追求更小体积，可改用 `pnpm deploy`
#   （见下方注释的进阶方案）。

# ----------------------------- 构建阶段 -----------------------------
FROM node:22-bookworm AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11 --activate

WORKDIR /app

# 先装依赖（利用层缓存）：仅拷贝清单文件，再 install。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/webapp/package.json packages/webapp/package.json
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

# 再拷源码并全量构建（拓扑序：core → client → ui → webapp）。
COPY . .
RUN pnpm -r build

# ----------------------------- 运行阶段 -----------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=4173
ENV UI_HOST=0.0.0.0
WORKDIR /app

# 复制运行所需：node_modules（含 workspace 软链）与 packages 编译产物。
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json

# 以非 root 运行。
RUN groupadd -r ah && useradd -r -g ah -d /app -s /usr/sbin/nologin ah && chown -R ah:ah /app
USER ah:ah

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/server.js"]

# ----------------------------- 进阶：pnpm deploy 体积精简（可选） -----------------------------
# 若想进一步减小镜像，可放弃“复制 builder 全量 node_modules”，改为在 build 阶段末尾执行：
#   RUN pnpm --filter @agent-harness/server deploy --legacy --prod /out
# 并在 runtime 仅 COPY --from=build /out ./  （/out 已含 ui + core 运行产物 + 生产依赖）。
# 注意：server 当前标记 private:true；若使用 deploy 方案，需先评估 pnpm 对 private 包的部署限制（或改为可发布包）。
