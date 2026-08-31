#!/usr/bin/env bash
# Build + test the agent-harness core/server using an AUTO-DETECTED toolchain.
# No hard-coded absolute paths:
#   - REPO_ROOT is found by walking up from this script until pnpm-workspace.yaml
#     is located (no fixed directory depth, works wherever the skill is placed).
#   - tsc is resolved to the ALREADY-INSTALLED launcher under node_modules/.bin and
#     invoked directly. This script NEVER auto-installs dependencies; if the
#     toolchain is missing it tells you to run `pnpm install` first (offline-safe).
# On Windows/Git-Bash, paths are converted to native form (cygpath -m) so the
# shell-launched tsc sh script resolves its node modules correctly.
# Usage: bash scripts/build-and-test.sh [core|server|test|all]

set -euo pipefail

# 1) Locate the repo root by walking up to the pnpm workspace manifest.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
find_repo_root() {
  local dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/pnpm-workspace.yaml" ]; then
      echo "$dir"; return
    fi
    dir="$(dirname "$dir")"
  done
  # Fallback: this script lives at <repo>/.workbuddy/skills/ah-platform-evolution/scripts
  ( cd "$SCRIPT_DIR/../../.." && pwd )
}
REPO_ROOT="$(find_repo_root "$SCRIPT_DIR")"
echo "REPO_ROOT=$REPO_ROOT"

# 2) node is required
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

# Convert a path to the host-native form when running under Git-Bash on Windows.
to_native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}

# 3) Resolve the ALREADY-INSTALLED tsc launcher (NO auto-install).
resolve_tsc() {
  local bin
  for bin in \
    "$REPO_ROOT/backend/core/node_modules/.bin/tsc" \
    "$REPO_ROOT/access/server/node_modules/.bin/tsc" \
    "$REPO_ROOT/node_modules/.bin/tsc"; do
    if [ -x "$bin" ]; then echo "$bin"; return; fi
  done
  echo "MISSING"
}
TSC_BIN="$(resolve_tsc)"
echo "TSC_BIN=$TSC_BIN"

run_tsc() {
  local pkg_dir="$1"
  if [ "$TSC_BIN" = "MISSING" ]; then
    echo "ERROR: tsc launcher not found under node_modules/.bin." >&2
    echo "       Provision the toolchain once with 'pnpm install', then re-run." >&2
    exit 1
  fi
  "$(to_native "$TSC_BIN")" -p "$(to_native "$pkg_dir")/tsconfig.json"
}

build_core() {
  echo "==> tsc backend/core"
  run_tsc "$REPO_ROOT/backend/core"
}

build_server() {
  echo "==> tsc access/server"
  run_tsc "$REPO_ROOT/access/server"
}

run_tests() {
  echo "==> node --test (backend/core)"
  ( cd "$(to_native "$REPO_ROOT/backend/core")" && node --test test/*.test.cjs )
}

cmd="${1:-all}"
case "$cmd" in
  core)   build_core ;;
  server) build_server ;;
  test)   run_tests ;;
  all)
    build_core
    build_server
    run_tests
    ;;
  *) echo "unknown target: $cmd" >&2; exit 2 ;;
esac

echo "OK"
