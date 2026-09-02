// 提示词回归测试：保护「转人工/预约失败兜底」强约束不被未来改动无声删掉。
// 这条规则修复了真实 bug：用户在 booking 失败时被 agent 口头承诺转人工，
// 但 agent 没调 lead_handoff → 转人工队列为空、人坐席看不到客资。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../dist/prompts');

const prompt = buildSystemPrompt();

test('提示词要求 consultation_book 失败时必须调 lead_handoff', () => {
  // 强约束：booking 失败必须 lead_handoff
  assert.match(prompt, /consultation_book[^\n]*ok:\s*false/, '应明确以 ok:false 判定 booking 失败');
  assert.match(prompt, /lead_handoff/, '提示词应包含 lead_handoff 工具名');
  assert.match(
    prompt,
    /booking-failed:\s*<code>/,
    '应要求把 error code 透传到 lead_handoff 的 reason 字段（便于咨询师排查）',
  );
});

test('提示词禁止只用自然语言承诺转人工', () => {
  assert.match(
    prompt,
    /不允许只用自然语言承诺/,
    '禁止口头承诺——防止转人工队列为空的根因复现',
  );
  assert.match(
    prompt,
    /咨询师|客服/,
    '应引导到 lead_handoff（咨询师/客服），而非空头承诺',
  );
});

test('提示词禁止编造未配置的跟进方式（短信/电话/微信回访幻觉）', () => {
  assert.match(
    prompt,
    /不要凭空承诺|不要编造未配置/,
    '应禁止 agent 凭空承诺「短信/电话/微信回访」等可能未配置的方式',
  );
});

test('提示词仍保留原有铁律（qualify 听到即回填、leadId 稳定、留资需授权、未确认不预约）', () => {
  assert.match(prompt, /听到即回填/, '铁律一：听到即回填');
  assert.match(prompt, /consent=true/, '铁律二：留资需 consent');
  assert.match(prompt, /clinic.*date.*time|院区.*日期.*时段/, '铁律三：未确认不预约');
  assert.match(prompt, /leadId/, '铁律四：leadId 稳定标识');
});

test('提示词要求 lead_handoff 前先 lead_qualify 落库（leadId 来源）', () => {
  // 保证「先把画像落库、再转人工」，让咨询师在队列里能看到完整画像
  assert.match(
    prompt,
    /lead_qualify[\s\S]{0,200}lead_handoff/,
    'lead_handoff 前应先 lead_qualify（同 leadId）',
  );
});

test('提示词覆盖原 D 级/投诉/明确要求人工的场景（保留旧行为）', () => {
  assert.match(prompt, /D 级/, 'D 级触发 lead_handoff');
  assert.match(prompt, /投诉/, '投诉触发 lead_handoff');
});