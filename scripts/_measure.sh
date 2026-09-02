#!/usr/bin/env bash
# 测量各包在 --noUncheckedIndexedAccess 下的报错数（使用各包本地 tsc 二进制）。
cd "$(dirname "$0")/.."
for p in backend/core backend/client backend/medical-ad-guard access/server services/rag frontend/cli plugins/memo plugins/customer-service plugins/medical-aesthetics-lead; do
  TSC="$p/node_modules/.bin/tsc"
  if [ ! -x "$TSC" ]; then TSC=backend/core/node_modules/.bin/tsc; fi
  n=$($TSC -p "$p/tsconfig.json" --noUncheckedIndexedAccess --noEmit 2>&1 | grep -cE "error TS" || true)
  echo "$p: $n errors"
done
