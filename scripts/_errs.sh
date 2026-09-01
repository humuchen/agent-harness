#!/usr/bin/env bash
cd "$(dirname "$0")/.."
PKG="$1"
TSC="$PKG/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then TSC=backend/core/node_modules/.bin/tsc; fi
$TSC -p "$PKG/tsconfig.json" --noUncheckedIndexedAccess --noEmit 2>&1 | grep -E "error TS" || true
