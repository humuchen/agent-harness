/**
 * 运行 ID 生成（P1-2：从 harness.ts 拆出）。
 *
 * 模块级自增计数器 + 时间戳组合，保证同进程内 id 唯一。
 * 注意：idCounter 为模块级共享状态（与拆分前 harness.ts 的模块级变量语义一致），
 * 所有 run id 共享同一计数序列。
 */

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}
