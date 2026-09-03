#!/usr/bin/env bash
# Vercel build hook for agent-harness monorepo.
# Vercel's @vercel/node builder runs the "vercel-build" script in package.json
# before starting the server. For a pnpm monorepo we need to build ALL workspace
# packages (core → client → server → webapp → rag → plugins) in topological
# order so that access/server/dist can resolve @agent-harness/core from the
# built backend/core/dist.
set -euo pipefail

echo "=== Vercel build: installing pnpm workspace ==="
# Use --no-frozen-lockfile so CI lockfile drift auto-corrects (same as render.yaml).
pnpm install --no-frozen-lockfile

echo "=== Vercel build: building all workspace packages ==="
pnpm -r build

echo "=== Vercel build: verifying key artifacts ==="
test -f "access/server/dist/server.js" || { echo "ERROR: access/server/dist/server.js missing"; exit 1; }
test -f "frontend/webapp/dist/index.html" || { echo "ERROR: frontend/webapp/dist/index.html missing"; exit 1; }
test -f "backend/core/dist/index.js" || { echo "ERROR: backend/core/dist/index.js missing"; exit 1; }

echo "=== Vercel build: complete ==="
