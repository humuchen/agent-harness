import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_LANGS,
  getLangLabel,
  highlightToHtml,
  normalizeLang
} from './highlight';

/** 语言别名归一：模型与用户写错的那些形式必须能落到已注册语言上。 */
describe('normalizeLang · 别名归一', () => {
  it('常见缩写归一到规范名', () => {
    expect(normalizeLang('js')).toBe('javascript');
    expect(normalizeLang('ts')).toBe('typescript');
    expect(normalizeLang('tsx')).toBe('typescript');
    expect(normalizeLang('py')).toBe('python');
    expect(normalizeLang('sh')).toBe('bash');
    expect(normalizeLang('yml')).toBe('yaml');
    expect(normalizeLang('html')).toBe('xml');
    expect(normalizeLang('docker')).toBe('dockerfile');
  });

  it('大小写与前后空白不影响判定', () => {
    expect(normalizeLang('  TS  ')).toBe('typescript');
    expect(normalizeLang('JSON')).toBe('json');
  });

  it('剥掉 marked 可能带上的 language- 前缀', () => {
    expect(normalizeLang('language-ts')).toBe('typescript');
  });

  it('未注册语言返回空串（表示不着色，而非猜一个）', () => {
    expect(normalizeLang('foobar')).toBe('');
    expect(normalizeLang('brainfuck')).toBe('');
  });

  it('未标注（空 / undefined）返回空串', () => {
    expect(normalizeLang('')).toBe('');
    expect(normalizeLang('   ')).toBe('');
    expect(normalizeLang(undefined)).toBe('');
    expect(normalizeLang(null)).toBe('');
  });
});

/** 标签文案：展示用户实际书写的形式，未标注时不渲染标签。 */
describe('getLangLabel', () => {
  it('保留书写形式而非规范名（ts 显示为 ts）', () => {
    expect(getLangLabel('ts')).toBe('ts');
    expect(getLangLabel('TS')).toBe('ts');
  });

  it('未标注返回空串', () => {
    expect(getLangLabel('')).toBe('');
    expect(getLangLabel(undefined)).toBe('');
  });

  it('超长标签被截断，避免挤掉工具条按钮', () => {
    expect(getLangLabel('x'.repeat(40)).length).toBe(16);
  });

  it('未注册语言仍给出标签（容器需要显示它是什么语言）', () => {
    expect(getLangLabel('foobar')).toBe('foobar');
  });
});

/** 高亮产物必须是 hljs 的 class 标记，且内容保持转义。 */
describe('highlightToHtml', () => {
  it('已注册语言产出 token span（关键字/字符串）', () => {
    const out = highlightToHtml("const a = 'hi';", 'ts');
    expect(out).not.toBeNull();
    expect(out).toContain('hljs-keyword');
    expect(out).toContain('hljs-string');
  });

  it('未注册语言返回 null（由调用方保持纯文本）', () => {
    expect(highlightToHtml('whatever', 'foobar')).toBeNull();
  });

  it('未标注语言返回 null', () => {
    expect(highlightToHtml('whatever', '')).toBeNull();
  });

  it('代码中的 HTML 被转义，不产生可执行标签', () => {
    const out = highlightToHtml('<script>alert(1)</script>', 'javascript');
    expect(out).not.toBeNull();
    expect(out).not.toContain('<script>');
  });

  it('不完整代码（流式半截）不抛错', () => {
    expect(() => highlightToHtml('const a = ', 'typescript')).not.toThrow();
    expect(() => highlightToHtml('{"a": ', 'json')).not.toThrow();
    expect(() => highlightToHtml('def f(:\n  pass', 'python')).not.toThrow();
  });

  it('空代码返回可用的空产物而非 null', () => {
    const out = highlightToHtml('', 'ts');
    expect(out).not.toBeNull();
  });

  it('产物不含内联样式（配色必须可被 CSS 变量接管）', () => {
    expect(highlightToHtml("const a = 1; // x", 'ts')).not.toContain('style=');
  });
});

describe('SUPPORTED_LANGS', () => {
  it('白名单非空且覆盖高频语言', () => {
    expect(SUPPORTED_LANGS.length).toBeGreaterThanOrEqual(12);
    for (const l of ['javascript', 'typescript', 'json', 'bash', 'python', 'sql']) {
      expect(SUPPORTED_LANGS).toContain(l);
    }
  });
});
