#!/usr/bin/env node
// 构建后处理：对 tsc 产物 dist/**\/*.js 逐文件做压缩 + 标识符混淆（esbuild minify）。
// 设计约束：
// - 只处理 .js（tsc NodeNext + 无 type:module => CommonJS 产物）；.d.ts 声明文件保持原样，
//   TS 消费者的类型信息不受影响。
// - keepNames: true：保留 function/class 名称，避免破坏依赖 fn.name / constructor.name /
//   错误栈可读性的运行时行为。
// - 不做字符串阵列编码 / 控制流平坦化（javascript-obfuscator 式重混淆）：那类变换会破坏
//   require() 的静态可分析性，且对 MCP/K8s/遥测等动态代码路径有真实回归风险。若后续需要
//   更强抗逆向能力，可在此脚本内按文件粒度灰度接入。
// - tsc 未产出 sourceMap（tsconfig sourceMap:false），无需同步 map。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) yield full;
  }
}

let files = 0;
let before = 0;
let after = 0;

for (const file of walk(distDir)) {
  const code = readFileSync(file, 'utf8');
  let result;
  try {
    result = await transform(code, {
      loader: 'js',
      format: 'cjs', // 与 tsconfig module:NodeNext + 无 type:module 的产物形态一致
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
console.log(`[obfuscate] ${files} files, ${(before / 1024).toFixed(1)}KiB -> ${(after / 1024).toFixed(1)}KiB (-${pct}%)`);
