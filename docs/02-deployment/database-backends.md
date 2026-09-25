# 数据库后端与租户数据分区

> 状态：**已落地**（MySQL/PostgreSQL 方言层 → 租户数据分区 → sqlite/turso 搬迁工具）。
> 所有 SQLite 存储（记忆 / 账户 / 历史 / 插件库等）经由统一适配器，可整体切换后端，store 层代码零改动。

## 1. 后端矩阵

`DB_BACKEND` 切换全局数据库后端（影响记忆/账户/历史/插件等所有经 `getDbAdapter()` 的存储）：

| 后端                            | 配置                                                                             | 驱动                                                         | 语义                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `sqlite`（默认）                | `DB_SQLITE_FILE`（默认 `./data/app.db`）                                         | Node 22+ 内置 `node:sqlite`，零 npm 依赖                     | 本地单机；turso 初始化失败自动降级到它                                                                           |
| `turso`                         | `TURSO_URL`（`libsql://`/`https://`/`wss://` 远端，`file:` 本地）+ `TURSO_TOKEN` | `@libsql/client`（**可选依赖**，缺失自动降级 sqlite 并告警） | 云端 SQLite；`DB_FAILOVER_LOCAL=on` 可开启运行期远端 → 本地 failover（降级窗口写操作需人工对账）                 |
| `mysql`                         | `DATABASE_URL=mysql://user:pass@host:3306/db`                                    | `mysql2`（常规依赖）                                         | **fail-fast**：URL 缺失或 scheme 与后端不匹配时启动即抛错，绝不静默降级 sqlite（数据落错地方比启动失败更难收拾） |
| `postgres`（别名 `postgresql`） | `DATABASE_URL=postgres://user:pass@host:5432/db`                                 | `pg`（常规依赖）                                             | 同上 fail-fast；连接池                                                                                           |

```bash
# 本地默认（零配置）
DB_BACKEND=sqlite DB_SQLITE_FILE=./data/app.db

# Turso 云端
DB_BACKEND=turso TURSO_URL=libsql://your-db.turso.io TURSO_TOKEN=eyJ...

# MySQL / PostgreSQL
DB_BACKEND=mysql  DATABASE_URL=mysql://user:pass@host:3306/agent_harness
DB_BACKEND=postgres DATABASE_URL=postgres://user:pass@host:5432/agent_harness
```

## 2. 方言层（`db-dialect.ts`）

store 层统一写 SQLite 方言 SQL，适配器出口按目标方言**自动翻译**，store 层零改动。覆盖面 =
项目实际使用的 SQL 形态（简单 DDL + 参数化 DML）：

- **DDL**：`TEXT PRIMARY KEY`（MySQL TEXT 不能做主键 → `VARCHAR(255)`）、`AUTOINCREMENT`
  （MySQL → `INT AUTO_INCREMENT`；PG → identity 列）、`BLOB`（PG → `BYTEA`）、`datetime('now')`；
- **DML**：`INSERT OR IGNORE`、`ON CONFLICT(...) DO UPDATE SET`（`excluded.col`）；
- **PG 占位符**：`?` → `$1..$n`（跳过单引号字面量内的 `?`）；
- **明确不翻译**：窗口函数、CTE、复杂子查询（仓库内不存在此类 SQL）。

## 3. 租户数据分区（物理隔离）

`resolveTenantDbPath()`（`db-adapter.ts`）+ `TENANT_DATA_ZONE` 实现 **per-zone 物理分区**：
sqlite 后端下，传入 dataZone（如 `medical` / `financial`）时库文件落 `./data/<zone>/app.db`，
不同合规域数据物理分文件；zone 名仅允许 `[a-z0-9_-]`（杜绝路径穿越）。与
`ComplianceProfile.dataResidency` 及审计事件 `dataZone` 字段联动，满足合规审计维度。
turso 后端的分区由 `TURSO_URL` 指向的远端库决定。

## 4. 迁移与运维工具

| 脚本                     | 作用                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------------ |
| `scripts/db-copy.cjs`    | **sqlite ↔ turso 数据搬迁**：本地库 ↔ Turso 云端库双向复制（先建表后灌数据）                        |
| `scripts/db-migrate.cjs` | 执行 `migrations/` SQL 迁移（启动期由 server 自动调用；`AH_STARTUP_CRITICAL=1` 时迁移失败阻断启动） |
| `scripts/smoke-db.cjs`   | 数据库冒烟：建表 / 写入 / 读回，验证后端连通性                                                      |
| `scripts/backup-db.cjs`  | 备份 / 列表 / 恢复（`pnpm backup:db[:list                                                           | :restore]`） |

## 5. 注意事项

- **缓存与自愈**：适配器进程级单例（按 backend+url+file 键缓存）；`close()` 会同步删缓存，
  下次 `getDbAdapter` 重新建连（关闭后自愈，避免复用已关闭实例的 "Client was manually closed"）。
- **降级串库防护**：turso 降级实例的缓存键并入本地 `localFile`，不同调用方不会复用彼此文件句柄
  （修复过跨 store 数据串库缺陷）；降级时绝不把远程 URL 当本地文件名开库。
- **多实例**：sqlite 仅单机；多副本部署请用 turso / mysql / postgres（或按租户分区后各副本
  挂共享卷）。k8s 侧记忆持久化仍推荐 RWX 卷 + `MEMORY_BACKEND=file/sqlite`（见
  [`k8s-deploy-guide.md`](k8s-deploy-guide.md)）。
