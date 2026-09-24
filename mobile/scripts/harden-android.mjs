#!/usr/bin/env node
/**
 * Android 原生壳加固（P1 P4 修复，幂等）：在 cap sync 之后强制应用安全基线。
 *
 * 背景：android/ 是 gitignored 的生成目录（cap add 重新生成时 AndroidManifest.xml
 * 会回到 Capacitor 模板默认值 allowBackup="true"）。会话 token 落在
 * @capacitor/preferences（Android 上= SharedPreferences），允许云备份即允许
 * 备份通道提取凭据。本脚本在每个 build 的 sync 链尾把安全基线重新打上：
 *   1) AndroidManifest.xml：allowBackup="false" + dataExtractionRules + fullBackupContent；
 *   2) res/xml/{data_extraction_rules,full_backup_content}.xml：排除 sharedpref/file 域备份。
 * 资源源文件在 mobile/native-overrides/（被跟踪），此处复制进生成目录并覆写 manifest 属性。
 *
 * 幂等：已加固时跳过写盘；仅打印一行结果。
 * 失败语义：找不到 manifest 等结构性异常 → exit 1（与 splash-copy 一致，fail-fast）。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = dirname(dirname(fileURLToPath(import.meta.url)));
const androidMain = join(mobileDir, 'android', 'app', 'src', 'main');
const manifestPath = join(androidMain, 'AndroidManifest.xml');
const overridesDir = join(mobileDir, 'native-overrides', 'res', 'xml');
const resXmlDir = join(androidMain, 'res', 'xml');

if (!existsSync(manifestPath)) {
  console.error(`[harden-android] 未找到 ${manifestPath}（android/ 缺失或未 cap add）→ 放行（无原生壳无需加固）`);
  process.exit(0);
}

// 1) 复制备份排除规则资源（幂等覆盖）
for (const name of ['data_extraction_rules.xml', 'full_backup_content.xml']) {
  const src = join(overridesDir, name);
  if (!existsSync(src)) {
    console.error(`[harden-android] 缺少源资源 ${src}，中止`);
    process.exit(1);
  }
  copyFileSync(src, join(resXmlDir, name));
}

// 2) 加固 manifest 属性
let manifest = readFileSync(manifestPath, 'utf-8');
const original = manifest;

manifest = manifest.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
if (!/android:allowBackup="false"/.test(manifest)) {
  console.error('[harden-android] AndroidManifest 未含 allowBackup 属性且注入失败，人工检查');
  process.exit(1);
}
if (!/android:dataExtractionRules=/.test(manifest)) {
  manifest = manifest.replace(
    /android:allowBackup="false"/,
    'android:allowBackup="false"\n        android:dataExtractionRules="@xml/data_extraction_rules"\n        android:fullBackupContent="@xml/full_backup_content"'
  );
}

if (manifest !== original) {
  writeFileSync(manifestPath, manifest, 'utf-8');
  console.log('[harden-android] 已加固 AndroidManifest（allowBackup=false + 备份排除规则）');
} else {
  console.log('[harden-android] AndroidManifest 已是加固态，跳过');
}
process.exit(0);
