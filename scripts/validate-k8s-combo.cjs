#!/usr/bin/env node
/**
 * k8s 组合静态校验（R3：多副本正确性不依赖部署纪律，改为机制拦截）。
 *
 * 检查 deploy/k8s/ 下每个 kustomization 的「副本数 × 共享后端」组合：
 *   - replicas > 1 时必须：RUN_QUEUE_BACKEND=redis、AGENT_STORE=redis、REDIS_URL 可用（Secret/env）；
 *   - replicas > 1 时建议注入 REPLICA_ID（Downward API）——缺失则运行期自检无法感知多副本；
 *   - replicas = 1 但启用了 Redis 后端 → 仅提示（合法：单副本用共享后端便于滚动升级）。
 *
 * 实现不依赖 kubectl（CI 里无需集群凭据）：按 kustomization.yaml 的 patches/resources
 * 递归合并 configmap 的 data 与 deployment 的 replicas/env 后判定。
 *
 * 用法：node scripts/validate-k8s-combo.cjs   # 失败 exit 1（CI 直接可用）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const K8S = path.join(ROOT, 'deploy', 'k8s');

// 极简 YAML：只解析本仓库清单用到的子集（key: value / 嵌套缩进 / patch 的 |- 块）。
// 不引第三方依赖——校验器必须零依赖可在 CI 裸机跑。
function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  let inBlock = null; // { obj, key }
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    if (inBlock) {
      const m = rawLine.match(/^(\s+)(\S.*)?$/);
      if (m && m[1].length >= 2 && m[2]) {
        inBlock.obj[inBlock.key] += (inBlock.obj[inBlock.key] ? '\n' : '') + m[1].slice(2) + m[2];
        continue;
      }
      inBlock = null;
    }
    const indent = rawLine.match(/^(\s*)/)[1].length;
    const line = rawLine.trim();
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const [, keyRaw, valRaw] = kv;
    const key = keyRaw.trim().replace(/^-\s*/, '');
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (valRaw === '' || valRaw === '|-') {
      if (valRaw === '|-') {
        parent[key] = '';
        inBlock = { obj: parent, key };
      } else {
        parent[key] = {};
        stack.push({ indent, obj: parent[key] });
      }
    } else {
      parent[key] = valRaw.replace(/^['"]|['"]$/g, '');
    }
  }
  return root;
}

// 递归收集某目录 kustomization 生效后的（configmap.data 合并 + deployment.replicas/env）
function inspectDir(dir, seen = new Set()) {
  // 防环
  if (seen.has(dir)) return { dir: path.relative(ROOT, dir), replicas: 1, data: {}, hasReplicaId: false, hasSecretRef: false };
  seen.add(dir);
  const result = { dir: path.relative(ROOT, dir), replicas: 1, data: {}, hasReplicaId: false, hasSecretRef: false };
  const cfg = path.join(dir, 'kustomization.yaml');
  const configMapFile = path.join(dir, 'configmap.yaml');
  const deployFile = path.join(dir, 'deployment.yaml');

  if (fs.existsSync(configMapFile)) {
    const doc = parseSimpleYaml(fs.readFileSync(configMapFile, 'utf8'));
    Object.assign(result.data, (doc.data || {}));
  }
  if (fs.existsSync(deployFile)) {
    const doc = parseSimpleYaml(fs.readFileSync(deployFile, 'utf8'));
    const n = Number(doc?.spec?.replicas);
    if (Number.isFinite(n)) result.replicas = n;
    result.containers = (doc?.spec?.template?.spec?.containers || []);
    const envFrom = JSON.stringify(doc?.spec?.template?.spec?.containers || []);
    result.hasSecretRef = envFrom.includes('secretRef');
  }
  const hpaFile = path.join(dir, 'hpa.yaml');
  if (fs.existsSync(hpaFile)) {
    const doc = parseSimpleYaml(fs.readFileSync(hpaFile, 'utf8'));
    const mn = Number(doc?.spec?.minReplicas);
    if (Number.isFinite(mn)) result.replicas = Math.max(result.replicas, mn);
  }

  // resources 引用（../../base 等）：先继承 base 的合并结果
  if (fs.existsSync(cfg)) {
    const cfgText = fs.readFileSync(cfg, 'utf8');
    for (const m of cfgText.matchAll(/^\s*-\s+(\.+\/[^\s#]+)\s*(?:#.*)?$/gm)) {
      const resDir = path.resolve(dir, m[1]);
      if (fs.existsSync(resDir) && fs.statSync(resDir).isDirectory()) {
        const base = inspectDir(resDir, seen);
        result.data = { ...base.data, ...result.data };
        result.hasSecretRef = result.hasSecretRef || base.hasSecretRef;
      }
    }
  }

  // overlay patches：configmap-prod-patch.yaml（op: add /data/KEY）与 deployment-*.yaml（replicas/env）
  if (fs.existsSync(cfg)) {
    const text = fs.readFileSync(cfg, 'utf8');
    // 收集同目录下所有被 patches 引用的 yaml
    for (const m of text.matchAll(/path:\s*(\S+\.yaml)/g)) {
      const p = path.join(dir, m[1]);
      if (!fs.existsSync(p)) continue;
      const ptxt = fs.readFileSync(p, 'utf8');
      if (/kind:\s*Deployment/.test(ptxt) && /secretRef/.test(ptxt)) result.hasSecretRef = true;
      // configmap op-add patch
      for (const op of ptxt.matchAll(/path:\s*\/data\/(\w+)\s*\n\s*value:\s*'?([^'\n]+)'?/g)) {
        result.data[op[1]] = op[2].trim().replace(/^'|'$/g, '');
      }
      if (/kind:\s*HorizontalPodAutoscaler/.test(ptxt)) {
        const mn = ptxt.match(/minReplicas:\s*(\d+)/);
        if (mn) result.replicas = Math.max(result.replicas, Number(mn[1]));
        if (/maxReplicas:\s*(\d+)/.test(ptxt)) result.hpaMax = Number(RegExp.$1);
      } else if (/kind:\s*Deployment/.test(ptxt) && !/Ingress|NetworkPolicy/.test(ptxt)) {
        const r = ptxt.match(/replicas:\s*(\d+)/);
        if (r) result.replicas = Number(r[1]);
        if (/REPLICA_ID/.test(ptxt)) result.hasReplicaId = true;
      }
    }
  }
  return result;
}

function findKustomDirs(dir, acc = []) {
  if (fs.existsSync(path.join(dir, 'kustomization.yaml'))) acc.push(dir);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) findKustomDirs(path.join(dir, e.name), acc);
  }
  return acc;
}

function main() {
  const problems = [];
  const notes = [];
  for (const dir of findKustomDirs(K8S)) {
    const s = inspectDir(dir);
    const multi = s.replicas > 1;
    const queue = (s.data.RUN_QUEUE_BACKEND || 'memory').toLowerCase();
    const store = (s.data.AGENT_STORE || 'volatile').toLowerCase();
    const redisUrl = !!(s.data.REDIS_URL || s.data.AGENT_STORE_REDIS_URL);
    // 静态分析边界：REDIS_URL 常由 envFrom secretRef（手动创建的 Secret）提供，
    // 校验器无法读取 Secret 内容 —— 检测到 secretRef 即视为「已具备注入通道」。
    const redisChannel = redisUrl || s.hasSecretRef;
    const tag = `${s.dir}: replicas=${s.replicas}, queue=${queue}, store=${store}, redisUrl=${redisUrl || (s.hasSecretRef ? 'via-secretRef' : 'false')}`;

    if (multi) {
      const bad = [];
      if (queue !== 'redis') bad.push(`RUN_QUEUE_BACKEND=${queue}（应 redis）`);
      if (store !== 'redis') bad.push(`AGENT_STORE=${store}（应 redis）`);
      if (!redisChannel) bad.push('REDIS_URL 未配置（configmap 或 envFrom secretRef 均缺失）');
      else if (!redisUrl)
        notes.push(`ℹ️  ${s.dir}: REDIS_URL 经 envFrom secretRef 注入——请确认 Secret 含 REDIS_URL 键（静态校验无法读取 Secret 内容）`);
      if (!s.hasReplicaId) bad.push('未注入 REPLICA_ID（运行期多副本自检将无法感知）');
      if (bad.length) problems.push(`❌ ${tag}\n   ${bad.join('；')}`);
      else console.log(`✅ ${tag}`);
    } else {
      console.log(`✅ ${tag}（单副本：内存/SQLite 后端合法）`);
      if (queue === 'redis' && store === 'redis' && !redisUrl)
        notes.push(`⚠️  ${s.dir}: Redis 后端已启用但 REDIS_URL 缺失（运行期会回退/告警）`);
    }
  }
  for (const n of notes) console.log(n);
  if (problems.length) {
    console.error('\n多副本组合校验失败：');
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log('\n✅ k8s 组合校验通过：多副本 ⇒ Redis 后端 + REPLICA_ID 注入');
}

main();
