#!/usr/bin/env node
/**
 * mobile `build` 脚本的原生 sync 守卫。
 *
 * 背景：root / Render 部署走 `pnpm -r build`，会递归执行本包的 `build`。
 * 本包 `build` 历史上硬跑 `cap sync && splash-copy`——但 `android/` 与 `ios/`
 * 都是 gitignored（干净 checkout 上不存在），于是：
 *   - 云端（Render，linux）无法、也不该跑原生壳 sync（没有 gradle/xcodebuild）；
 *   - `splash-copy.mjs` 因「找不到 android 资源目录」硬 exit(1)，把整条递归构建拖挂。
 *
 * 守卫策略（基于「原生工程目录是否存在」，与环境无关、最稳）：
 *   - 无 android/ 且无 ios/（干净 checkout / CI / 未 cap add）→ 跳过 cap sync + splash-copy，
 *     直接 exit 0。webapp dist 已由 build 脚本前一步构建，Render 部署 web 服务足够。
 *   - 有任一原生目录（本地已 cap add）→ 保持原有完整 sync 链：
 *     `cap sync`（重生成资源）→ `splash-copy.mjs`（覆写品牌启动图），
 *     任一步失败即以该步退出码交回（保留本地「忘记 cap sync」时 fail-fast 的语义）。
 *
 * 幂等、无副作用：只在判定「可跳过」时打印提示并放行。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 脚本位于 mobile/scripts/，其父目录是 mobile/。
const mobileDir = dirname(dirname(fileURLToPath(import.meta.url)));
const androidDir = join(mobileDir, 'android');
const iosDir = join(mobileDir, 'ios');
const hasNative = existsSync(androidDir) || existsSync(iosDir);

if (!hasNative) {
  const ci = process.env.CI === 'true' || !!process.env.RENDER_GIT_REPO;
  console.log(
    `[cap-sync-guard] 未检测到原生工程目录（android/、ios/ 均缺，CI=${ci}）→ ` +
      '跳过 cap sync + splash-copy（原生壳需本地 cap add 后再单独构建；云端构建 web 服务无需此步）'
  );
  process.exit(0);
}

// 本地存在原生工程：跑完整 sync 链（cap sync 重生成资源 → splash-copy 覆写品牌启动图）。
// 用 `pnpm exec cap` 显式解析 workspace 内的 @capacitor/cli，避免裸 `cap` 的 PATH 歧义。
const sync = spawnSync('pnpm', ['exec', 'cap', 'sync'], {
  stdio: 'inherit',
  cwd: mobileDir
});
if (sync.status !== 0) {
  console.error(`[cap-sync-guard] cap sync 失败（exit ${sync.status ?? 1}），中止构建`);
  process.exit(sync.status ?? 1);
}

const splash = spawnSync(process.execPath, [join(mobileDir, 'scripts/splash-copy.mjs')], {
  stdio: 'inherit',
  cwd: mobileDir
});
if (splash.status !== 0) {
  console.error(`[cap-sync-guard] splash-copy 失败（exit ${splash.status ?? 1}），中止构建`);
  process.exit(splash.status ?? 1);
}
process.exit(0);
