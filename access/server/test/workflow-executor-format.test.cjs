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
  // 无上游时不出现「上游」段。
  assert.ok(!out.includes('上游'), out);
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
