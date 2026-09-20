// 零依赖测试（node:test + node:assert）：覆盖 P2 plan 来源的 step input → prompt 装配
// （workflow-executor.formatStepInput，见 docs/design/plan-mode-multiagent.md §5）。
// - plan 来源（buildInputMapping 产出的 { goal, taskMeta, upstream_* }）→ 可读 prompt
//   （【计划任务】头 + 步骤 + 预期产出 + 目标 + 上游真实产出）
// - string 输入 → 原样（保持 /api/workflows 现有行为，零回归）
// - 其它对象 → JSON.stringify（保持现有回退，零回归）
// - compensate=true → 「（回滚补偿）」前缀保留
// - taskMeta 解析失败 → 不阻断，仅少打 task 头
const test = require('node:test');
const assert = require('node:assert');

const { formatStepInput } = require('../dist/workflow-executor.js');

// 与 planToWorkflowDef.buildInputMapping 产出对齐的 sample（经 DagEngine.resolveInput 后
// step input 即为 { goal, taskMeta, upstream_<dep>* } 形状）。
function planStepInput(task, upstreamOutputs) {
  const meta = { id: task.id, title: task.title, steps: task.steps, expectedOutput: task.expectedOutput };
  const obj = {
    goal: '上线一个新功能',
    taskMeta: JSON.stringify(meta)
  };
  for (const [dep, out] of Object.entries(upstreamOutputs ?? {})) {
    obj[`upstream_${dep}`] = out;
  }
  return obj;
}

test('plan 来源（无上游）：装配出 task 头 + 步骤 + 预期产出 + 目标', () => {
  const p = planStepInput({ id: 't1', title: '写核心逻辑', steps: ['实现 A', '实现 B'], expectedOutput: '可编译的核心模块' });
  const out = formatStepInput(p);
  assert.ok(out.includes('【计划任务 t1】写核心逻辑'), out);
  assert.ok(out.includes('1. 实现 A') && out.includes('2. 实现 B'), out);
  assert.ok(out.includes('预期产出：可编译的核心模块'), out);
  assert.ok(out.includes('目标：上线一个新功能'), out);
  // 无上游时不出现「上游产出」段（执行要求里的「禁止索要上游」提示语除外，
  // 该行按 <dep> 具名段落判定，不含具体任务 id 即视为无上游注入）。
  assert.ok(!/上游 \S+ 产出/.test(out), out);
});

/* ---------- 产出自包含铁律：禁止向用户索要上游产出 ---------- */

test('执行要求：产出自包含硬性要求注入 prompt（堵死「请把产出贴过来」出口）', () => {
  const out = formatStepInput(
    planStepInput({ id: 't5', title: '整合', steps: ['汇总'], expectedOutput: '终稿' })
  );
  assert.ok(out.includes('执行要求（硬性）'), out);
  assert.ok(out.includes('完整写入你的回复正文'), out);
  assert.ok(out.includes('禁止要求用户粘贴'), out);
});

test('plan 来源（有上游）：upstream_* 注入真实产出（原样字符串 / 对象序列化）', () => {
  const p = planStepInput(
    { id: 't2', title: '写测试', steps: ['单测'], expectedOutput: '全绿测试' },
    { t1: 'output-of-t1', t2b: { key: 'val' } }
  );
  const out = formatStepInput(p);
  assert.ok(out.includes('上游 t1 产出：output-of-t1'), out);
  // 非字符串上游产出按 JSON 序列化（黑板里存的是真实对象时）。
  assert.ok(out.includes('上游 t2b 产出：{"key":"val"}'), out);
});

test('string 输入：原样透传（/api/workflows 现有行为零回归）', () => {
  assert.strictEqual(formatStepInput('hello'), 'hello');
});

test('普通对象（无 goal/taskMeta）：JSON.stringify 回退（零回归）', () => {
  const out = formatStepInput({ a: 1, b: [2, 3] });
  assert.ok(out.includes('"a"') && out.includes('"b"'), out);
});

test('compensate=true：回滚前缀保留（string / plan 来源 / 对象）', () => {
  assert.strictEqual(formatStepInput('do rollback', true), '（回滚补偿）do rollback');
  const p = planStepInput({ id: 't1', title: 'X', steps: [], expectedOutput: '' });
  assert.ok(formatStepInput(p, true).startsWith('（回滚补偿）'), 'plan 来源补偿前缀');
  assert.ok(formatStepInput({ a: 1 }, true).startsWith('（回滚补偿）'), '对象补偿前缀');
});

test('taskMeta 解析失败：不阻断，缺 task 头但仍打目标/上游', () => {
  const p = { goal: 'g', taskMeta: '{not-json', upstream_t1: 'real-out' };
  const out = formatStepInput(p);
  // task 头因 meta 解析失败而被跳过，但目标与上游仍注入。
  assert.ok(!out.includes('【计划任务'), out);
  assert.ok(out.includes('目标：g'), out);
  assert.ok(out.includes('上游 t1 产出：real-out'), out);
});

/* ---------- P4.5 上游注记（无效产出不静默喂垃圾） ---------- */

test('上游注记：空产出 → 显式标注 + 降级指引（不静默喂空）', () => {
  const p = planStepInput(
    { id: 't2', title: '写测试', steps: ['单测'], expectedOutput: '全绿测试' },
    { t1: '' }
  );
  const out = formatStepInput(p);
  assert.ok(out.includes('上游 t1 产出：（空）'), out);
  assert.ok(out.includes('不得以道歉或放弃收尾'), out);
});

test('上游注记：null/undefined 产出 → 同空标注', () => {
  const p = planStepInput(
    { id: 't2', title: '写测试', steps: ['单测'], expectedOutput: '全绿测试' },
    { t1: null }
  );
  const out = formatStepInput(p);
  assert.ok(out.includes('上游 t1 产出：（空）'), out);
});

test('上游注记：截断产出（含生成中断标记）→ 标注不完整 + 自行补齐', () => {
  const partial = '半份产出…\n\n⚠️ 生成已中断：与模型的连接空闲超时';
  const p = planStepInput(
    { id: 't2', title: '写测试', steps: ['单测'], expectedOutput: '全绿测试' },
    { t1: partial }
  );
  const out = formatStepInput(p);
  assert.ok(out.includes('该产出在中途截断，仅作参考'), out);
  assert.ok(out.includes('自行补齐'), out);
});

test('上游注记：护栏兜底产出 → 标注被拦截 + 独立执行', () => {
  const fallback = '抱歉，我暂时无法提供该内容的回复。如有进一步需求，建议您通过官方正规渠道咨询。';
  const p = planStepInput(
    { id: 't2', title: '写测试', steps: ['单测'], expectedOutput: '全绿测试' },
    { t1: fallback }
  );
  const out = formatStepInput(p);
  assert.ok(out.includes('（被安全护栏拦截，无实质内容）'), out);
});

test('上游注记：干净产出保持原样（零回归钉死）', () => {
  const p = planStepInput(
    { id: 't2', title: '写测试', steps: ['单测'], expectedOutput: '全绿测试' },
    { t1: 'output-of-t1', t9: '正常长文产出，无任何标记' }
  );
  const out = formatStepInput(p);
  assert.ok(out.includes('上游 t1 产出：output-of-t1'), out);
  assert.ok(out.includes('上游 t9 产出：正常长文产出，无任何标记'), out);
  // 无注记文案泄漏。
  assert.ok(!out.includes('（空）'), out);
  assert.ok(!out.includes('截断'), out);
});

/* ---------- P4.6 验收知情：outputChecks 注入执行 prompt ---------- */

test('验收要求：taskMeta.outputChecks 注入 prompt（执行模型不再对门禁盲写）', () => {
  const meta = {
    id: 't1',
    title: '补充检索',
    steps: ['检索'],
    expectedOutput: '市场规模数据',
    outputChecks: ['市场规模', '监管合规']
  };
  const out = formatStepInput({
    goal: 'g',
    taskMeta: JSON.stringify(meta)
  });
  assert.ok(out.includes('验收要求'), out);
  assert.ok(out.includes('市场规模、监管合规'), out);
  assert.ok(out.includes('数据缺口'), out, '检索失败时也须在缺口说明中写出关键词');
});

test('验收要求：无 outputChecks 的 taskMeta 不注入该行（零回归）', () => {
  const out = formatStepInput(
    planStepInput({ id: 't1', title: 'X', steps: [], expectedOutput: 'Y' })
  );
  assert.ok(!out.includes('验收要求'), out);
});

test('P4.7 验收要求：注入词表与断言词表同源同上限（超过上限的词不得只断言不告知）', () => {
  const { pickOutputChecks, PLAN_OUTPUT_CHECK_MAX } = require('@agent-harness/core');
  const meta = {
    id: 't1',
    title: 'X',
    steps: [],
    expectedOutput: 'Y',
    // planner 越界给了 6 个（契约 2~4）——第 5/6 个此前只被门禁断言、从不告知模型 → 必然失败。
    outputChecks: ['市场规模', '竞争格局', '技术趋势', '商业模式', '监管合规', '风险提示']
  };
  const out = formatStepInput({ goal: 'g', taskMeta: JSON.stringify(meta) });
  const effective = pickOutputChecks(meta.outputChecks);
  assert.strictEqual(PLAN_OUTPUT_CHECK_MAX, 4);
  assert.deepStrictEqual(effective, ['市场规模', '竞争格局', '技术趋势', '商业模式']);
  // 注入 prompt 的词表 = 生效词表（逐词出现）。
  for (const c of effective) assert.ok(out.includes(c), `应告知「${c}」`);
  // 超限词既不断言也不告知（保持两侧一致，消除「注定失败」的硬性要求）。
  for (const c of ['监管合规', '风险提示']) assert.ok(!out.includes(c), `超限词「${c}」不应出现`);
});
