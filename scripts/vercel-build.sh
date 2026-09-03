#!/usr/bin/env bash
# Vercel build hook for agent-harness monorepo.
# Called via the "vercel-build" script in access/server/package.json.
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

echo "=== Building all workspace packages ==="
"$PNPM" -r build

echo "=== Verify workspace artifacts ==="
test -f "access/server/dist/server.js"   || { echo "ERROR: access/server/dist/server.js missing"; exit 1; }
test -f "frontend/webapp/dist/index.html" || { echo "ERROR: frontend/webapp/dist/index.html missing"; exit 1; }
test -f "backend/core/dist/index.js"      || { echo "ERROR: backend/core/dist/index.js missing"; exit 1; }

# Copy frontend build output to public/ for Vercel to serve
# This replaces the original public/ files with the built SPA
rm -rf public/*
mkdir -p public/assets
cp frontend/webapp/dist/assets/* public/assets/
cp frontend/webapp/dist/*.html public/ 2>/dev/null || true
cp frontend/webapp/dist/*.js public/ 2>/dev/null || true
cp frontend/webapp/dist/*.css public/ 2>/dev/null || true
# Preserve root-level static assets (favicon, logos)
cp frontend/webapp/dist/favicon.ico public/ 2>/dev/null || true
cp frontend/webapp/dist/favicon.svg public/ 2>/dev/null || true
cp frontend/webapp/dist/logo-white.svg public/ 2>/dev/null || true
cp frontend/webapp/dist/logo.svg public/ 2>/dev/null || true
echo "=== Frontend copied to public/ ==="

echo "=== Build complete ==="
