#!/usr/bin/env node
// 构建后处理（公共脚本）：对指定目录（默认 ./dist，相对调用方 cwd）下的 tsc 产物
// 逐文件做压缩 + 标识符混淆（esbuild minify）。供 monorepo 各 package 的 build 复用：
//   node ../../scripts/obfuscate.mjs [distDir]
// 设计约束：
// - 只处理 .js；.d.ts 声明文件保持原样，TS 消费者的类型信息不受影响。
// - keepNames: true：保留 function/class 名称，避免破坏依赖 fn.name / constructor.name /
//   错误栈可读性的运行时行为。
// - 不做字符串阵列编码 / 控制流平坦化（javascript-obfuscator 式重混淆）：那类变换会破坏
//   require() 的静态可分析性，且对 MCP/K8s/遥测等动态代码路径有真实回归风险。若后续需要
//   更强抗逆向能力，可在此脚本内按文件粒度灰度接入。
// - tsc 未产出 sourceMap（tsconfig.base sourceMap:false），无需同步 map。
// - format 按产物向上最近一层 package.json 的 type 字段自动判定（module => esm，
//   否则 cjs），与 tsconfig module:NodeNext 的产物形态保持一致；跨 package 调用时
//   esbuild 从根 node_modules 解析，各 package 无需单独声明该依赖。
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { transform } from 'esbuild';

const distDir = resolve(process.argv[2] ?? 'dist');

const pkgTypeCache = new Map();

/** 产物文件向上最近的 package.json 的 type 字段（无则视为 commonjs）。 */
function nearestPackageType(file) {
  let dir = dirname(file);
  for (;;) {
    const cached = pkgTypeCache.get(dir);
    if (cached !== undefined) return cached;
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const type = JSON.parse(readFileSync(pkgPath, 'utf8')).type ?? 'commonjs';
      pkgTypeCache.set(dir, type);
      return type;
    }
    const parent = dirname(dir);
    if (parent === dir) return 'commonjs';
    dir = parent;
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) yield full;
  }
}

if (!existsSync(distDir)) {
  console.error(`[obfuscate] dist dir not found: ${distDir} (run tsc first)`);
  process.exit(1);
}

let files = 0;
let before = 0;
let after = 0;

for (const file of walk(distDir)) {
  const code = readFileSync(file, 'utf8');
  const format = nearestPackageType(file) === 'module' ? 'esm' : 'cjs';
  let result;
  try {
    result = await transform(code, {
      loader: 'js',
      format,
      target: 'es2022',
      minify: true,
      keepNames: true,
      legalComments: 'none', // src 中无 @license/@preserve 注释
    });
  } catch (err) {
    console.error(`[obfuscate] FAILED: ${relative(distDir, file)}\n${err.message}`);
    process.exit(1);
  }
  writeFileSync(file, result.code);
  files += 1;
  before += Buffer.byteLength(code);
  after += Buffer.byteLength(result.code);
}

const pct = before > 0 ? ((1 - after / before) * 100).toFixed(1) : '0';
console.log(`[obfuscate] ${distDir}: ${files} files, ${(before / 1024).toFixed(1)}KiB -> ${(after / 1024).toFixed(1)}KiB (-${pct}%)`);
