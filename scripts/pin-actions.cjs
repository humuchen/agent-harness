#!/usr/bin/env node
/**
 * actions SHA pin 棘轮（P2-10b，承接 ci.yml 供应链待办 P1#33）。
 *
 * 背景：两份 workflow（.github/workflows/*.yml）的 `uses:` 此前以主版本 tag 引用，
 * tag 被上游覆盖即可把任意代码跑进 CI。2026-10 两次收尾尝试均因构建环境无外网
 * （GitHub API 不可达）未能取得精确 SHA——凭记忆写入错误 SHA 会直接挂 CI，故把
 * 「取 SHA」从人工动作机制化为脚本 + 「防回潮」机制化为棘轮：
 *
 *   - `node scripts/pin-actions.cjs`          # 检查（CI 门禁 / 本地，无需网络）
 *   - `node scripts/pin-actions.cjs --apply`  # 有网环境：git ls-remote 解析浮动引用
 *                                             # （tag / 分支）→commit SHA 并写回
 *                                             # workflow（owner/repo@<sha> # vX）
 *
 * 棘轮语义（与 lint-any-ratchet.cjs 同构，基线 scripts/actions-pin-baseline.json）：
 *   1. tag 引用必须出现在基线豁免清单 —— 新增 action 未登记直接红；
 *   2. 基线条目必须仍存在于 workflow —— 删除 action 必须同步清理基线；
 *   3. 基线条目不得已被 pin 成 SHA —— pin 后忘了从豁免清单移除 = 红（防棘轮松弛）。
 * `--apply` 后基线自动同步（已 pin 条目移出豁免），diff 随 PR 人工确认。
 *
 * 收尾状态：2026-11-18 9 个 action（18 处引用）已全量 pin，基线豁免为空——
 * 此后本脚本常态运行于 check 模式（防回潮守卫）；升级 action 版本时临时把目标
 * `repo@新tag` 写回 uses 行并登记基线，跑 --apply 后基线再次清零。
 *
 * 解析说明：tag（尤其 annotated tag）的 `git ls-remote refs/tags/v4` 返回的是 tag
 * 对象 SHA 而非 commit SHA；SHA pin 必须用 commit SHA，故带 `^{}` deref 查询，
 * 轻量 tag（无 ^{} 行）回落到 tag 行自身。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WF_DIR = path.join(__dirname, '..', '.github', 'workflows');
const BASELINE_FILE = path.join(__dirname, 'actions-pin-baseline.json');

const USES_RE = /^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s*#\s*(\S+))?\s*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** 解析全部 workflow 的 uses 引用。返回 {file, line, repo, ref, note, raw} 列表。 */
function scanWorkflows() {
  const refs = [];
  const files = fs
    .readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
  for (const f of files) {
    const full = path.join(WF_DIR, f);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(USES_RE);
      if (!m) return;
      const ref = m[1];
      // 本地复合 action（./...）与 docker:// 形态不参与 tag/SHA pin。
      if (ref.startsWith('./') || ref.startsWith('docker://')) return;
      const at = ref.lastIndexOf('@');
      if (at <= 0) return;
      refs.push({
        file: f,
        lineNo: i + 1,
        raw: line,
        repo: ref.slice(0, at),
        ref: ref.slice(at + 1),
        note: m[2] || ''
      });
    });
  }
  return refs;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`✖ 基线缺失：${path.relative(process.cwd(), BASELINE_FILE)}`);
    console.error('  棘轮检查依赖基线文件存在（缺失会让门禁形同虚设）。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
}

/** 规则 3 内部用：tag 引用（含登记名）标准化为 repo@tag。 */
function tagNameOf(r) {
  return `${r.repo}@${r.ref}`;
}

function runCheck() {
  const baseline = loadBaseline();
  const unpinned = new Set(baseline.unpinned || []);
  const refs = scanWorkflows();
  const failures = [];
  let pinnedCount = 0;

  for (const r of refs) {
    if (SHA_RE.test(r.ref)) {
      pinnedCount++;
      if (!r.note) {
        failures.push(
          `${r.file}:${r.lineNo}  已 pin 但缺版本注释（应为 \`uses: ${r.repo}@<sha> # vX.Y.Z\`）`
        );
      }
      if (unpinned.has(`${r.repo}@${r.note}`)) {
        failures.push(
          `${r.file}:${r.lineNo}  ${r.repo} 已 pin 成 SHA，但基线豁免清单仍含 ${r.repo}@${r.note} —— 请移除基线条目（棘轮只紧不松）`
        );
      }
      continue;
    }
    const key = tagNameOf(r);
    if (!unpinned.has(key)) {
      failures.push(
        `${r.file}:${r.lineNo}  新增/未登记的 tag 引用 \`${key}\` —— 请在有网环境执行 \`node scripts/pin-actions.cjs --apply\`，或将其登记进基线豁免清单`
      );
    }
  }

  // 基线条目必须仍然存活（引用被删则同步清理基线，防死条目累积）。
  const liveKeys = new Set(refs.filter((r) => !SHA_RE.test(r.ref)).map(tagNameOf));
  for (const key of unpinned) {
    if (!liveKeys.has(key)) {
      failures.push(
        `基线条目 \`${key}\` 已不再被任何 workflow 引用 —— 请从 actions-pin-baseline.json 移除`
      );
    }
  }

  console.log(
    `actions pin 棘轮：${pinnedCount} 已 pin / ${refs.length - pinnedCount} 待 pin（豁免基线 ${unpinned.size} 条）`
  );
  if (failures.length) {
    console.error(`\n✖ ${failures.length} 处违规：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (refs.length - pinnedCount === 0) {
    console.log('✅ 全部 actions 已 pin 到 commit SHA —— 可删除基线豁免与本脚本（收尾态）。');
  } else {
    console.log('ℹ️  待 pin 项见基线豁免清单；收尾方法：有网环境跑 `node scripts/pin-actions.cjs --apply`。');
  }
}

/** 有网环境：浮动引用（tag/分支）→ commit SHA（git ls-remote），写回 workflow 与基线。 */
function resolveCommitSha(repo, ref) {
  const url = `https://github.com/${repo}.git`;
  // ^{} deref：annotated tag 返回 commit SHA；轻量 tag 无该行，回落 tag 行自身。
  let out;
  try {
    out = execFileSync(
      'git',
      ['ls-remote', url, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    return { error: `git ls-remote 失败（无网络或仓库不可达）：${e.message.split('\n')[0]}` };
  }
  let commitSha = null;
  let tagSha = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+)$/);
    if (!m) continue;
    if (m[2].endsWith('^{}')) commitSha = m[1];
    else tagSha = m[1];
  }
  if (commitSha || tagSha) {
    if (!commitSha && tagSha) {
      console.log(`  ⚠ ${repo}@${ref} 是轻量 tag，SHA 即 commit（可直接 pin）`);
    }
    return { sha: commitSha || tagSha };
  }
  // tag 未命中：ref 可能是分支（如 actions/dependency-review-action@v4 走 refs/heads/v4）。
  // 分支是浮动引用、上游可直接改写指向——比 tag 更需要 pin，commit SHA 即分支头。
  try {
    const branchOut = execFileSync(
      'git',
      ['ls-remote', url, `refs/heads/${ref}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const m = branchOut.match(/^([0-9a-f]{40})\s+refs\/heads\//);
    if (m) {
      console.log(`  ⚠ ${repo}@${ref} 是分支引用（浮动指向，SHA pin 尤其必要）`);
      return { sha: m[1] };
    }
  } catch {
    /* 走统一的未命中报错 */
  }
  return { error: `远端既无 tag 也无分支 ${ref}` };
}

function runApply() {
  const baseline = loadBaseline();
  const unpinned = new Set(baseline.unpinned || []);
  const refs = scanWorkflows();
  const toPin = refs.filter((r) => !SHA_RE.test(r.ref));
  if (!toPin.length) {
    console.log('没有待 pin 的 tag 引用，无需处理。');
    return;
  }
  // 同一 repo@tag 可能多处引用：SHA 逐个解析一次，全部行统一替换。
  const shaByKey = new Map();
  for (const r of new Map(toPin.map((r) => [tagNameOf(r), r])).values()) {
    const key = tagNameOf(r);
    console.log(`解析 ${key} …`);
    const res = resolveCommitSha(r.repo, r.ref);
    if (res.error) {
      console.error(`  ✖ ${key}：${res.error}`);
      process.exit(1);
    }
    shaByKey.set(key, res.sha);
  }
  // 逐文件写回（保留原缩进/注释格式：`uses: owner/repo@<sha> # vX`）。
  // 同一 file+key 多处出现时 split/join 一次全量替换，循环内按 seen 键跳过，
  // 避免第二处起「已替换文本未命中」的误报。
  const byFile = new Map();
  for (const r of toPin) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, list] of byFile) {
    const full = path.join(WF_DIR, file);
    let text = fs.readFileSync(full, 'utf8');
    const seen = new Set();
    for (const r of list) {
      const key = tagNameOf(r);
      if (seen.has(key)) continue;
      seen.add(key);
      const sha = shaByKey.get(key);
      const from = `uses: ${key}`;
      const to = `uses: ${r.repo}@${sha} # ${r.ref}`;
      if (!text.includes(from)) {
        console.error(`✖ ${file}:${r.lineNo} 替换目标未命中：${from}`);
        process.exit(1);
      }
      text = text.split(from).join(to);
    }
    fs.writeFileSync(full, text);
    console.log(`✅ ${file}：${list.length} 处引用已 pin`);
  }
  // 基线同步：已 pin 条目移出豁免（棘轮只紧不松）。
  baseline.unpinned = [...unpinned].filter((k) => !shaByKey.has(k));
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`✅ 基线豁免已同步清理，剩余 ${baseline.unpinned.length} 条`);
}

function main() {
  const apply = process.argv.includes('--apply');
  if (apply) runApply();
  else runCheck();
}

main();
