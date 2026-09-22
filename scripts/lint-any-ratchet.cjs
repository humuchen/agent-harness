#!/usr/bin/env node
/**
 * no-explicit-any 棘轮基线检查。
 *
 * 背景：@typescript-eslint/no-explicit-any 目前是 warn（历史存量 ~100+ 处，
 * 一次性提 error 需要大规模类型梳理，风险高）。本脚本把「存量锁定 + 禁止新增」
 * 机制化：任何新增 any 都会让本检查失败；存量只允许减少、不允许回潮。
 * 存量清零后即可在 eslint.config.js 把规则提为 error 并删除本脚本。
 *
 * 用法：
 *   node scripts/lint-any-ratchet.cjs            # 检查（CI / 本地）
 *   node scripts/lint-any-ratchet.cjs --update   # 清理存量后重新生成基线
 *
 * 基线文件：.eslint-any-baseline.json（{ "total": N, "byFile": { <abs path>: n } }）
 * 仅对比 total（按文件记录仅作排查参考）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// R6 加固：基线放在 scripts/ 下（非 dotfile）——本工作区曾两次清除根目录 dotfile
// （即使已 git add 暂存），非 dot 路径已验证可幸存。旧根路径存在时自动迁移。
const BASELINE_FILE = path.join(__dirname, 'eslint-any-baseline.json');
const LEGACY_BASELINE = path.join(ROOT, '.eslint-any-baseline.json');
const RULE = '@typescript-eslint/no-explicit-any';

function countAny() {
  const { spawnSync } = require('node:child_process');
  // 直接用仓库本地的 eslint 二进制（避免依赖 PATH / npx 联网解析）。
  const eslintBin = path.join(ROOT, 'node_modules', '.bin', 'eslint');
  const r = spawnSync(eslintBin, ['.', '--format', 'json'], {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 128 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  // eslint 存在 error 级 lint 问题时会非零退出，但 stdout 仍有完整 JSON —— 以 JSON 可解析为准。
  const out = (r.stdout ?? '').trim();
  if (!out.startsWith('[') && !out.startsWith('{')) {
    throw new Error(`eslint 运行失败：exit=${r.status} ${r.stderr?.slice(0, 500) ?? ''}`);
  }
  const parsed = JSON.parse(out);
  // eslint 9 flat config 的 json formatter 返回 { results, ... }；旧版直接是数组。
  const files = Array.isArray(parsed) ? parsed : parsed.results ?? [];
  let total = 0;
  const byFile = {};
  for (const f of files) {
    const n = (f.messages || []).filter((m) => m.ruleId === RULE).length;
    if (n > 0) {
      total += n;
      byFile[f.filePath] = n;
    }
  }
  return { total, byFile };
}

function main() {
  const update = process.argv.includes('--update');
  const current = countAny();

  if (update) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + '\n');
    console.log(`✅ 基线已更新：no-explicit-any 总数 = ${current.total}`);
    console.log('   基线文件必须随本次改动一并提交（R6：缺失的基线会让棘轮静默失效）。');
    process.exit(0);
  }
  // R6 修复：检查模式下基线缺失 = 棘轮被绕过，必须失败而非静默重建。
  // （此前任何模式都会自动生成基线，删除文件即可让 CI 检查形同虚设。）
  if (!fs.existsSync(BASELINE_FILE) && fs.existsSync(LEGACY_BASELINE)) {
    fs.copyFileSync(LEGACY_BASELINE, BASELINE_FILE);
    console.log('ℹ️  已把旧位置基线迁移到 scripts/eslint-any-baseline.json（根目录 dotfile 在本工作区会被清理）');
  }
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error('❌ 基线文件缺失：' + path.relative(ROOT, BASELINE_FILE));
    console.error('   棘轮检查拒绝在无基线状态下运行（否则删除文件即可绕过）。');
    console.error('   确认是首次建立基线后，请显式运行并提交产物：');
    console.error('   node scripts/lint-any-ratchet.cjs --update && git add scripts/eslint-any-baseline.json');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  if (current.total > baseline.total) {
    console.error(`❌ no-explicit-any 存量增加：基线 ${baseline.total} → 当前 ${current.total}（+${current.total - baseline.total}）`);
    console.error('   新增的 any 必须消除或引入真实类型边界；确属合理存量请更新基线：');
    console.error('   node scripts/lint-any-ratchet.cjs --update');
    // 打出增量文件，便于定位
    for (const [file, n] of Object.entries(current.byFile)) {
      const before = baseline.byFile[file] ?? 0;
      if (n > before) console.error(`   +${n - before}  ${file}（${before} → ${n}）`);
    }
    process.exit(1);
  }
  if (current.total < baseline.total) {
    console.log(`🎉 no-explicit-any 存量减少：基线 ${baseline.total} → 当前 ${current.total}。`);
    console.log('   请运行 node scripts/lint-any-ratchet.cjs --update 收紧基线并提交。');
    process.exit(0);
  }
  console.log(`✅ no-explicit-any 棘轮通过：${current.total} 处（与基线持平）`);
}

main();
