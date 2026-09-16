/**
 * 存储用量与清理：统一「总计 / 应用 / 数据 / 缓存」四项的口径，以及「清除数据 / 清除缓存」两个动作。
 *
 * ## 取数口径（按环境分两套，因为「数据 / 缓存」本就不是一回事）
 *
 * | 项 | 原生壳（Capacitor） | 纯 Web |
 * |---|---|---|
 * | 应用 | 应用自身加载的同源 JS/CSS 体积（Resource Timing 实测） | 同左 |
 * | 数据 | 私有文件目录 `Directory.Data`(= Android `getFilesDir()`) + 网页层本地存储 | `localStorage` 全部键 |
 * | 缓存 | 缓存目录 `Directory.Cache`(= `getCacheDir()`) | `CacheStorage` |
 * | 总计 | 应用 + 数据 + 缓存（即上面三项之和，非系统口径的总占用） | 同左 |
 *
 * - 「应用」刻意用**网页资源体积**而不是安装体积：APK/IPA 体积是 `PackageManager` 的口径，
 *   网页层没有任何 API 能读到，硬做只能编数字。网页资源体积可精确测量，且正是应用自身的一部分。
 * - 原生下不用 `navigator.storage.estimate()` 当「缓存」：它只反映同源配额（localStorage/IDB/
 *   CacheStorage），量不到 WebView 的 HTTP 缓存 —— 那才是 Android「应用信息 → 缓存」显示的那块。
 *
 * ## 清理动作
 *
 * - `clearCache()`：只清缓存（原生缓存目录 + CacheStorage），**不动**登录状态与偏好。
 * - `clearData()`：清数据 + 缓存，对齐 Android「清除存储」语义 —— 会抹掉登录凭据与全部偏好，
 *   调用方**必须先做二次确认**并提示「需要重新登录」。
 *
 * 取原生插件沿用 `plugin-notify.ts` 的既有约定：走全局 `window.Capacitor.Plugins`，
 * webapp 不依赖 `@capacitor/*`；纯 Web 环境下所有函数安全降级。
 */

/** Capacitor Filesystem 的 `Directory` 取值（运行时就是字符串，无需引入 Capacitor 包）。 */
const DATA_DIR = 'DATA';
const CACHE_DIR = 'CACHE';

/** 递归深度与条目上限：守住上限，避免异常目录结构把主线程拖住。 */
const MAX_DEPTH = 6;
const MAX_ENTRIES = 4000;

/** CacheStorage 等浏览器存储操作的等待上限：部分 WebView 上会长时间不返回，不能让它卡住整条流程。 */
const STORAGE_OP_TIMEOUT_MS = 1500;

export interface StorageBreakdown {
  /** 应用 + 数据 + 缓存（三项之和；任一项可测即参与求和） */
  total: number | null;
  /** 应用：应用自身网页资源体积 */
  app: number | null;
  /** 数据：私有文件目录 + 网页层本地存储 */
  data: number | null;
  /** 缓存：缓存目录 + CacheStorage */
  cache: number | null;
  /** 是否运行在 Capacitor 原生壳内（决定上面各项目标的来源） */
  native: boolean;
}

export interface ClearOutcome {
  /** 是否有可执行的清理目标（false = 环境完全不支持） */
  ran: boolean;
  /** 清理前测得的字节数，用于「释放了多少」提示；不可测时 null */
  bytes: number | null;
}

export interface NativeFsEntry {
  name: string;
  type: 'directory' | 'file';
  size: number;
}

/** 只声明本模块用到的部分 Filesystem 接口（避免引入 Capacitor 类型依赖）。 */
export interface NativeFilesystem {
  readdir(options: {
    path: string;
    directory: string;
  }): Promise<{ files: NativeFsEntry[] }>;
  rmdir(options: {
    path: string;
    directory: string;
    recursive?: boolean;
  }): Promise<void>;
}

interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: Record<string, unknown>;
  };
}

/** 取出原生壳的 Filesystem 插件；非原生环境（或插件未注册）返回 null。 */
export function nativeFilesystem(): NativeFilesystem | null {
  const g = globalThis as unknown as CapacitorGlobal;
  if (typeof g.Capacitor?.isNativePlatform !== 'function') return null;
  if (!g.Capacitor.isNativePlatform()) return null;
  const fs = g.Capacitor.Plugins?.Filesystem as NativeFilesystem | undefined;
  if (!fs) return null;
  if (typeof fs.readdir !== 'function' || typeof fs.rmdir !== 'function') {
    return null;
  }
  return fs;
}

/** 「默认工作空间路径」的本地存储键（设置中心读写，单一事实源）。 */
export const WORKSPACE_PATH_KEY = 'ah:workspace-path';

/** 默认工作空间目录名（拼接在用户主目录之后）。 */
export const WORKSPACE_DIR_NAME = 'AgentHarness';

/** 拼出带分隔符的路径片段，避免「C:/Users」之类的裸拼接。 */
function joinPath(base: string, tail: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  const trimmed = base.replace(/[\\/]+$/, '');
  return tail ? `${trimmed}${sep}${tail}` : trimmed;
}

/**
 * 推断「当前设备主目录」，用于拼出默认工作空间路径（如 /Users/huyang/AgentHarness）。
 * 浏览器无法直接读文件系统，故取**可确定**的环境信号：
 *  - Capacitor 原生壳：经 `@capacitor/filesystem` 的 `getAbsolutePath` 读 EXTERNAL_ROOT
 *    的绝对路径（Android /storage/emulated/0、iOS 为外部存储根，即用户主目录）；
 *  - 纯 Web / 插件缺失 / 推断失败：返回 null，由调用方显示占位符而非编造路径。
 * 推断结果缓存一次（异步，避免每次进设置页都重复读盘）。
 */
let homeDirCache: string | null | undefined;
async function inferHomeDir(): Promise<string | null> {
  if (homeDirCache !== undefined) return homeDirCache;
  const g = globalThis as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: Record<string, { getAbsolutePath?: (opts: { path: string; directory: string }) => Promise<{ uri: string }> }>;
    };
  };
  const cap = g.Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.Filesystem?.getAbsolutePath) {
    try {
      const { uri } = await cap.Plugins.Filesystem.getAbsolutePath({
        path: '',
        directory: 'EXTERNAL_ROOT'
      });
      homeDirCache = uri || null;
      return homeDirCache;
    } catch {
      homeDirCache = null;
      return null;
    }
  }
  homeDirCache = null;
  return homeDirCache;
}

/** 限时等待：超时或异常都返回 null，把「尽力而为」的语义显式化。 */
function withTimeout<T>(
  p: Promise<T>,
  ms = STORAGE_OP_TIMEOUT_MS
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** 求和：两项都不可测才算不可测（单项缺失按 0 计入）。 */
function sum(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// ─────────────────────────── 原生壳：目录测量与清空 ───────────────────────────

/** 递归统计原生某个目录的字节数；读取失败返回 null（UI 显示「—」，不编数字）。 */
async function nativeDirBytes(
  fs: NativeFilesystem,
  directory: string
): Promise<number | null> {
  let visited = 0;
  const walk = async (path: string, depth: number): Promise<number> => {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) return 0;
    const { files } = await fs.readdir({ path, directory });
    let total = 0;
    for (const entry of files ?? []) {
      if (visited >= MAX_ENTRIES) break;
      visited += 1;
      if (entry.type === 'directory') {
        total += await walk(
          path ? `${path}/${entry.name}` : entry.name,
          depth + 1
        );
      } else {
        total += Number(entry.size) || 0;
      }
    }
    return total;
  };
  try {
    return await walk('', 0);
  } catch {
    return null;
  }
}

/**
 * 清空原生某个目录下的所有条目（递归），返回删除条目数。
 * 单个条目失败不阻断其余（目录里常有被系统占用的临时文件）；整体失败返回 null。
 */
async function nativeClearDir(
  fs: NativeFilesystem,
  directory: string
): Promise<number | null> {
  try {
    const { files } = await fs.readdir({ path: '', directory });
    let removed = 0;
    for (const entry of files ?? []) {
      try {
        await fs.rmdir({ path: entry.name, directory, recursive: true });
        removed += 1;
      } catch {
        /* 被占用的条目跳过，不影响整体清理 */
      }
    }
    return removed;
  } catch {
    return null;
  }
}

// ───────────────────────────── 纯 Web：本地存储与缓存 ─────────────────────────────

/** localStorage 全部键的近似字节数（UTF-16，按 2 字节/字符估算）。 */
function webLocalBytes(): number {
  const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
  if (!ls) return 0;
  let total = 0;
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (key === null) continue;
    total += (key.length + (ls.getItem(key)?.length ?? 0)) * 2;
  }
  return total;
}

interface CacheStorageLike {
  keys(): Promise<string[]>;
  open(name: string): Promise<{
    keys(): Promise<Request[]>;
    match(req: Request): Promise<Response | undefined>;
  }>;
  delete(name: string): Promise<boolean>;
}

function cacheStorage(): CacheStorageLike | null {
  const c = (globalThis as unknown as { caches?: CacheStorageLike }).caches;
  return c && typeof c.keys === 'function' ? c : null;
}

/** CacheStorage 总字节：遍历各 cache 的响应，累加 Content-Length（读不到该头则不计）。 */
async function webCacheBytes(): Promise<number | null> {
  const c = cacheStorage();
  if (!c) return null;
  try {
    const names = (await withTimeout(c.keys())) ?? [];
    let total = 0;
    for (const name of names) {
      const cache = await withTimeout(c.open(name));
      if (!cache) continue;
      const reqs = (await withTimeout(cache.keys())) ?? [];
      for (const req of reqs) {
        const res = await withTimeout(cache.match(req));
        const len = Number(res?.headers?.get('content-length') ?? 0);
        if (Number.isFinite(len) && len > 0) total += len;
      }
    }
    return total;
  } catch {
    return null;
  }
}

/** 清空 CacheStorage（无 Service Worker 时为空操作）。 */
async function webClearCache(): Promise<void> {
  const c = cacheStorage();
  if (!c) return;
  const names = (await withTimeout(c.keys())) ?? [];
  await withTimeout(Promise.all(names.map((n) => c.delete(n))));
}

// ─────────────────────────── 应用资源体积（Resource Timing） ───────────────────────────

/**
 * 应用自身网页资源体积：累加同源 JS / CSS 的 `encodedBodySize`（退回 transferSize）。
 * 原生壳下资源由本机服务器提供、Web 下由站点提供，两者都是同源，故可精确测量。
 * 拿不到 Resource Timing（老环境 / 尚未加载任何资源）返回 null。
 */
function appAssetBytes(): number | null {
  const perf = (globalThis as unknown as { performance?: Performance })
    .performance;
  if (!perf || typeof perf.getEntriesByType !== 'function') return null;
  const entries = perf.getEntriesByType(
    'resource'
  ) as PerformanceResourceTiming[];
  if (!entries.length) return null;
  const origin = (globalThis as unknown as { location?: Location }).location
    ?.origin;
  let total = 0;
  let counted = 0;
  for (const e of entries) {
    const name = e.name ?? '';
    if (!/\.(js|mjs|css)(\?|#|$)/i.test(name)) continue;
    // 只算应用自身资源，排除 CDN / 接口等外链
    if (origin && !name.startsWith(origin)) continue;
    const size = Number(e.encodedBodySize) || Number(e.transferSize) || 0;
    if (size > 0) {
      total += size;
      counted += 1;
    }
  }
  return counted ? total : null;
}

// ───────────────────────────────── 对外 API ─────────────────────────────────

/** 测量四项占用。任何一项读不到都给 null（UI 显示「—」），不做假数据。 */
export async function measureStorage(): Promise<StorageBreakdown> {
  const fs = nativeFilesystem();
  const app = appAssetBytes();
  const localBytes = webLocalBytes();

  if (fs) {
    // 原生壳：数据 = 私有文件目录 + 网页层本地存储；缓存 = 缓存目录。
    // 刻意**不**把 CacheStorage 计入缓存：系统的「缓存」口径就是缓存目录，混入 Web 侧容量会
    // 让两边数字对不上；而且 `caches.keys()` 在部分 WebView 上会长时间不返回，不该挡住主口径
    // （实测无头环境会间歇性卡住整次测量，导致四行全部显示「—」）。
    const [fileBytes, cacheBytes] = await Promise.all([
      nativeDirBytes(fs, DATA_DIR),
      nativeDirBytes(fs, CACHE_DIR)
    ]);
    const data = sum(fileBytes, localBytes);
    const cache = cacheBytes;
    return { total: sum(sum(app, data), cache), app, data, cache, native: true };
  }

  const cache = await webCacheBytes();
  const data = localBytes;
  return { total: sum(sum(app, data), cache), app, data, cache, native: false };
}

/**
 * 清除缓存。按环境走**各自唯一的口径**，不做交叉混合：
 *  - 原生壳：清缓存目录（= Android「应用信息 → 缓存」那一块）；
 *  - 纯 Web：清 CacheStorage（项目当前无 Service Worker，空时无副作用）。
 *
 * 刻意不把两者混着做：`CacheStorage` 在部分 WebView 上会长时间不返回，早先把它并进原生清理
 * 的同一段流程，实测会把原生清理一起堵死（表现为点了「清除缓存」什么都没发生）；而且系统的
 * 「缓存」就是缓存目录，混入 Web 侧容量反而会让数字对不上。
 * 不动登录凭据与用户偏好，故调用方无需二次确认。
 */
export async function clearCache(): Promise<ClearOutcome> {
  const fs = nativeFilesystem();

  if (fs) {
    // 先量释放量再清；两步都只走原生目录，无 CacheStorage 参与
    const bytes = await nativeDirBytes(fs, CACHE_DIR);
    const removed = await nativeClearDir(fs, CACHE_DIR);
    return { ran: removed !== null, bytes };
  }

  const bytes = await webCacheBytes();
  if (!cacheStorage()) return { ran: false, bytes };
  await webClearCache();
  return { ran: true, bytes };
}

/**
 * 清除数据：数据 + 缓存一起清（对齐 Android「清除存储」的语义）。
 * 会抹掉登录凭据与全部偏好 —— 调用方必须先二次确认，并在完成后引导重新登录。
 */
export async function clearData(): Promise<ClearOutcome> {
  const fs = nativeFilesystem();
  // 清前测量只走原生目录：不使用 CacheStorage，避免它的不确定性拖延/阻断真正的清理
  const bytes = fs
    ? sum(await nativeDirBytes(fs, DATA_DIR), await nativeDirBytes(fs, CACHE_DIR))
    : webLocalBytes();

  let ran = false;

  if (fs) {
    const d = await nativeClearDir(fs, DATA_DIR);
    const c = await nativeClearDir(fs, CACHE_DIR);
    if (d !== null || c !== null) ran = true;
  }

  // 网页层本地存储：localStorage + IndexedDB（项目当前未用 IDB，防御性清理）
  try {
    (globalThis as unknown as { localStorage?: Storage }).localStorage?.clear();
    ran = true;
  } catch {
    /* 隐私模式下不可用：跳过 */
  }
  try {
    const idb = (
      globalThis as unknown as {
        indexedDB?: IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> };
      }
    ).indexedDB;
    if (idb?.databases) {
      const dbs = (await withTimeout(idb.databases())) ?? [];
      for (const db of dbs) if (db.name) idb.deleteDatabase(db.name);
      ran = true;
    }
  } catch {
    /* 不支持 databases() 的环境跳过 */
  }
  if (cacheStorage()) {
    await webClearCache();
    ran = true;
  }

  return { ran, bytes };
}

// ───────────────────────── 默认工作空间路径 ─────────────────────────

/** 读取已保存的自定义工作空间路径（localStorage 不可用 / 未设置时返回 null）。 */
export function getWorkspacePath(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_PATH_KEY);
  } catch {
    return null;
  }
}

/** 保存自定义工作空间路径；传 null / 空串表示清除、回到默认。 */
export function setWorkspacePath(path: string | null): void {
  try {
    if (path === null || path === '') {
      localStorage.removeItem(WORKSPACE_PATH_KEY);
    } else {
      localStorage.setItem(WORKSPACE_PATH_KEY, path);
    }
  } catch {
    /* 隐私模式下 localStorage 不可用：静默降级（设置「改完即生效」，不抛错） */
  }
}

/**
 * 计算「默认工作空间」的展示路径（用户未自定义时显示在设置行里）：
 *  - 有已保存自定义值 → 直接返回它；
 *  - 原生壳：设备主目录（Capacitor Filesystem EXTERNAL_ROOT 绝对路径）+ /AgentHarness；
 *  - 纯 Web 且无法推断主目录 → 返回 null（UI 显示占位符，不编造路径）。
 */
export async function resolveDefaultWorkspacePath(): Promise<string | null> {
  const custom = getWorkspacePath();
  if (custom) return custom;
  const home = await inferHomeDir();
  if (!home) return null;
  return joinPath(home, WORKSPACE_DIR_NAME);
}
