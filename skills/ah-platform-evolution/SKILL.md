---
name: ah-platform-evolution
description: "扩展 agent-harness TypeScript monorepo（backend/core + access/server）的平台级能力时使用：agent 注册与发现、任务路由与调度器、租户隔离与策略、工作流编排（DAG + 补偿）、A2A、插件框架；或改动 assembleAgent / RunQueue.execute / HarnessEvent / store 单例、需要跑隔离 tsc + node --test 验证回路时。Use when extending agent-harness with agent registry/discovery, task routing/dispatcher, tenant isolation/policy, workflow orchestration (DAG + compensation), A2A, or plugin framework. Encodes non-negotiable conventions: evolve-don't-rewrite, all-new-fields-optional back-compat with a seeded default agent, env-switch degradation, assembleAgent(card?, tenantCtx?) narrowing, composite tenant::session memory keys, JSON-only entity types."
---

# agent-harness Platform Evolution

## Overview

This skill turns the agent-harness repo's "single universal harness" into an explicit multi-agent **orchestration base** without rewriting it. New platform capabilities are introduced as **first-class entities** (`Agent`, `Tenant`, `Workflow`) that are *assembly recipes + scheduling metadata* hung on the existing `AgentHarness` — not new processes. Backward compatibility and graceful degradation are hard requirements, not afterthoughts.

Apply this skill whenever a task touches: `backend/core/src/agents`, `backend/core/src/router`, `backend/core/src/tenant.ts`, `backend/core/src/policy`, `backend/core/src/workflow`, `backend/core/src/a2a`, `backend/core/src/plugin`, or the `assembleAgent` / `RunQueue.execute` / `HarnessEvent` paths in `access/server`.

Detailed file anchors, type signatures, and the reference playbook live in [references/architecture.md](references/architecture.md).

## Core Conventions (follow these or the change will regress)

These were hard-won; violating any of them breaks existing UI/CLI/tests or leaks tenant data.

1. **Evolve, don't rewrite.** Reuse `RunQueue` (+ redis backend), `HarnessEvent`, MCP `placeholder`, `guardrails`, `memory-store`, `authz`/`approval` as "plumbing." Add scheduling/metadata layers on top; do not replace the execution core.
2. **All new fields are optional.** Omitting `agentId`/`tenantId`/`domain` must degrade to *today's* universal-harness behavior. Always seed a `default` generic agent in the registry so unmodified UI works.
3. **Feature flags via env.** Gate each capability with `AGENT_REGISTRY` / `TASK_ROUTER` / `TENANT_ISOLATION` / `WORKFLOW_ENGINE`. When off, execution is byte-for-byte the legacy path ("everything degrades gracefully").
4. **`assembleAgent(card?, tenantCtx?)` is the assembly recipe.** `card === undefined` ⇒ legacy full-tool harness. `card` present ⇒ narrow tools to `card.assembly` (tools/skills/mcpServers/systemPrompt only). Never fork the harness; narrow at assembly time.
5. **Composite memory key for isolation.** Build `tenantSessionKey = sanitize(tenantId) + '::' + sanitize(sessionKey)`. file/sqlite `MemoryStore` backends then physically bucket PII/financial data per tenant. Never change the `MemoryStore` interface — only the *call site* in `runner.ts`.
6. **JSON-only entity types.** `AgentCard`, `JobDescriptor`, `TaskEnvelope` must stay pure-JSON-serializable. No functions/class instances in their fields (they cross the redis queue / HTTP boundary).
7. **Tenant identity from auth, not body.** `resolveTenantContext(body, auth)` derives `tenantId` from the authenticated principal first, falling back to `body.tenantId`. A client cannot spoof another tenant's `sessionKey`.
8. **Singletons as source of truth.** `getAgentRegistry()` and `policyEngine` are module singletons seeded at import. Do not instantiate per-request.

## Step-by-Step Playbook (per new capability)

1. **Define the entity types** in a new `backend/core/src/<domain>/types.ts` — pure interfaces, all new cross-cutting fields (`agentId?`, `workflowId?`, `traceId?`, `tenantId?`) optional.
2. **Add the store + singleton** using the existing `MemoryStore` "interface + default impl + factory" paradigm: `Volatile` (default) / `File` / `Sqlite`, keyed by the entity id. Export a `getX()` singleton.
3. **Wire `assembleAgent`** in `access/server/src/runner.ts`: add the new optional param, narrow behavior when present, leave the `undefined` branch untouched.
4. **Thread the metadata** through `queue-backend.ts` (`JobDescriptor`), `run-queue.ts` (`submit` + `execute`), and `authz.ts` (`AuthContext`). In `execute`, derive context → `resolve` target → `assembleAgent` → inject into `run:meta` event.
5. **Expose HTTP** in `server.ts` (`/api/<entity>`, `/api/run` body field, SSE for progress). Keep existing `/api/state` open for health checks.
6. **Extend `HarnessEvent`** variants with the optional metadata tags so observability picks them up for free.
7. **Add tests** `backend/core/test/<domain>.test.cjs` (zero-dep, `require` compiled `dist`) — happy path + degradation path (flag off ⇒ legacy behavior).
8. **Compile + test** with the isolated toolchain (see Verification).

## Verification

Use the repository's isolated TypeScript toolchain. The sandbox `pnpm install` is blocked by a safe-delete guard, so **never hard-code a `tsc` path** (an absolute path from another machine will not resolve here). Use this module's script instead — it auto-detects `REPO_ROOT` by walking up to `pnpm-workspace.yaml` and resolves the pre-provisioned managed `tsc`:

```bash
bash skills/ah-platform-evolution/scripts/build-and-test.sh test   # 先离线构建 core+server，再跑 node --test
bash skills/ah-platform-evolution/scripts/build-and-test.sh all    # build + test + lint 全覆盖
```

Unit tests use explicit file globs (the script handles this; do **not** pass `test/` as a directory — it is treated as a module and errors).

Smoke the server: `node access/server/dist/server.js`, then `curl localhost:<port>/api/state` (expect 200) and a mock SSE `/api/run`.

## Resources

### references/
- `architecture.md` — concrete file/function anchors, type signatures, the `assembleAgent` narrowing pattern, the `NetworkPolicy`/`checkEgress` egress-control design, industry profile map (finance/medical/education), and the existing P0 baseline (agents/router/tenant/policy) to build P1 (workflow/a2a/plugin) on top of.

### scripts/
- `build-and-test.sh` — auto-detected toolchain (REPO_ROOT found by walking up to `pnpm-workspace.yaml`; tsc resolved to the installed `node_modules/.bin/tsc` and invoked directly, never auto-installs). Subcommands: `core` / `server` / `test` / `lint` / `all`. `test` **先离线构建 core+server 再跑 node --test**（避免 stale `dist` 造成假性失败——`dist` 过期会让测试挂掉但退出码仍由 `set -e` 透传）；`all` = build+test+lint for `backend/core` + `access/server`; `lint` auto-selects eslint > prettier > `tsc --noEmit`. Use it after every change to confirm a clean build and green suite.
