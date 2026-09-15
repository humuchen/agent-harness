import { describe, it, expect } from 'vitest';
import {
  effectiveBlockFolded,
  foldButtonLabel,
  foldKey,
  toggledBlockFolded
} from './chat-block-fold';

describe('foldKey', () => {
  it('由作用域与块标识拼成', () => {
    expect(foldKey('ans-12', 'code:0')).toBe('ans-12/code:0');
  });

  it('同一序号在不同作用域下是不同键（回答区与思考区互不干扰）', () => {
    expect(foldKey('ans-12', 'code:0')).not.toBe(foldKey('thk-12', 'code:0'));
  });
});

describe('effectiveBlockFolded · 缺省语义', () => {
  it('可折叠且无用户表态时默认折叠', () => {
    expect(effectiveBlockFolded({}, 'ans-1', 'code:0', true)).toBe(true);
  });

  it('用户显式展开后不再折叠（覆盖缺省）', () => {
    const folds = { 'ans-1/code:0': false };
    expect(effectiveBlockFolded(folds, 'ans-1', 'code:0', true)).toBe(false);
  });

  it('用户显式折叠与缺省一致时仍为折叠', () => {
    expect(effectiveBlockFolded({ 'ans-1/code:0': true }, 'ans-1', 'code:0', true)).toBe(true);
  });

  it('不可折叠的块恒为展开，即便覆盖表里写着折叠', () => {
    // 兜底用例：任何调用方漏判 foldable 都不能把短代码块裁掉。
    expect(effectiveBlockFolded({ 'ans-1/code:0': true }, 'ans-1', 'code:0', false)).toBe(false);
  });

  it('作用域隔离：另一条消息的展开态不影响本条', () => {
    const folds = { 'ans-2/code:0': false };
    expect(effectiveBlockFolded(folds, 'ans-1', 'code:0', true)).toBe(true);
  });

  it('序号隔离：同一消息内展开第 1 块不影响第 2 块', () => {
    const folds = { 'ans-1/code:0': false };
    expect(effectiveBlockFolded(folds, 'ans-1', 'code:1', true)).toBe(true);
  });
});

describe('toggledBlockFolded', () => {
  it('折叠态取反', () => {
    expect(toggledBlockFolded(true)).toBe(false);
    expect(toggledBlockFolded(false)).toBe(true);
  });

  it('连续取反回到原态（点击展开再折叠）', () => {
    expect(toggledBlockFolded(toggledBlockFolded(true))).toBe(true);
  });
});

describe('foldButtonLabel', () => {
  it('按当前态给出「相反动作」的文案', () => {
    expect(foldButtonLabel(true)).toBe('展开全部');
    expect(foldButtonLabel(false)).toBe('收起');
  });
});
