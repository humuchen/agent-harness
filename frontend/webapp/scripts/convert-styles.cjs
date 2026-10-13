/**
 * Lit css`` 模板 → Svelte 纯 CSS 字符串的一次性转换脚本。
 * 转换规则（对 styles/ 与 styles/chat/ 下全部 .ts）：
 *  1. 删除 `import { css } from 'lit';`
 *  2. `export const X = css\`` → `export const X = \``（内容逐字节保留）
 *  3. `:host {` → `.ah-c {`；`:host([attr='v'])` → `.ah-c[data-attr='v']`；`:host([attr])` → `.ah-c[data-attr]`
 *     （仅匹配选择器位置：行首缩进后 或 `, ` / `(` 之后；注释内的 :host 文本一并替换但无功能影响）
 *  4. 元素名选择器 → 根类（Shadow DOM 消失后这些选择器必须指向 light DOM 根类）：
 *     ah-composer-plus → .composer-plus-root；ah-model-picker → .model-picker-root；
 *     ah-swipe-item → .swipe-item-root；::part(trigger) → .trigger（原规则本就无 part 属性，属死规则，安全降级）
 */
const fs = require('fs');
const path = require('path');

const base = path.resolve(__dirname, '..', 'src');
const dirs = ['styles', 'styles/chat'];

let changed = 0;
for (const dir of dirs) {
  const abs = path.join(base, dir);
  for (const f of fs.readdirSync(abs)) {
    if (!f.endsWith('.ts')) continue;
    const p = path.join(abs, f);
    let s = fs.readFileSync(p, 'utf8');
    const before = s;
    s = s.replace(/^import \{ css \} from 'lit';\r?\n/m, '');
    s = s.replace(/= css`/g, '= `');
    // :host 变体（属性选择器带值/不带值），仅选择器位置
    s = s.replace(/(^[ \t]*):host\(\[([a-z-]+)=(['"])([^'"]+)\3\]\)/gm, "$1.ah-c[data-$2='$4']");
    s = s.replace(/(^[ \t]*):host\(\[([a-z-]+)\]\)/gm, '$1.ah-c[data-$2]');
    s = s.replace(/(^[ \t]*):host\b/gm, '$1.ah-c');
    s = s.replace(/([(,]\s*):host\(\[([a-z-]+)=(['"])([^'"]+)\3\]\)/g, "$1.ah-c[data-$2='$4']");
    s = s.replace(/([(,]\s*):host\(\[([a-z-]+)\]\)/g, '$1.ah-c[data-$2]');
    s = s.replace(/([(,]\s*):host\b/g, '$1.ah-c');
    // 元素名选择器 → 根类
    s = s.split('ah-composer-plus').join('.composer-plus-root');
    s = s.split('ah-model-picker').join('.model-picker-root');
    s = s.split('ah-swipe-item').join('.swipe-item-root');
    s = s.split('::part(trigger)').join('.trigger');
    if (s !== before) {
      fs.writeFileSync(p, s);
      changed++;
      console.log('converted:', path.relative(base, p));
    }
  }
}
console.log('done, files changed:', changed);
