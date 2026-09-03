#!/usr/bin/env bash
# Vercel build hook for agent-harness monorepo.
# Called via the "vercel-build" script in the root package.json.
#
# IMPORTANT: We build ONLY the webapp SPA + its workspace dependency
# (@agent-harness/client), then copy the static output into public/ for
# Vercel to serve. We deliberately DO NOT run `pnpm -r build`, because:
#   1. access/server is a long-running HTTP+SSE server (server.listen()) that
#      cannot run on Vercel serverless, so it must not be part of this deploy.
#   2. access/server's tsc build currently has type errors (implicit any,
#      missing @agent-harness/core resolution, views.ts comparator) that would
#      fail the whole `pnpm -r build`. Those are irrelevant to the static SPA.
# The Node server is deployed separately (Render / Fly.io / Railway / container).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
echo "=== Working directory: $(pwd) ==="

echo "=== Resolving pnpm ==="
if [[ -x "node_modules/.bin/pnpm" ]]; then
  PNPM="node_modules/.bin/pnpm"
elif command -v pnpm &>/dev/null; then
  PNPM="$(command -v pnpm)"
elif command -v npx &>/dev/null; then
  PNPM="npx"
else
  echo "ERROR: pnpm not found"; exit 1
fi
echo "pnpm: $PNPM"

echo "=== Installing ==="
"$PNPM" install --no-frozen-lockfile

echo "=== Building webapp SPA + workspace deps (client) only ==="
"$PNPM" --filter "@agent-harness/webapp..." build

echo "=== Verify build artifacts ==="
test -f "frontend/webapp/dist/index.html" || { echo "ERROR: frontend/webapp/dist/index.html missing"; exit 1; }
test -f "backend/client/dist/index.js"    || { echo "ERROR: backend/client/dist/index.js missing"; exit 1; }

# Copy frontend build output into public/ for Vercel to serve.
# Vercel does a fresh git checkout each build, so overlaying (not rm-first)
# is safe and preserves the committed favicon/logos if the webapp omits them.
mkdir -p public/assets
cp frontend/webapp/dist/assets/* public/assets/ 2>/dev/null || true
cp frontend/webapp/dist/*.html public/ 2>/dev/null || true
cp frontend/webapp/dist/*.js public/ 2>/dev/null || true
cp frontend/webapp/dist/*.css public/ 2>/dev/null || true
cp frontend/webapp/dist/favicon.ico public/ 2>/dev/null || true
cp frontend/webapp/dist/favicon.svg public/ 2>/dev/null || true
cp frontend/webapp/dist/logo-white.svg public/ 2>/dev/null || true
cp frontend/webapp/dist/logo.svg public/ 2>/dev/null || true
echo "=== Frontend copied to public/ ==="

echo "=== Build complete ==="
