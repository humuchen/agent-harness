# agent-harness 项目健康度复评（2026-10-12）

> 定位：对 2026-10-09 首轮全面评审（`project-health-review-2026-10-09.md`）的**复评**。
> 期间项目完成三轮修复（P0×3、P1 两批 12 项、P2 批 6 项）并落地多项新能力。
> 方法：10-09 报告全量结论为基线，本轮对 25 项问题逐条核实闭环状态 + 全量重测规模/测试/lint 指标 + 复盘 10-09 后新落地的提交（git log 逐条核对）。
> 所有数字均为本机实测（测试套件实跑、wc/grep/git 实测），非估算。

---

## 一、执行摘要

| 维度 | 10-09 | **10-12（本轮）** | 变化说明 |
| --- | --- | --- | --- |
| 功能能力 | 9.0 | **9.3** | 推送投递最后一跳（FCM HTTP v1 + APNs ES256）补齐、agent 心跳自动下线、P6 工作流回滚重放/归档回看、RAG P6 高级检索编排 |
| 运行稳定性 | 单实例 8.5 / 多实例 6.5 | **8.8 / 8.5** | P0-1/2/3 + P1-6/7 多实例正确性四连修、SSE 写竞态根因修复（writeSseFrame 三重守卫）、IM 闸门与强制结算落地 |
| 性能与可靠性 | 7.5 | **8.2** | IM 旁路并发上限补齐、生产默认值反转、预算熔断在位；已知杠杆收敛为两条（RAG 默认路径 / SQLite 单写者；原「压缩默认关」经核实已更正——成本护栏默认在位，见 §六 更正块） |
| 代码质量 | 8.5 | **8.3** | 测试 192→205 文件、cli/mobile 零测试破零；但 **lint 债务浮现**（约 20+ 处源码 error 级违规 + 棘轮基线缺失，CI lint 门禁实际不可绿） |

**总体判断**：10-09 报告列出的 **25 项 P0/P1/P2 问题已闭环 23 项**（P1-9 经重构消解，P2-8 已补大部分，仅 P2-10 未动），多实例部署的正确性阻塞已解除。当前唯一「红色」是 **CI lint 门禁本身失效**（既有 error 违规 + 基线文件缺失），建议最优先处置——它正在让「棘轮防回潮」机制空转。

---

## 二、10-09 评审问题闭环总账（25 项）

| 批次 | 项目 | 状态 | 落点提交 |
| --- | --- | --- | --- |
| P0 | P0-1 租约续期与回收竞态 / P0-2 并发超卖 / P0-3 BYOK 缓存串号 | ✅ 全部修复 | fc21d47 |
| P1 第一批 | P1-1 OAuth state / P1-2 modelApiKey 加密 / P1-5 邮箱正则 / P1-8 生产默认值反转 / P1-10 静默吞错补日志 / P1-11 前端收尾链测试 | ✅ 全部修复 | fc21d47 及同批 |
| P1 第二批 | P1-3 IM 并发闸门+钉钉时间窗 / P1-4 去重兜底 / P1-6 跨实例会话锁 / P1-7 强制结算 / P1-12 事件总线类型化 | ✅ 全部修复 | 537e710 + 48ddfd8 |
| P2 | P2-1 重试语义 / P2-2 sleep 可中断 / P2-3 teams 打分 / P2-4 File 首载 / P2-5 订阅残留 / P2-6 exchange 限额 / P2-7 在线备份 / P2-9 README 分层声明 | ✅ 全部闭环（P2-7 核实已被既有 D4 修复覆盖） | 776c7f5 |
| P2 | **P2-8 CI 缺口** | 🟡 **大部分已补**（dd5aed8：依赖审查/E2E+负载入门禁/GHCR/docker.yml 拆分/cli+mobile 补测试），残留 3 子项（见 R2） | dd5aed8 |
| P2 | **P2-10 Service Worker** | ❌ 未动（webapp src 零命中） | — |
| 非清单 | P1-9 客服插件 rejected promise 缓存 | ✅ 经同步适配器重构自然消解（`getDb()` 已无 promise 缓存语义） | — |

**10-09 后新增的稳定性修复**（非原清单，源自线上事故与后续加固）：

- **SSE 写竞态根因修复**（5d40972）：`res.write()` 的 try/catch 捕获不到异步 `'error'` 事件曾致 uncaughtException → 全量在途请求 503。现统一 `http-helpers.ts` 的 `startSse`/`writeSseFrame` 三重守卫（closed 变量 + `writableEnded/destroyed` + `res.on('error')` 消费），crash-guard 白名单放行流级 benign error。
- **agent 心跳超时自动下线**（687026c）：远程 agent 生产周期 sweep 降权，local 豁免。

---

## 三、项目规模基线（2026-10-12 实测）

| 包 | 代码规模 | 测试 | 对比 10-09 |
| --- | --- | --- | --- |
| backend/core | 25,597 行 .ts | 96 个 .cjs / **741 用例**（全量实跑 45s 全绿） | +1 文件 / 用例数增 |
| access/server | 28,986 行 .ts | 58 个 .cjs / **385 用例**（全量实跑 100s 全绿，2 skip 既有） | 49→58 文件 |
| frontend/webapp | 48,853 行 .ts（chat.ts 5,823 行） | 26 个 .test.ts / **424 用例**（全量实跑全绿） | 25→26 文件 |
| frontend/cli | 941 行 | **1 个真实 e2e**（子进程跑 dist/cli.js，断言 stdout/exit 码/错误映射） | **0→1，破零** |
| mobile | 薄壳（另获推送投递实现） | 1 个 .cjs | **0→1，破零** |
| services/rag | — | 11 个 .cjs | 10→11 |
| plugins ×3 | — | 12 个 .cjs（客服 2 文件 14 用例 / 医美 10 文件） | 11→12 |
| **全仓库** | 937 个 git 追踪文件 | **约 205 个测试文件** | 192→205 |

关键单体文件：harness.ts 1,234 行、workflow/engine.ts 1,523 行、server.ts 2,381 行（10-09 拆出 routes/ 18 模块后仍缓慢增长）。

---

## 四、功能能力评估（9.3 / 10）

### 4.1 10-09 后新增能力（均经源码核实）

1. **移动推送最后一跳**（ce75ddb、aa672f3）：FCM HTTP v1 与 APNs ES256（JWT 签发 + HTTP/2）**零依赖实现**、平台路由与设备派发、三级 SQLite 在线备份——移动端推送从「壳能力」变为端到端闭环。
2. **P6 工作流工程化**：状态快照任意时点回滚重放（688cf0e）、run 过程归档与历史执行回看（7312b49）。
3. **RAG P6 高级检索**：ParentDocument 父子切分、multi-query RRF、HyDE、golden 回归套件 + strict 门禁批跑 CLI（0abaf35、9cf90f8）。
4. **CI/CD 扩容**：GHCR 镜像构建推送、PR 依赖安全审查、E2E 冒烟（真实进程 + SSE 重连 + 负载小门禁）纳入 PR 流水线、CI 拆分出 docker.yml（dd5aed8）。
5. **JSON-Schema 校验器增强**：`not` 与 `$ref` fail-closed（dd5aed8）。

### 4.2 修复带来的能力补强

- teams competitive 模式打分由「长度×权重」改为饱和曲线（长度中性化，权重主导排名），多智能体竞赛语义首次成立（776c7f5）。
- IM 桥接具备生产级闸门：并发上限（inflight 2 / FIFO 等待 8 / 双满快速拒绝）、钉钉毫秒时间戳防重放、去重键 provider 前缀（537e710）。
- 计划模式交付链、跨实例会话锁、看门狗强制结算——前两轮已述，不再重复。

### 4.3 维持 10-09 结论的部分

- 13 个多智能体基座子系统无壳模块；文档宣称能力与实现一一对应。
- 空白不变：多租户运营面（开通/配额/账单）、正式合规模块（SOC2/GDPR 数据主权分区）未落地（已声明属 SaaS 化范畴）。
- **teams 仍纯内存**（打分已修，持久化未做，文档已声明分层取舍）；subagent 仍偏簿记。

---

## 五、运行稳定性评估（单实例 8.8 / 多实例 8.5）

### 5.1 防线现状（逐项核实）

1. **多实例正确性四点闭合**：租约心跳续租 + Lua 原子回收（P0-1）、claim 后并发复查（P0-2）、跨实例会话锁（SET NX PX + sha256 摘要键 + token 校验释放 + releaseClaim 原子退回，P1-6）、看门狗第二层强制结算（`Promise.race` + 30s grace，P1-7）。
2. **SSE 长连接竞态根修**：写后 end 的异步 error 不再击穿 crash-guard；crash-guard 白名单区分「流级 benign error」与「真进程级故障」。
3. **逐点防逃逸异步防线**（10-09 核实项，持续有效）：LLM 竞速落选挂 catch、工具 rejection 转已决值、引擎在途兜底。
4. **数据安全三件套 + 备份链**：tmp+rename 原子写、坏文件隔离、backup-db SQLite 在线备份 + restore 前完整性校验（P2-7 核实闭环）。
5. **优雅停机 / 健康探针 / 三层可观测**：维持 10-09 结论；`LOG_SCRUB_ENABLED` 与 `MAX_SSE_CONNECTIONS` 默认值已反转（P1-8）。

### 5.2 遗留风险

- **SSE 收敛残余（R3）**：主链路已统一走 `writeSseFrame` 三重守卫，但 run-routes `handleWorkflow`、ops-routes verify/env、server.ts resume ×2 的 `res.end()` 收尾仍靠手写 `closed` 守卫——语义正确但「靠纪律不靠机制」，同类竞态窗口未来新增站点时可能复发。
- **CI lint 门禁实际不可绿（R1，本节也属稳定性——门禁失效本身就是流程稳定性风险）**：详见 §八 R1。
- git 仓库深层 reflog 残留损坏对象（R6）：不影响日常提交，但 auto-repack 每次报错，长期需清理。

---

## 六、性能与可靠性评估（8.2 / 10）

**正面（新增）**

- IM 旁路并发闸门补齐后，**LLM 调用洪峰面收敛**：非队列执行路径被封顶（P1-3 修复），叠加 `RUN_CONCURRENCY`、workflow 波次上限 `WF_MAX_CONCURRENCY=16`、计划波宽缺省并发 3，三级并发预算闭合。
- P1-8 默认值反转后，日志脱敏与 SSE 连接上限默认生效，洪峰下的内存与连接面有界。
- cli/mobile E2E 与负载测试进入 PR 门禁，性能回归有了基线信号（容量基准采集模式，不判阈值防 runner 抖动）。

**维持 10-09 的三个已知杠杆（均为配置级取舍，非缺陷）**

> **更正（2026-10-12 晚，R7 落地时核实）**：原第 1 条「`CONTEXT_COMPRESSION` 默认关 →
> 长对话成本 O(steps²)」与源码不符。实际（`harness.ts:488-501`）：每次发送前**无条件**
> 执行 `foldStaleToolResults()`（陈旧工具结果折叠）+ `fitToBudget`（确定性预算剪枝，
> 目标窗口占用 ≈68%）——成本护栏**默认在位**；`CONTEXT_COMPRESSION` flag 主路径未消费
> （遗留定义），`JEV_CONTEXT_COMPRESS=on` 仅是可选的 Jev 打分增强。生产操作收敛为
> RAG 与数据库两条，全部固化到 `docs/02-deployment/production-checklist.md`。

1. ~~`CONTEXT_COMPRESSION` 默认关~~ → **已更正**：护栏默认在位，无必做操作；可选增强见检查单 §1。
2. RAG 默认路径 HashEmbedding + JSON 全量加载：生产必须切远程 embedding + qdrant（检查单 §2）。
3. SQLite 跨会话高频写受 WAL 单写者限制：多副本场景应切 Turso/MySQL（db-adapter 已支持，配置错误 fail-fast）（检查单 §3）。

---

## 七、代码质量评估（8.3 / 10）

**维持优秀的部分**

- 四层分界纪律（core 零业务耦合 / server 接口+默认实现+组合工厂 / plugins 业务隔离 / webapp 纯消费 /api/v1）。
- 依赖健康：core 运行时依赖仅 3 个，可选依赖全有降级路径；pnpm minimumReleaseAge + audit 门禁。
- 本轮新增代码（teams/engine/harness/queue-backend/tests）`no-explicit-any` 全 0、变更行 lint 零违规。

**债务变化**

- ✅ 改善：测试文件 192→205，cli/mobile 破零；chat.ts 拆分轨迹持续（chat-block-fold / chat-render-utils / chat-run-runtime / chat-plan-finalize / chat-plan-restore 等抽离模块均有测试，plan 收尾链有源码锚点守护）。
- ❌ 恶化：**lint 债务浮现**——eslint error 级规则在 10-09 时「已验证 0 处违规」，此后新落地的约 20+ 处源码违规（`no-useless-assignment` 为主）无人拦截，因为 **棘轮基线文件（`scripts/eslint-any-baseline.json`）实际不存在**，CI lint 步骤当前必然失败——防回潮机制整体空转（R1）。
- 持平：chat.ts 本体 5,823 行未减；server.ts 2,381 行缓增。

---

## 八、当前问题清单与建议（按优先级）

### R1（高）CI lint 门禁失效 + 棘轮基线缺失 —— 建议一周内处置

- **证据**：本机全量 eslint 实测 365 处 error；其中 mobile 构建产物（未入 git，本地噪音）约 340 处，**tracked 源码约 20+ 处**（`no-useless-assignment` ×14、`no-control-regex` ×5、`no-self-assign`、`no-unsafe-function-type`、`require-yield` 等，分布在 access/server、backend/core、backend/client、frontend/webapp、medical-ad-guard）；`scripts/eslint-any-baseline.json` 不存在，棘轮脚本「基线缺失拒绝运行」也失败 → `pnpm lint` 步骤当前不可能绿。
- **建议**：① `eslint.config.js` ignores 补 `mobile/**/assets/**`（本地体验）；② 一次性机械清理约 20 处源码 error（多为赋值后未读与控制字符正则，半日内工作量）；③ `node scripts/lint-any-ratchet.cjs --update` 生成并提交基线；④ 之后 lint 门禁恢复绿色，棘轮重新生效。

### R2（中）P2-8 残留子项

- SBOM（ci.yml:91）与回滚 verify（ci.yml:95）仍 `continue-on-error: true`；无覆盖率门禁；ci.yml 单文件仍承载 test/e2e/deploy/nightly 四职责。
- 建议：SBOM 失败应阻断（先决条件是 runner docker 稳定）；PR 门禁的 rollback verify 可移除 continue-on-error（完整链路已在 nightly）；覆盖率与 workflow 再拆分按迭代节奏。

### R3（中）SSE 收尾原语统一

- 4 处站点的 `res.end()` 时序仍手写守卫。建议在 `http-helpers.ts` 增加 `endSse(res, closedRef, timer?)` 收尾原语（先置 closed + 清心跳 + 再 end），逐站点替换，消除「靠纪律不靠机制」。

### R4（中）P2-10 Service Worker（维持 10-09 建议）

- 断网仅保偏好不保视图。最小 app-shell SW 即可显著改善；注意不拦截 `/api/stream` SSE 与认证请求。

### R5（低）teams 持久化与 subagent 深度

- teams 打分已修；Team 注册表与轮次计数器仍进程内，多实例下 competitive vote 各实例独立。建议接入 Redis store（与队列后端同范式）或在文档明示单实例边界。

### R6（低）git 仓库深层损坏对象

- reflog 残留 invalid entry / missing tree，commit 后 auto geometric-repack 报 `bad tree object`；HEAD 链完整、日常不受影响。建议择机 `git reflog expire --expire=now --all && git gc --prune=now`（会丢 reflog 历史，执行前确认）或重建克隆。

### R7（信息）测试分布微调

- 客服插件 2 文件 14 用例 vs 医美 10 文件；建议客服插件补 order 状态机与转人工路径的用例。RAG 11 文件覆盖良好。

### R8（信息）长注释沉淀

- server.ts 内「已修复历史事故」类长注释持续累积，建议定期沉淀为 docs 回归清单（10-09 已提，维持）。

---

## 九、结论

1. **功能**：三轮修复 + 新能力落地后，宣称能力与实现的对齐度进一步提升；推送闭环与工作流回放是本轮最大功能增量。评分 9.0 → 9.3。
2. **稳定性**：多实例部署的正确性阻塞（P0-1/2/3、P1-6/7）已全部解除，SSE 竞态根修消除了线上 503 类事故的复发面。多实例评级 6.5 → 8.5；剩余为机制统一（R3）而非正确性缺陷。
3. **性能**：并发预算三级闭合、默认值安全化；已知杠杆收敛为两条配置取舍（RAG / 数据库，见 §六 更正块），已固化到 `docs/02-deployment/production-checklist.md`。
4. **质量**：测试网显著增厚（205 文件，cli/mobile 破零）；唯一结构性恶化是 **lint 门禁失效**（R1），它威胁「存量锁定 + 禁止增量」机制的长期有效性——这是当前最值得优先投入的半小时工程。
5. **建议动作顺序**：R1（lint 恢复绿色 + 基线入库）→ R2（SBOM/verify 阻断化）→ R3（SSE 收尾原语统一）→ R4（SW）→ R5/R6 择机 → R7/R8 随迭代。
