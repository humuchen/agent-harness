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

# Vercel's @vercel/node builder expects static files in either "dist/" or "public/"
# at the project root. Copy frontend webapp artifacts to both locations as a safety net.
rm -rf dist public
mkdir -p dist public
cp -r frontend/webapp/dist/. dist/
cp -r frontend/webapp/dist/. public/
echo "=== Created dist/ and public/ ($(ls dist/ | wc -l) items each) ==="

echo "=== Build complete ==="
