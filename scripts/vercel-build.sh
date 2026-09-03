#!/usr/bin/env bash
# Vercel build hook for agent-harness monorepo.
# Called via the "vercel-build" script in access/server/package.json.
set -euo pipefail

# Resolve project root (script is at <repo>/scripts/vercel-build.sh)
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

echo "=== Building ==="
"$PNPM" -r build

echo "=== Verify workspace artifacts ==="
test -f "access/server/dist/server.js"   || { echo "ERROR: access/server/dist/server.js missing"; exit 1; }
test -f "frontend/webapp/dist/index.html" || { echo "ERROR: frontend/webapp/dist/index.html missing"; exit 1; }
test -f "backend/core/dist/index.js"      || { echo "ERROR: backend/core/dist/index.js missing"; exit 1; }

# Vercel requires outputDirectory to exist. Default is "dist" at project root.
# Copy frontend artifacts there so Vercel can serve them.
echo "=== Preparing Vercel output directory ==="
rm -rf dist
mkdir -p dist
cp -r frontend/webapp/dist/. dist/
echo "Created dist/ with $(ls dist/ | wc -l) items"

echo "=== Build complete ==="
