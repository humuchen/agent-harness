#!/usr/bin/env bash
# Vercel build hook for agent-harness monorepo.
# Called via the "vercel-build" script in access/server/package.json.
#
# In Vercel's @vercel/node builder, `node` is available but `pnpm` may not be
# in PATH (it's installed locally by the builder). We resolve pnpm by trying
# local node_modules/.bin first, then falling back to npx bootstrap.
set -euo pipefail

echo "=== Vercel build: resolving pnpm ==="

# Resolve pnpm: prefer local (already installed by @vercel/node builder),
# then global, then npx bootstrap as last resort.
if [[ -x "node_modules/.bin/pnpm" ]]; then
  PNPM="node_modules/.bin/pnpm"
elif command -v pnpm &>/dev/null; then
  PNPM="$(command -v pnpm)"
elif command -v npx &>/dev/null; then
  PNPM="npx"
else
  echo "ERROR: neither pnpm nor npx found in PATH."
  exit 1
fi

echo "Using pnpm resolver: $PNPM"

echo "=== Vercel build: installing pnpm workspace ==="
"$PNPM" install --no-frozen-lockfile || \
  { echo "First install failed, retrying without frozen lockfile..."; "$PNPM" install --no-frozen-lockfile; }

echo "=== Vercel build: building all workspace packages ==="
"$PNPM" -r build

echo "=== Vercel build: verifying key artifacts ==="
test -f "access/server/dist/server.js" || { echo "ERROR: access/server/dist/server.js missing"; exit 1; }
test -f "frontend/webapp/dist/index.html" || { echo "ERROR: frontend/webapp/dist/index.html missing"; exit 1; }
test -f "backend/core/dist/index.js" || { echo "ERROR: backend/core/dist/index.js missing"; exit 1; }

echo "=== Vercel build: complete ==="
