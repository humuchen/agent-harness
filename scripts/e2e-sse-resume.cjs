/* 端到端验证：SSE seq 附加 + jobId/since 断线续传 + 心跳注释帧不干扰解析。
 * 场景：
 *  A. 正常 run：收集全部事件，校验每个事件带单调递增 seq；
 *  B. 续传：用 jobId + since=<已收最大seq的一半> 重订阅，校验重放事件全部 seq > since，
 *     且包含终结事件 _done / run:end（模拟断点恢复）；
 *  C. 未知 jobId：应回退为新提交（返回 job:accepted 且 jobId 不同）或 4xx —— 不崩溃。
 */
const BASE = 'http://127.0.0.1:4199';
const TOKEN = 'test123';

async function streamRun(body, onEvent) {
  const res = await fetch(`${BASE}/api/v1/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data.trim()) continue;
      try { const ev = JSON.parse(data); events.push(ev); onEvent?.(ev); } catch {}
    }
  }
  return events;
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name} ${detail}`); }
}

(async () => {
  // A. 正常 run
  const evA = await streamRun({ mode: 'mock', prompt: '测试断线续传', sessionId: 'e2e-resume' });
  check('A1 mock run 收到事件流', evA.length > 0, `n=${evA.length}`);
  const seqs = evA.map((e) => e.seq).filter((s) => typeof s === 'number');
  // job:accepted 由 handleRun 直发（不经 emit），无 seq 属预期 —— 续传游标只关心内容事件。
  const nonAccepted = evA.filter((e) => e.type !== 'job:accepted');
  check('A2 除 job:accepted 外所有事件携带 seq',
    seqs.length === nonAccepted.length,
    `${seqs.length}/${nonAccepted.length}`);
  let mono = true;
  for (let k = 1; k < seqs.length; k++) if (seqs[k] !== seqs[k - 1] + 1) mono = false;
  check('A3 seq 单调递增连续', mono, JSON.stringify(seqs.slice(0, 8)));
  const jobAccepted = evA.find((e) => e.type === 'job:accepted');
  check('A4 收到 job:accepted(jobId)', !!jobAccepted?.jobId);
  const hasDone = evA.some((e) => e.type === '_done');
  check('A5 流以 _done 终结', hasDone);

  // B. 断线续传：since=中位数游标，服务端只重放后半段
  const jobId = jobAccepted.jobId;
  const since = seqs[Math.floor(seqs.length / 2)];
  const evB = await streamRun({ mode: 'mock', prompt: 'x', sessionId: 'e2e-resume', jobId, since });
  const bSeqs = evB.map((e) => e.seq).filter((s) => typeof s === 'number');
  check('B1 重放事件全部 seq > since', bSeqs.every((s) => s > since), `since=${since} min=${Math.min(...bSeqs)}`);
  check('B2 重放补齐到流末尾(_done)', evB.some((e) => e.type === '_done'));
  check('B3 重放不含 since 之前的旧事件', !bSeqs.some((s) => s <= since));

  // B4. 完整重连（since 缺省）：重放全部事件
  const evB4 = await streamRun({ mode: 'mock', prompt: 'x', sessionId: 'e2e-resume', jobId });
  check('B4 不带 since 时全量重放', evB4.length >= evA.length - 1, `len=${evB4.length} vs ${evA.length}`);

  // C. 未知 jobId → 回退为新提交（job:accepted 新 id）
  const evC = await streamRun({ mode: 'mock', prompt: '未知job回退', sessionId: 'e2e-resume', jobId: 'no-such-job' });
  const cAccepted = evC.find((e) => e.type === 'job:accepted');
  check('C1 未知 jobId 回退为新提交', !!cAccepted && cAccepted.jobId !== 'no-such-job');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR:', e.message); process.exit(2); });
