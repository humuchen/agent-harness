# Enterprise Readiness Fixes (2026-09-02)

Comprehensive security & enterprise hardening applied to agent-harness.

## What Changed

### Security (P0)
| Change | File | Env Var |
|--------|------|---------|
| Network egress default → `denylist` | `guardrails.ts` | `GUARDRAIL_NETWORK_MODE` |
| Sandbox backend default → `os` | `builtins/sandbox.ts` | `SANDBOX_BACKEND` |
| Audit log default → `/app/data/audit/audit.jsonl` | `config-defaults.ts` | `AUDIT_LOG` |
| Private/localhost host exemption in `checkEgress` | `guardrails.ts` | — |

### Observability (P1)
| Change | File | Notes |
|--------|------|-------|
| `traceId` auto-injected into `AuditEvent` + `structLog` | `telemetry.ts` | `RequestContext` keyed by `traceId` |
| `queue_pending` / `queue_processing` exposed in `/api/metrics` JSON + Prometheus format | `server.ts` | Uses `qstats.pending ?? 0` |
| `resolveTraceId(req, body)` extracted in `server.ts` | `server.ts` | Client `body.traceId` > `X-Request-Id` > UUID |
| `JobDescriptor.traceId` written and propagated to audit events | `run-queue.ts` | |

### Deployment (P2/P3)
| Change | File | Notes |
|--------|------|-------|
| HPA updated: queue_depth target 30, job_duration target 5s | `deploy/k8s/base/hpa.yaml` | Custom metrics (not just CPU) |
| external-secrets-operator overlay added | `deploy/k8s/overlays/prod/external-secrets.yaml` | SealedSecrets/Vault pattern |
| Plugin sandbox design doc | `docs/02-deployment/plugin-sandbox-design.md` | Stdio IPC, permission isolation |

## How to Verify
```bash
# Build (must pass clean)
pnpm build

# Tests (356/356 core; any remaining access/server failures are pre-existing)
pnpm test

# Confirm denylist default is active
node -e "require('./backend/core/dist/guardrails.js').checkEgress('https://evil.com', {mode:'denylist'})"
# Should return: 'egress denied to evil.com (denylist)'

# Confirm localhost exempt
node -e "require('./backend/core/dist/guardrails.js').checkEgress('http://localhost:3000', {mode:'denylist'})"
# Should return: null (allowed)
```

## Test Migration Pattern
When tightening security defaults, existing tests using external URLs will fail
guardrail egress checks. The fix is to swap to localhost in test inputs:
- `https://example.com/path` → `http://127.0.0.1:9999/path`
- `http://127.0.0.1:9999` is exempt by `isPrivateHost()` in `checkEgress`
- For secret-scan tests, ensure key values match format: `sk-` + ≥20 chars after prefix

## TypeScript Gotcha
`(host.split(':')[0] ?? '').toLowerCase()` — the `??` is required before
`toLowerCase()` to satisfy TS strict null (TS2532). Using `?? ''` after fails.
