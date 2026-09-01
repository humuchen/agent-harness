#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
TSC=backend/core/node_modules/.bin/tsc
cat > backend/core/src/_nucia_probe.ts <<'EOF'
export function probe(a: string[]): string {
  const x = a[0];
  return x.toUpperCase();
}
EOF
echo "=== with --noUncheckedIndexedAccess (expect >=1 error on a[0]) ==="
$TSC -p backend/core/tsconfig.json --noUncheckedIndexedAccess --noEmit 2>&1 | grep -E "error TS" | head
echo "count: $($TSC -p backend/core/tsconfig.json --noUncheckedIndexedAccess --noEmit 2>&1 | grep -cE 'error TS')"
rm -f backend/core/src/_nucia_probe.ts
