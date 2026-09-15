#!/usr/bin/env node
/**
 * P2-4: K8s ServiceMonitor 生成脚本。
 *
 * 从 docker-compose.yml + K8s manifests 提取服务清单，
 * 渲染 ServiceMonitor CRD 到 deploy/monitoring/servicemonitor.yaml。
 *
 * 用法：
 *   node scripts/gen-servicemonitor.mjs [--check]
 *
 * --check：如果生成内容与现有文件不一致则退出码 1（用于 CI）。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'deploy/monitoring/servicemonitor.yaml');

/**
 * 服务清单（手工维护，反映 docker-compose.yml + k8s base manifests）。
 * 每个条目对应一个 ServiceMonitor。
 *
 * 来源：
 *   - docker-compose.yml: `ui` 服务 → agent-harness，端口 4173，路径 /api/metrics/prometheus
 *   - deploy/k8s/rag.yaml: `rag` 服务 → rag，端口 8787，路径 /metrics
 */
const SERVICES = [
  {
    name: 'agent-harness',
    labels: 'app.kubernetes.io/name: agent-harness',
    namespace: 'agent-harness',
    port: 'http',
    path: '/api/metrics/prometheus',
    interval: '15s',
    description: '主服务（ui），暴露应用级指标。'
  },
  {
    name: 'rag',
    labels: 'app.kubernetes.io/name: rag',
    namespace: 'agent-harness',
    port: 'http',
    path: '/metrics',
    interval: '30s',
    description: 'RAG MCP 服务（可选）。'
  }
];

/** 渲染单个 ServiceMonitor YAML。 */
function renderServiceMonitor(svc) {
  return `
---
# ${svc.name}${svc.description ? ' — ' + svc.description : ''}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ${svc.name}
  namespace: ${svc.namespace}
  labels:
    app.kubernetes.io/part-of: agent-harness
    release: prometheus
spec:
  selector:
    matchLabels:
      ${svc.labels}
  namespaceSelector:
    matchNames:
      - ${svc.namespace}
  endpoints:
    - port: ${svc.port}
      targetPort: ${svc.port}
      path: ${svc.path}
      interval: ${svc.interval}
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: instance
`.trim();
}

/** 生成完整的 servicemonitor.yaml 内容。 */
function generate() {
  const header = `# ──────────────────────────────────────────────
# Prometheus ServiceMonitor CRDs for agent-harness K8s 部署。
#
# 该文件由 scripts/gen-servicemonitor.mjs 生成 —
# 手工编辑无效，请修改脚本后重新生成。
#
# 部署（需先部署 Prometheus Operator / kube-prometheus-stack）：
#   kubectl -n agent-harness apply -f deploy/monitoring/servicemonitor.yaml
#
# 包含服务：
#   - agent-harness（主服务，端口 4173，指标路径 /api/metrics/prometheus，15s 间隔）
#   - rag（RAG MCP 服务，端口 8787，指标路径 /metrics，30s 间隔）
# ──────────────────────────────────────────────`;
  const body = SERVICES.map(renderServiceMonitor).join('\n');
  return header + '\n' + body + '\n';
}

/** 校验生成内容与现有文件是否一致。 */
function check() {
  const generated = generate();
  if (!existsSync(OUT)) {
    console.error(`✗ ${OUT} 不存在，需生成。`);
    return false;
  }
  const existing = readFileSync(OUT, 'utf-8');
  if (generated !== existing) {
    console.error(`✗ ${OUT} 已过期，请运行 node scripts/gen-servicemonitor.mjs 重新生成。`);
    return false;
  }
  console.log(`✓ ${OUT} 已同步。`);
  return true;
}

const isCheck = process.argv.includes('--check');
if (isCheck) {
  const ok = check();
  process.exit(ok ? 0 : 1);
} else {
  const content = generate();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, content);
  console.log(`✓ 已生成 ${OUT}`);
}
