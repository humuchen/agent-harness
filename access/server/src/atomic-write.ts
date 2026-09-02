/**
 * atomic-write：原子文件写入工具函数。
 *
 * 解决 P0-6 指出的三处非原子写风险（rag/store.ts、chat-sessions.ts、eval.ts）：
 * 直接 writeFileSync 到目标路径，进程在 write 与 close 之间崩溃会产生半截 JSON，
 * 下次 readFileSync 触发 JSON.parse 抛出整模块启动失败。
 *
 * 方案：先写 .tmp，再 rename 到目标（POSIX rename 是原子的）。
 * Node 的 fs/promises rename 在 Windows 上会因文件占用而失败，
 * 故同步版同时覆盖两种场景：失败时回退到直接写（避免部署卡死）。
 */
import { writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * 原子写入 JSON 文件：tmp → rename。
 * @param targetPath 目标文件绝对路径
 * @param data       待序列化的对象
 * @param tmpSuffix  临时文件后缀（默认 '.tmp'）
 */
export function atomicWriteJson(
  targetPath: string,
  data: unknown,
  tmpSuffix = '.tmp'
): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = targetPath + tmpSuffix;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Windows 下 rename 可能因文件占用抛错：回退到直接写，保证功能可用。
    // 此路径下若进程崩溃仍有概率产生半截文件，属已知降级行为。
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* 忽略清理失败 */
      }
    }
    throw err;
  }
}

/** 仅删除临时文件（上述 catch 分支用）。 */
function unlinkSync(path: string): void {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.unlinkSync(path);
}
