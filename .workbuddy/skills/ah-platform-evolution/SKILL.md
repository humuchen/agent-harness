---
name: ah-platform-evolution
description: Use this skill when extending the agent-harness TypeScript monorepo (backend/core + access/server) with new platform-level capabilities — agent registry/discovery, task routing/dispatcher, tenant isolation/policy, workflow orchestration (DAG + compensation), A2A, or plugin framework. It encodes the project's non-negotiable conventions learned while building the unified orchestration base: evolve-don't-rewrite, all-new-fields-optional back-compat with a seeded `default` agent, env-switch feature degradation, the `assembleAgent(card?, tenantCtx?)` assembly-recipe pattern, composite `tenant::session` memory keys, JSON-only entity types, and the isolated `tsc` toolchain + `node --test` verification loop.
---

# agent-harness Platform Evolution（注册壳 / Registration Shell）

> **本文件只是「注册入口」，不是技能本体。**
> 技能的完整内容已迁出 `.workbuddy/`，作为仓库顶层独立模块 `skills/` 维护。

## 动手前必须先读取完整内容

→ **[`skills/ah-platform-evolution/SKILL.md`](../../../skills/ah-platform-evolution/SKILL.md)**

读取后再按其中的「Core Conventions」与「Step-by-Step Playbook」执行。该模块同时包含：

- `references/architecture.md` — 文件/函数锚点、类型签名、`assembleAgent` 收窄模式、`NetworkPolicy`/`checkEgress` 出网管控设计、行业 profile 映射（金融/医疗/教育）、以及 P0 基线（agents/router/tenant/policy）之上的 P1（workflow/a2a/plugin）承接面。
- `scripts/build-and-test.sh` — 隔离工具链构建/测试脚本，子命令 `core` / `server` / `test` / `lint` / `all`。

## 为什么这样拆

WorkBuddy 只从 `{workspace}/.workbuddy/skills/<name>/SKILL.md` 扫描项目级技能，因此这里必须保留一份带 frontmatter 的注册壳，以维持「可被发现 / 可被触发」。

但真正的实现与知识放在仓库顶层 `skills/`，成为一等公民：可见、可 review、可版本化、可纳入 CI，不再「藏」在点文件夹里。

**维护约定：修改技能内容请直接改 `skills/ah-platform-evolution/` 下的模块，不要改本文件**（本文件只在技能改名、换触发描述或模块搬家时才需要动）。
