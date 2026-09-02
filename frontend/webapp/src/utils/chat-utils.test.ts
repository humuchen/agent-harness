import { describe, it, expect } from 'vitest';
import {
  isRetrievalTool,
  safeJson,
  parseDeepThinking,
  formatToolJson
} from './chat-utils';

describe('isRetrievalTool', () => {
  it('命中检索类工具名', () => {
    expect(isRetrievalTool('web_search')).toBe(true);
    expect(isRetrievalTool('RAG.query')).toBe(true);
    expect(isRetrievalTool('fetch_url')).toBe(true);
  });
  it('非检索类返回 false', () => {
    expect(isRetrievalTool('calculator')).toBe(false);
    expect(isRetrievalTool('')).toBe(false);
  });
});

describe('safeJson', () => {
  it('null/undefined 返回空串', () => {
    expect(safeJson(null)).toBe('');
    expect(safeJson(undefined)).toBe('');
  });
  it('字符串超长截断', () => {
    const long = 'x'.repeat(900);
    expect(safeJson(long).endsWith('…')).toBe(true);
  });
  it('对象正常序列化', () => {
    expect(safeJson({ a: 1 })).toContain('"a": 1');
  });
  it('不可序列化值回退 String', () => {
    const circ: any = {};
    circ.self = circ;
    expect(safeJson(circ)).toContain('[object Object]');
  });
});

describe('parseDeepThinking', () => {
  it('空输入返回空', () => {
    expect(parseDeepThinking('')).toEqual({ text: '', vars: [] });
  });
  it('抽取 key: value 关键变量（非编号步骤）', () => {
    const r = parseDeepThinking('决定: 使用检索\n1. 先查文档\n2. 再总结');
    expect(r.vars).toEqual([['决定', '使用检索']]);
    expect(r.text).toContain('1. 先查文档');
  });
  it('编号步骤不被误判为变量', () => {
    const r = parseDeepThinking('1. step: do');
    expect(r.vars.length).toBe(0);
  });
  it('空行被剔除、连续空白压平为单行（保留段落间单换行）', () => {
    const r = parseDeepThinking('a\n\n\n\nb');
    expect(r.text).toBe('a\nb');
  });
});

describe('formatToolJson', () => {
  it('合法 JSON 美化并转义', () => {
    const out = formatToolJson('{"a":1}');
    expect(out).toContain('&quot;a&quot;');
    expect(out).toContain(' ');
  });
  it('先解码已有 HTML 实体再转义，避免双重转义', () => {
    const out = formatToolJson('&lt;b&gt;');
    expect(out).toBe('&lt;b&gt;');
  });
  it('空输入返回空串', () => {
    expect(formatToolJson('')).toBe('');
  });
  it('非 JSON 原样转义（脚本注入无害化）', () => {
    const out = formatToolJson('<script>alert(1)</script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('美化后的 JSON 保留缩进结构', () => {
    const out = formatToolJson('{"a":1,"b":[1,2]}');
    expect(out).toContain('\n  ');
  });
});
