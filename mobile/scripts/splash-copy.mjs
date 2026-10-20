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
 * 覆盖范围（缺一不可，全部为 Capacitor 默认浅色启动图的回退路径）：
 *   1) drawable-port-{dpi}/splash.png     竖屏（插件对话框路径按配置解析）
 *   2) drawable-land-{dpi}/splash.png     横屏
 *   3) drawable/splash.png                无密度/方向限定的兜底 + 主题 windowBackground
 *   4) drawable-port-xxxhdpi/splash_large.png  Android 14+ 方形大启动图
 *   5) values/styles.xml                  API 31+ 系统启动图属性
 *      （windowSplashScreenBackground / windowSplashScreenAnimatedIcon），
 *      否则系统启动图回退为浅色背景 + 通用默认图标 sym_def_app_icon。
 *
 * 幂等：目标文件已存在也直接覆盖，保证与 assets/ 单一事实源一致。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(new URL('.', import.meta.url)), '');
// 脚本位于 mobile/scripts/，其父目录是 mobile/，仓库根再上一层。
const mobileDir = join(__dirname, '..');
const assetsDir = join(mobileDir, '../assets');
const androidDir = join(mobileDir, 'android/app/src/main/res');
const iosDir = join(mobileDir, 'ios/App/App/Assets.xcassets/LaunchScreen.imageset');

if (!existsSync(assetsDir)) {
  console.error(`[splash-copy] 找不到 ${assetsDir}，先运行 assets/generate-splash.py`);
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

// Android 横屏 splash（splash_land_{dpi}.png）——不拷贝则横屏冷启动回退默认浅色图
for (const dpi of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  const src = join(assetsDir, `splash_land_${dpi}.png`);
  if (!existsSync(src)) continue;
  const d = `drawable-land-${dpi}`;
  const dest = join(androidDir, d, 'splash.png');
  mkdirSync(join(androidDir, d), { recursive: true });
  cpSync(src, dest);
  console.log(`[splash-copy] splash_land_${dpi}.png → ${dest}`);
}

// 无限定兜底 drawable/splash.png：主题 windowBackground / 未知配置都解析到它。
// 用竖屏 xxhdpi 图（1440x2560）作为单一兜底，密度不足时由系统缩放。
const baseSrc = join(assetsDir, 'splash_xx.png');
if (existsSync(baseSrc)) {
  const dest = join(androidDir, 'drawable', 'splash.png');
  mkdirSync(join(androidDir, 'drawable'), { recursive: true });
  cpSync(baseSrc, dest);
  console.log(`[splash-copy] splash_xx.png → ${dest}（无限定兜底）`);
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

// 启动主题补丁：Android 12+（API 31+）冷启动走系统 SplashScreen API，
// 读的是主题的 windowSplashScreenBackground / windowSplashScreenAnimatedIcon，
// 而不是 android:background=@drawable/splash。不设置时系统回退为
// 浅色背景 + 通用默认图标（sym_def_app_icon）——即「启动等待画面不对」的根因。
const stylesPath = join(androidDir, 'values', 'styles.xml');
if (existsSync(stylesPath)) {
  let styles = readFileSync(stylesPath, 'utf-8');
  const needBg = !/name="windowSplashScreenBackground"/.test(styles);
  const needIcon = !/name="windowSplashScreenAnimatedIcon"/.test(styles);
  if (needBg || needIcon) {
    const inject = [
      needBg ? '        <item name="windowSplashScreenBackground">#0b0e14</item>' : '',
      needIcon ? '        <item name="windowSplashScreenAnimatedIcon">@drawable/splash_icon</item>' : '',
    ].filter(Boolean).join('\n');
    // 插入到 AppTheme.NoActionBarLaunch 的 </style> 之前（幂等：上面已判断缺失才进）
    styles = styles.replace(
      /(<\s*style[^>]*name="AppTheme\.NoActionBarLaunch"[\s\S]*?)(\s*)(<\s*\/style\s*>)/,
      (_m, head, _ws, tail) => `${head}\n${inject}\n    ${tail}`
    );
    writeFileSync(stylesPath, styles, 'utf-8');
    console.log('[splash-copy] styles.xml 已注入系统启动图属性（背景 #0b0e14 + 品牌 icon）');
  } else {
    console.log('[splash-copy] styles.xml 已含系统启动图属性，跳过');
  }
} else {
  console.log('[splash-copy] 未找到 values/styles.xml，跳过主题补丁');
}

console.log('[splash-copy] 完成');
