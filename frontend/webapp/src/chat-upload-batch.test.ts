/**
 * 批量上传（拖拽多图）的行为验证。
 *
 * 背景：反馈「一次拖多张图，最后只上传成功一个」。
 * handleFiles 是「点击选择」与「拖拽」两条入口的唯一汇聚点，
 * 因此这里直接驱动它：给定 N 个文件，断言最终落地的附件数就是 N。
 *
 * 说明：本仓 webapp 的 vitest 环境是 node（无 DOM），无法挂载 Lit 组件，
 * 故构造一个最小上下文、并从 AhChat.prototype 上取用被测方法后直接 call ——
 * 只依赖方法自身的逻辑，不触碰渲染。
 *
 * 注意：上下文刻意用**普通对象**而非 Object.create(AhChat.prototype)。
 * @state() 会在原型上装访问器，直接读写会触发 Lit 的 requestUpdate 内部状态，
 * 在裸对象上会抛错；这里只需要 attachments / uploadingFiles 两个字段，
 * 原型方法按引用取用即可。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  AhChat,
  UPLOAD_CONCURRENCY,
  runWithConcurrency
} from './chat';

// ---------- 依赖桩 ----------
// 上传请求的返回值由每个用例通过 uploadImpl 自行决定。
let uploadImpl: (file: File) => Promise<unknown> = async () => ({
  ok: true,
  json: async () => ({ ok: true, meta: { url: '/api/uploads/stub.png' } })
});

vi.mock('./api', () => ({
  client: {},
  getUsername: () => 'tester',
  authedFetch: vi.fn(async (_url: string, init: { body: FormData }) => {
    const file = init.body.get('file') as File;
    return uploadImpl(file);
  })
}));
vi.mock('./components/ah-notification', () => ({
  notify: { warning: vi.fn(), info: vi.fn(), success: vi.fn() }
}));
vi.mock('./utils/errors', () => ({ notifyError: vi.fn() }));

// FileReader 在 node 环境不存在，用最小实现替代：
// 名字以 BAD_ 开头的文件走 onerror，用于验证「单文件读失败不拖垮整批」。
const RealFileReader = (globalThis as Record<string, unknown>).FileReader;
class StubFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: unknown = null;
  private name = '';
  readAsDataURL(blob: unknown): void {
    this.name = (blob as File)?.name ?? '';
    setTimeout(() => {
      if (this.name.startsWith('BAD_')) {
        this.result = null;
        this.onerror?.();
      } else {
        this.result = 'data:image/png;base64,STUB';
        this.onload?.();
      }
    }, 0);
  }
}

function makeFile(name: string, type = 'image/png', bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const proto = AhChat.prototype as unknown as Record<string, Function>;

/** 构造一个只含 handleFiles 链路所需字段的最小上下文。 */
function makeCtx(seed: unknown[] = []) {
  return {
    attachments: seed as unknown[],
    uploadingFiles: new Map<string, unknown>(),
    // handleFiles 内部会调用这两个，按引用取用原型实现
    uploadOne: proto.uploadOne,
    patchAttachment: proto.patchAttachment
  };
}
type Ctx = ReturnType<typeof makeCtx>;

async function runHandleFiles(ctx: Ctx, files: File[]): Promise<void> {
  const fn = proto.handleFiles as (f: File[]) => Promise<void>;
  await fn.call(ctx, files);
}

function namesOf(ctx: Ctx): string[] {
  return (ctx.attachments as { name: string }[]).map((a) => a.name);
}
function statusesOf(ctx: Ctx): string[] {
  return (ctx.attachments as { uploadStatus: string }[]).map(
    (a) => a.uploadStatus
  );
}

describe('批量上传（拖拽多图）', () => {
  beforeAll(() => {
    (globalThis as Record<string, unknown>).FileReader = StubFileReader;
  });
  afterAll(() => {
    if (RealFileReader) {
      (globalThis as Record<string, unknown>).FileReader = RealFileReader;
    }
  });
  beforeEach(() => {
    // 必须清空：否则 authedFetch 的调用记录会跨用例累计（首版即栽在这里，
    // 断言 3 次却拿到前几个用例累计的 24 次）。
    vi.clearAllMocks();
    uploadImpl = async () => ({
      ok: true,
      json: async () => ({ ok: true, meta: { url: '/api/uploads/stub.png' } })
    });
  });

  it('拖入 1 个文件 → 落地 1 个', async () => {
    const ctx = makeCtx();
    await runHandleFiles(ctx, [makeFile('a.png')]);
    expect(ctx.attachments).toHaveLength(1);
  });

  it('拖入 3 个文件 → 落地 3 个（核心回归点）', async () => {
    const ctx = makeCtx();
    await runHandleFiles(ctx, [
      makeFile('a.png'),
      makeFile('b.png'),
      makeFile('c.png')
    ]);
    expect(ctx.attachments).toHaveLength(3);
    expect(namesOf(ctx)).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('拖入 15 个文件 → 落地 15 个（达到上限）', async () => {
    const ctx = makeCtx();
    const files = Array.from({ length: 15 }, (_, i) => makeFile(`f${i}.png`));
    await runHandleFiles(ctx, files);
    expect(ctx.attachments).toHaveLength(15);
  });

  it('已有附件时新拖入的文件是追加而非覆盖', async () => {
    const ctx = makeCtx([{ name: 'old.png', uploadStatus: 'done' }]);
    await runHandleFiles(ctx, [makeFile('a.png'), makeFile('b.png')]);
    expect(ctx.attachments).toHaveLength(3);
    expect(namesOf(ctx)[0]).toBe('old.png');
  });

  it('每个文件都被独立上传一次（不是只传第一个）', async () => {
    const ctx = makeCtx();
    await runHandleFiles(ctx, [
      makeFile('a.png'),
      makeFile('b.png'),
      makeFile('c.png')
    ]);
    const { authedFetch } = await import('./api');
    const calls = (authedFetch as unknown as { mock: { calls: unknown[] } }).mock
      .calls;
    expect(calls).toHaveLength(3);
  });

  it('全部上传完成后状态都是 done，没有卡在 uploading', async () => {
    const ctx = makeCtx();
    await runHandleFiles(ctx, [makeFile('a.png'), makeFile('b.png')]);
    expect(statusesOf(ctx)).toEqual(['done', 'done']);
  });

  it('文件名相同也能各自落地（key 冲突不应丢附件）', async () => {
    const ctx = makeCtx();
    await runHandleFiles(ctx, [
      makeFile('same.png'),
      makeFile('same.png'),
      makeFile('same.png')
    ]);
    expect(ctx.attachments).toHaveLength(3);
  });

  it('整批在上传开始前就一次性入列（不是读一个加一个）', async () => {
    // 每个上传请求发起时记录当时的附件数：若为「读一个加一个」，
    // 第一次记录会是 1、2、3 递增；整批入列则应恒为 3。
    const seen: number[] = [];
    const ctx = makeCtx();
    uploadImpl = async () => {
      seen.push(ctx.attachments.length);
      return {
        ok: true,
        json: async () => ({ ok: true, meta: { url: '/api/uploads/x.png' } })
      };
    };
    await runHandleFiles(ctx, [
      makeFile('a.png'),
      makeFile('b.png'),
      makeFile('c.png')
    ]);
    expect(seen).toEqual([3, 3, 3]);
  });

  it('单个文件读取失败，不影响同批其它文件', async () => {
    // 这是「只上传成功一个」的成因之一：读失败的 reject 若未被捕获，
    // 会让整个 handleFiles 抛出，后面尚未处理的文件全部丢失。
    const ctx = makeCtx();
    await runHandleFiles(ctx, [
      makeFile('a.png'),
      makeFile('BAD_b.png'),
      makeFile('c.png')
    ]);
    expect(namesOf(ctx)).toEqual(['a.png', 'c.png']);
    expect(statusesOf(ctx)).toEqual(['done', 'done']);
  });

  it('单个文件上传失败，只标记它自己为 error', async () => {
    const ctx = makeCtx();
    uploadImpl = async (file: File) => {
      if (file.name === 'b.png') throw new Error('服务端 500');
      return {
        ok: true,
        json: async () => ({ ok: true, meta: { url: '/api/uploads/x.png' } })
      };
    };
    await runHandleFiles(ctx, [
      makeFile('a.png'),
      makeFile('b.png'),
      makeFile('c.png')
    ]);
    expect(ctx.attachments).toHaveLength(3);
    expect(statusesOf(ctx)).toEqual(['done', 'error', 'done']);
  });

  it('并发上传：同时在飞的请求数不超过 UPLOAD_CONCURRENCY', async () => {
    let inFlight = 0;
    let peak = 0;
    const ctx = makeCtx();
    uploadImpl = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {
        ok: true,
        json: async () => ({ ok: true, meta: { url: '/api/uploads/x.png' } })
      };
    };
    const files = Array.from({ length: 10 }, (_, i) => makeFile(`f${i}.png`));
    await runHandleFiles(ctx, files);
    expect(peak).toBeGreaterThan(1); // 确实并发了（不是串行）
    expect(peak).toBeLessThanOrEqual(UPLOAD_CONCURRENCY); // 且未失控
  });

  it('串行也不会丢文件：10 个全都能落地并被上传', async () => {
    const ctx = makeCtx();
    const files = Array.from({ length: 10 }, (_, i) => makeFile(`f${i}.png`));
    await runHandleFiles(ctx, files);
    const { authedFetch } = await import('./api');
    expect(ctx.attachments).toHaveLength(10);
    expect(
      (authedFetch as unknown as { mock: { calls: unknown[] } }).mock.calls
    ).toHaveLength(10);
    expect(statusesOf(ctx).every((s) => s === 'done')).toBe(true);
  });
});

describe('runWithConcurrency（并发调度器）', () => {
  it('任务数为 0 时直接返回', async () => {
    await expect(runWithConcurrency([])).resolves.toBeUndefined();
  });

  it('并发度被裁剪到任务数，不会空转', async () => {
    const done: number[] = [];
    await runWithConcurrency(
      [0, 1].map((i) => async () => {
        done.push(i);
      }),
      8
    );
    expect(done.sort()).toEqual([0, 1]);
  });

  it('全部任务都会被执行一次，且执行完才 resolve', async () => {
    let count = 0;
    await runWithConcurrency(
      Array.from({ length: 9 }, () => async () => {
        await new Promise((r) => setTimeout(r, 2));
        count += 1;
      }),
      3
    );
    expect(count).toBe(9);
  });

  it('并发度上限被严格遵守', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency(
      Array.from({ length: 12 }, () => async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 4));
        inFlight -= 1;
      }),
      3
    );
    expect(peak).toBe(3);
  });
});
