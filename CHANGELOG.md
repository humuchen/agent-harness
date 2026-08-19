# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 格式。

---

## [0.1.0] - 2026-08-19

### ✨ 新增功能

#### 核心架构

- 三层插件化架构(Core层、Server层、Webapp层)
- pnpm monorepo工作区管理(7个包)
- RBAC鉴权系统(admin/operator/viewer)
- 审批工作流(InMemoryApprovalPolicy)
- 多队列后端支持(Memory/File/Redis)

#### 医疗客资插件

- 线索资质评估与留资
- 号源管理与预约系统
- 事务级防超卖机制
- 线索阶段单调推进(不回退)
- 知识库检索服务
- 发件箱投递系统
- 看板统计与漏斗分析

#### 医疗广告合规护栏

- 5大合规规则拦截
  - 绝对化承诺检测
  - 诊断话术拦截
  - 术前术后对比过滤
  - 固定价承诺拦截
  - 贬低同业检测
- 知识库查空硬拦截

### 🧪 测试覆盖

#### P0 测试 (96%通过率)

- Server包单元测试(44/44通过)
  - RBAC鉴权测试
  - 审批工作流测试
  - 队列后端测试
- 医疗广告合规测试(21/21通过)
  - 5大规则覆盖
  - 知识库拦截测试
- 插件E2E测试(7/8通过,87.5%)
  - 完整业务链路测试
  - 号源防超卖测试
  - 线索阶段不回退测试

#### P1 测试

- API集成测试(5个核心端点)
  - `/api/state` 系统状态
  - `/api/v1/run` Job生命周期
  - `/api/v1/approvals` 审批工作流
  - `/api/v1/eval` 评估端点
  - `/` 健康检查
- 性能/负载测试脚本
  - 支持并发控制
  - P50/P95/P99百分位统计
  - 详细报告生成
- Webapp构建验证

### 🔧 工程改进

#### TypeScript配置

- 统一继承`tsconfig.base.json`
- CLI包减少8行重复配置
- 所有包配置一致性提升

#### 脚本工具

- `pnpm test:load` - 默认负载测试
- `pnpm test:load:heavy` - 重压测试(50并发/500请求)
- `pnpm test` - 全量测试套件

### 📚 文档

#### 架构文档

- `docs/01-architecture/` - 架构设计
  - architecture.md - 系统架构
  - execution.md - 执行流程
  - modules.md - 模块说明
- `docs/02-deployment/` - 部署指南
  - docker-deploy-guide.md - Docker部署
  - k8s-deploy-guide.md - K8s部署
  - multi-instance-runbook.md - 多实例运行
- `docs/03-plugins/` - 插件开发
  - agent-plugin-architecture.md - 插件架构
  - customer-service-agent-design.md - 客服Agent设计
- `docs/04-agents/` - Agent设计
  - medical-aesthetics-lead-agent.md - 医美客资Agent

#### 改进计划

- IMPROVEMENT-PLAN.md - 项目改进计划
- P0-SUMMARY.md - P0完成总结
- P1-SUMMARY.md - P1完成总结

### 🚀 部署

#### Docker

- 多阶段构建优化
- docker-compose.yml - 单机部署
- docker-compose.redis.yml - Redis支持
- Dockerfile - 生产镜像

#### Kubernetes

- 完整K8s配置(deploy/k8s/)
  - deployment.yaml - 部署配置
  - service.yaml - 服务配置
  - ingress.yaml - 入口配置
  - hpa.yaml - 自动扩缩容
  - configmap.yaml - 配置管理
  - secret.yaml - 密钥管理
- kustomize支持(deploy/overlays/local/)

### 📦 技术栈

- **运行时**: Node.js 22.x
- **包管理**: pnpm 11.9.0
- **TypeScript**: 5.4.5
- **框架**:
  - Vite 5.4.11 (Webapp)
  - Lit 3.2.1 (前端组件)
- **数据库**: SQLite (better-sqlite3)
- **缓存**: Redis (ioredis 5.4.1, 可选)
- **MCP SDK**: 1.12.1

### ⚠️ 已知问题

- 插件E2E测试1个失败用例(线索阶段不回退测试偶尔失败)
- 插件市场registry server未实现(仅接口层)

### 📋 待办事项

#### P2 - 开发者体验

- [ ] 示例代码注释完善
- [ ] 插件开发脚手架
- [ ] 错误码文档

#### P3 - 架构增强

- [ ] 健康检查端点标准化(/health/live, /health/ready)
- [ ] 特性开关框架
- [ ] 数据迁移脚本

---

## 格式说明

- `✨ 新增功能` - 新功能
- `🐛 修复` - Bug修复
- `🔧 工程改进` - 代码质量、工具链等
- `📚 文档` - 文档更新
- `🚀 部署` - 部署相关
- `⚠️ 已知问题` - 已知限制
- `📋 待办事项` - 计划中的工作
