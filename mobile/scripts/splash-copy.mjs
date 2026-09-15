#!/usr/bin/env node
/**
 * 把 assets/ 下生成的启动图复制到 Capacitor 原生工程的资源目录。
 *
 * `cap sync` 会重新生成 android/ 与 ios/ 目录（覆盖模板占位图），
 * 所以本脚本必须在 **每次 `cap sync` 之后** 运行一次：
 *
 *   pnpm --filter @agent-harness/mobile exec cap sync
 *   pnpm --filter @agent-harness/mobile run splash:copy
 *   cd mobile/android && ./gradlew assembleDebug --no-daemon
 *
 * 幂等：目标文件已存在也直接覆盖，保证与 assets/ 单一事实源一致。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(new URL('.', import.meta.url)), '');
// 脚本位于 mobile/scripts/，其父目录是 mobile/，仓库根再上一层。
const mobileDir = join(__dirname, '..');
const assetsDir = join(mobileDir, '../assets');
const androidDir = join(mobileDir, 'android/app/src/main/res');
const iosDir = join(mobileDir, 'ios/App/App/Assets.xcassets/LaunchScreen.imageset');

if (!existsSync(assetsDir)) {
  console.error(`[splash-copy] 找不到 ${assetsDir}，先运行 assets/generate-splash.mjs`);
  process.exit(1);
}
if (!existsSync(androidDir)) {
  console.error('[splash-copy] 找不到 android 资源目录，先运行 `cap sync`（pnpm exec cap sync android）');
  process.exit(1);
}

// Android 竖屏 splash 的密度映射（splash_{m,x,xx,xxx}.png）
const androidDpi = [
  { file: 'splash_m.png', dirs: ['drawable-port-mdpi', 'drawable-port-hdpi'] },
  { file: 'splash_x.png', dirs: ['drawable-port-xhdpi'] },
  { file: 'splash_xx.png', dirs: ['drawable-port-xxhdpi'] },
  { file: 'splash_xxx.png', dirs: ['drawable-port-xxxhdpi'] },
];
for (const { file, dirs } of androidDpi) {
  const src = join(assetsDir, file);
  if (!existsSync(src)) continue;
  for (const d of dirs) {
    const dest = join(androidDir, d, 'splash.png');
    mkdirSync(join(androidDir, d), { recursive: true });
    cpSync(src, dest);
    console.log(`[splash-copy] ${file} → ${dest}`);
  }
}

// Android 14+ 大尺寸方形启动图（splash_large.png → drawable-port-xxxhdpi/splash_large.png）
const largeSrc = join(assetsDir, 'splash_large.png');
if (existsSync(largeSrc)) {
  const dest = join(androidDir, 'drawable-port-xxxhdpi', 'splash_large.png');
  mkdirSync(join(androidDir, 'drawable-port-xxxhdpi'), { recursive: true });
  cpSync(largeSrc, dest);
  console.log(`[splash-copy] splash_large.png → ${dest}`);
}

// iOS 启动图（Assets.xcassets/LaunchScreen.imageset，Capacitor 模板用 LaunchScreen）
if (existsSync(iosDir)) {
  const iosFiles = readdirSync(assetsDir).filter((f) => /^Splash-.+\.png$/.test(f));
  // iOS 的 imageset 用 Contents.json 描述各 1x/2x/3x 图；
  // 这里把所有 iPad/iPhone 规格都拷进 imageset 同目录，由 Contents.json 引用。
  for (const f of iosFiles) {
    const dest = join(iosDir, f);
    cpSync(join(assetsDir, f), dest);
    console.log(`[splash-copy] ${f} → ${dest}`);
  }
} else {
  console.log('[splash-copy] 未找到 iOS LaunchScreen imageset，跳过（运行 cap sync 后若报缺图，把 assets/Splash-*.png 拷入 ios/App/App/Assets.xcassets/LaunchScreen.imageset/）');
}

console.log('[splash-copy] 完成');
