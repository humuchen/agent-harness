# agent-harness Platform — Architecture Reference

Concrete anchors for extending the orchestration base. Paths are relative to repo root.

## Repo shape (monorepo, pnpm)

- `backend/core/src/` → `@agent-harness/core`: framework lib (harness / tools / memory / guardrails / telemetry / llm / integrations / **agents / router / tenant / policy**).
- `access/server/src/` → `@agent-harness/server`: HTTP+SSE runtime. Key files: `server.ts`, `runner.ts` (`assembleAgent`), `run-queue.ts` (`submit`/`execute`), `queue-backend.ts` (`JobDescriptor`), `authz.ts`.
- `backend/core/src/index.ts` re-exports `agents`, `router`, `tenant`, `policy`, `guardrails`, `harness`, integrations. **Add every new domain to this barrel.**
- Build order (topological): `core` → `server` → `webapp` → `examples`. Local pnpm install is blocked; compile via the managed `tsc` (see SKILL.md Verification).

## P0 baseline (already implemented — build P1 on top of these)

### ① Agent Registry & Discovery — `backend/core/src/agents/`
- `types.ts`: `AgentCard` (`id, name, domain, capabilities[], transport, version, health, assembly?{systemPrompt?,skills?,mcpServers?,tools?}`), `AgentCapability`, `AgentTransport`, `IndustryDomain`, `AgentHealth`.
- `store.ts`: `AgentStore` interface (`register/heartbeat/deregister/get/list/query`) with `VolatileAgentStore` (default) / `FileAgentStore` / `SqliteAgentStore`, keyed by `agentId`. Mirrors `memory-store.ts` paradigm.
- `registry.ts`: `AgentRegistry` wraps the store, maintains a capability→agentId inverted index, and sweeps agents past their heartbeat TTL (marks `down`).
- `index.ts`: barrel.
- `getAgentRegistry()` singleton seeds a `default` generic agent so legacy UI needs no change.

**Server wiring:** `runner.ts` `assembleAgent(card?)` — undefined ⇒ legacy; present ⇒ narrow `registerBuiltinTools` to `assembly.tools`, filter `defaultSkills()` by `assembly.skills`, `tools.mergeFrom` only the named `mcpServers`, system prompt from `assembly.systemPrompt`. `server.ts` exposes `GET /api/agents` (`?domain=&capability=`), `GET /api/agents/:id`, `POST /api/agents`, and parses `agentId` from `POST /api/run` body. `authz.ts` gained `agent:read` action.

### ② Task Router / Dispatcher — `backend/core/src/router/`
- `intent.ts`: `IntentRouter.classify(prompt)` → `{domain, intent, requiredCapabilities}`. Rule engine (domain lexicon) by default; `INTENT_ROUTER=llm` uses a small LLM classifier (reuse `createOpenRouterLLM`). Cache results.
- `selector.ts`: `scoreAgent(card, intent, ctx)` = capability∩ × (1−load) × SLA × tenant affinity. `AgentSelector.select(registry, intent, ctx)` returns highest score or `null`.
- `router.ts`: `TaskRouter.resolve(job)` precedence — explicit `job.agentId` → `job.domain` filter → `classify`+`select` → `default` agent. `resolveTask()` singleton.
- **Server wiring:** `run-queue.ts` `submit` + `queue-backend.ts` `JobDescriptor` add `agentId?`/`domain?`/`tenantId?`/`workflowId?`/`traceId?`. `execute()` derives `TenantContext`, calls `router.resolve(job)`, assembles, and stamps `agentId`/`workflowId`/`traceId` into `run:meta`. `RunQueue` concurrency/watchdog/reclaimStale untouched.

### ③ Tenant Isolation & Policy — `backend/core/src/tenant.ts` + `backend/core/src/policy/`
- `tenant.ts`: `TenantContext {tenantId, industry?, policyRef?}`; `resolveTenantContext(body, auth)` (auth principal wins, prevents spoofing); `tenantSessionKey(tenantId, sessionKey)` → `tenant::session` composite key.
- `policy/engine.ts`: `PolicyEngine` with `perTenant` Map (shallow merge over `default`), `getPolicy(tenantId)`, `registerIndustryProfile(industry, policy)`. `policyEngine` singleton replaces the bare `policy` var in `guardrails.ts`.
- Industry profiles: `finance` (data-egress limits), `medical` (forced redaction + audit), `education` (relaxed).
- **`guardrails.ts`:** `NetworkPolicy` + `checkEgress(url, net?)` (modes `open`/`allowlist`/`denylist`; `*` = universal, `*.x` wildcard — note the `*` bare-match bug fix: test `e === '*'` first). `checkInput/Output/ToolArgs/redactOutput` take optional `pol?`. `checkToolArgs` routes `builtin__web_fetch` through `checkEgress`.
- **`harness.ts`:** `HarnessOptions.guardrailPolicy?` threaded into the four checks.
- **`runner.ts`:** `assembleAgent(card?, tenantCtx?)`; composite memory key; injects `policyEngine.getPolicy(tenantCtx.tenantId)`; applies `allowedDomains`/`deniedDomains` to `web_fetch`/`filesystem`.
- **`run-queue.ts` `execute`:** derives `TenantContext`, writes `run:meta.tenantId`. `server.ts`: `effectiveTenantId = ctx.tenantId || body.tenantId`.

## P1 — next capabilities to land

### ⑤ Workflow Orchestrator — `backend/core/src/workflow/` (NEXT, not yet implemented)
- `types.ts`: `StepState = 'pending'|'running'|'done'|'failed'|'compensated'`; `StepDef {id, agentRef: string|AgentCard, inputMapping, dependsOn?, compensate?}`; `WorkflowDef {id, steps[]}`.
- `engine.ts`: `DagEngine` — topological sort, run dependency-free steps in parallel via `assembleAgent(card).run(input)`; persist each step state to `WorkflowStore`; on failure, run `compensate` for completed steps in reverse (delegate to the agent's compensation tool/rollback); `resume(workflowId)` replays from last checkpoint.
- `store.ts`: `WorkflowStore` (reuse `QueueBackend`/`MemoryStore` interface; stores `WorkflowDef` + per-step state).
- **`harness.ts`:** `HarnessEvent` variants gain optional `agentId?`/`workflowId?`/`traceId?`; `HarnessOptions` gains same; `emit` decorates events. This is the metadata channel P0 already paved.
- **`server.ts`:** `POST /api/workflows` (define+run), `GET /api/workflows/:id`, SSE progress. `traceId` spans all agent calls; OTel `withSpan` (`telemetry.ts`) correlates across agents.
- **Tests:** `backend/core/test/workflow.test.cjs` — DAG happy path + compensation rollback + resume.

### ④ A2A / Task Envelope — `backend/core/src/a2a/`
- `types.ts`: `TaskEnvelope {taskId, tenantId, traceId?, fromAgent, toAgent, input, inputSchema?, sla?, callback?}`, `TaskResult {taskId, status, output?, error?}`.
- `transport.ts`: `A2ATransport` + `LocalA2ATransport` (in-process `assembleAgent`+`run`) + `HttpA2ATransport` (`fetch` remote `/api/a2a/tasks`).
- **`server.ts`:** `POST /api/a2a/tasks` (self-register card + execute + return `TaskResult`). `TaskRouter` dispatches `transport:'a2a'` cards via `HttpA2ATransport`.

### Plugin Framework — `backend/core/src/plugin/`
- `manifest.ts`: `PluginManifest {id, version, capabilities[], dependencies[], permissions[], transport, entry}`.
- `loader.ts`: `PluginLoader` lifecycle (install/enable/disable/upgrade) + dependency resolution; load **isolated** via `worker_threads`/`child_process` with the OS sandbox backend `createSandboxExecutor({backend:'os'|'container'})` (already implemented in `sandbox/`). Manifest `capabilities` auto-register an `AgentCard`.

## Degradation / feature flags

| Flag | Capability | Off ⇒ legacy behavior |
|---|---|---|
| `AGENT_REGISTRY` | agent registry/discovery | single `default` agent, full-tool harness |
| `TASK_ROUTER` | intent routing/dispatcher | `resolve` returns `default` card |
| `TENANT_ISOLATION` | per-tenant policy + memory key | global `default` policy, plain `sessionKey` |
| `WORKFLOW_ENGINE` | DAG orchestration | single `harness.run` |

## Pitfalls (learned the hard way)

- **`checkEgress` wildcard:** bare `*` must be treated as universal match — check `e === '*'` before pattern/domain logic, or `allowlist:['*']` tests fail.
- **`node --test test/` crashes** (directory treated as a module). Always glob `test/*.test.cjs`.
- **Memory isolation is call-site only** — never modify the `MemoryStore` interface; change the key construction in `runner.ts`.
- **Tenants must exist before multi-industry agents** — P0.3 is a hard prereq for medical/finance mixed scenarios (prevents PII/financial co-mingling in one output channel).
- **OS sandbox is a hard prereq** for untrusted cross-industry agents (per-job `backend:'os'` isolation in P2).
