/**
 * splitter.ts — 结构感知切分（P6-B 方案二一期，对齐 LangChain text splitters 的最小子集）。
 *
 * 设计要点：
 * - markdown 按标题层级（# ~ ######）切 section，每片携带 `headingPath`（如
 *   ['部署指南', '安装']）——进 Chunk.metadata 后检索命中可回溯结构位置。
 * - 超长 section 递归降级：段落（\n\n）→ 单换行 → 句子（。！？.!?）硬切，**永不跨标题断义**。
 * - 纯文本走段落/句子递归（headingPath 为空数组）。
 * - 确定性：同输入恒同输出（无随机），满足 golden 回归纪律。
 */

export interface SplitPiece {
  content: string;
  index: number;
  /** 所属标题路径（如 ['部署指南', '安装']；纯文本为 []）。 */
  headingPath: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** 句子边界切分（中英混合：。！？!? 与省略号；回退按字符硬切）。 */
function splitSentences(text: string, maxLen: number): string[] {
  const parts = text
    .split(/(?<=[。！？!?；;])\s*|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > maxLen && buf) {
      out.push(buf);
      buf = '';
    }
    // 单句仍超长 → 字符硬切（防御病态无标点输入）。
    if (p.length > maxLen) {
      for (let i = 0; i < p.length; i += maxLen) {
        const piece = p.slice(i, i + maxLen).trim();
        if (piece) out.push(piece);
      }
    } else {
      buf = buf ? `${buf} ${p}` : p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 在一段文本内递归降级切分：段落 → 单换行 → 句子。 */
function splitBlock(text: string, maxLen: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  for (const sep of ['\n\n', '\n']) {
    if (clean.includes(sep)) {
      const merged: string[] = [];
      let buf = '';
      for (const para of clean.split(sep)) {
        const p = para.trim();
        if (!p) continue;
        if (p.length > maxLen) {
          if (buf) {
            merged.push(buf);
            buf = '';
          }
          merged.push(...splitSentences(p, maxLen));
        } else if ((buf + (buf ? sep : '') + p).length <= maxLen) {
          buf = buf ? `${buf}${sep}${p}` : p;
        } else {
          if (buf) merged.push(buf);
          buf = p;
        }
      }
      if (buf.trim()) merged.push(buf.trim());
      if (merged.length > 0) return merged;
    }
  }
  return splitSentences(clean, maxLen);
}

export interface SplitOptions {
  /** 单片目标上限（字符）；缺省 480，与既有 chunkText 缺省一致。 */
  maxLen?: number;
}

/**
 * markdown 结构感知切分：标题层级定 section，section 内递归降级。
 * 返回序列按文档序编号（index 0..n-1），headingPath 为该片的标题祖先链。
 */
export function splitMarkdown(text: string, opts: SplitOptions = {}): SplitPiece[] {
  const maxLen = Math.max(80, opts.maxLen ?? 480);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // 先按标题行聚合 section（保留每级标题栈）。
  const sections: Array<{ path: string[]; body: string[] }> = [{ path: [], body: [] }];
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      const level = m[1]!.length;
      const title = m[2]!.trim();
      const prev = sections[sections.length - 1]!;
      const path = prev.path.slice(0, level - 1);
      path[level - 1] = title;
      // 更深层的旧标题栈截断（如从 ### 直跳回 #）。
      sections.push({ path: path.filter(Boolean), body: [] });
    } else {
      sections[sections.length - 1]!.body.push(line);
    }
  }
  const out: SplitPiece[] = [];
  let index = 0;
  for (const sec of sections) {
    const body = sec.body.join('\n').trim();
    if (!body) continue;
    for (const piece of splitBlock(body, maxLen)) {
      out.push({ content: piece, index: index++, headingPath: sec.path });
    }
  }
  return out;
}

/** 纯文本切分：段落 → 句子递归（无标题结构，headingPath 恒空）。 */
export function splitPlainText(text: string, opts: SplitOptions = {}): SplitPiece[] {
  const maxLen = Math.max(80, opts.maxLen ?? 480);
  let plainIndex = 0;
  return splitBlock(text.replace(/\r\n/g, '\n'), maxLen).map((content) => ({
    content,
    index: plainIndex++,
    headingPath: [],
  }));
}

/**
 * 自动分派：含 markdown 标题行（# 开头）→ splitMarkdown；否则 splitPlainText。
 * 统一 source 分支（/v1/ingest source 分支）的默认切分入口。
 */
export function splitAuto(text: string, opts: SplitOptions = {}): SplitPiece[] {
  return /(^|\n)#{1,6}\s+\S/.test(text) ? splitMarkdown(text, opts) : splitPlainText(text, opts);
}
