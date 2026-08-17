#!/usr/bin/env bash
# Build + test the agent-harness core/server using the isolated managed tsc.
# Usage: bash scripts/build-and-test.sh [core|server|test|all]
# (Run from the repository root.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
TSC="${TSC:-/Users/huyang/.workbuddy/binaries/node/workspace/node_modules/.bin/tsc}"

cd "$REPO_ROOT"

cmd="${1:-all}"

build_core() {
  echo "==> tsc core"
  "$TSC" -p packages/core/tsconfig.json
}

build_server() {
  echo "==> tsc server"
  "$TSC" -p packages/server/tsconfig.json
}

run_tests() {
  echo "==> node --test (core)"
  cd packages/core && node --test test/*.test.cjs; cd "$REPO_ROOT"
}

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
