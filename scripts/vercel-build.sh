#!/usr/bin/env bash
# Vercel build hook for agent-harness monorepo.
# Called via the "vercel-build" script in access/server/package.json.
#
# IMPORTANT: Vercel runs this script from the directory containing the package.json
# that defines it — which is `access/server/`. We need to cd to the monorepo root.
set -euo pipefail

# Resolve the project root from the script's location.
# Script is at: <repo-root>/scripts/vercel-build.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
echo "Working directory: $(pwd)"

echo "=== Vercel build: resolving pnpm ==="

# Resolve pnpm: prefer local node_modules/.bin (installed by Vercel's builder),
# then PATH, then npx bootstrap.
if [[ -x "node_modules/.bin/pnpm" ]]; then
  PNPM="node_modules/.bin/pnpm"
elif command -v pnpm &>/dev/null; then
  PNPM="$(command -v pnpm)"
elif command -v npx &>/dev/null; then
  PNPM="npx"
else
  echo "ERROR: neither pnpm nor npx found."
  exit 1
fi

echo "Using pnpm resolver: $PNPM ($("$PNPM" --version 2>/dev/null || echo 'npx') version)"

echo "=== Vercel build: installing pnpm workspace ==="
"$PNPM" install --no-frozen-lockfile

echo "=== Vercel build: building all workspace packages ==="
"$PNPM" -r build

echo "=== Vercel build: verifying key artifacts ==="
# All paths are relative to the project ROOT (we cd'd above)
test -f "access/server/dist/server.js" || { echo "ERROR: access/server/dist/server.js missing"; ls -la access/server/dist/ 2>&1 || true; exit 1; }
test -f "frontend/webapp/dist/index.html" || { echo "ERROR: frontend/webapp/dist/index.html missing"; exit 1; }
test -f "backend/core/dist/index.js" || { echo "ERROR: backend/core/dist/index.js missing"; exit 1; }

echo "=== Vercel build: complete ==="
