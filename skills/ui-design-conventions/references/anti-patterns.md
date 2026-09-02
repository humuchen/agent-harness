# 反模式与收敛对照

> 每个条目给出「问题 → 为什么错 → 收敛做法 → 代码对照」。
> 出现下列任一模式，在交付前必须改掉。

---

## 一、尺寸与间距

### 1.1 主动放大（最常见）

**症状**：为了「让用户看清」「显得重要」而加大字号 / 控件高度 / 内边距，结果同屏出现两种密度。

```css
/* ❌ 页面标题 32px，正文 13px，工具栏按钮 40px 高 —— 标题抢走全部注意力 */
.page-title { font-size: 32px; font-weight: 700; margin-bottom: 32px; }
.toolbar-btn { height: 40px; padding: 0 20px; font-size: 15px; }
.table-row { height: 32px; font-size: 13px; }

/* ✅ 围绕表格行 32px 这个锚点，全部落在一档内 */
.page-title { font-size: 20px; font-weight: 600; margin-bottom: 16px; }
.toolbar-btn { height: 28px; padding: 0 10px; font-size: 13px; }
.table-row { height: 32px; font-size: 13px; }
```

### 1.2 统一规格表硬套

**症状**：全站 padding 一律 16px、间距一律 24px，高密度表格显得空、低密度详情页显得挤。

**改法**：用锚点法（见 `spacing-scale.md` §1）——表格区用 8/12px 阶梯，表单区用 12/16px 阶梯，页面级分区才用 24/32px。

### 1.3 同屏字号超过 4 种

**症状**：12 / 13 / 14 / 16 / 18 / 20 / 24 七档同时出现。

**改法**：合并到 ≤ 4 档，层级改用字重（400 / 500 / 600）与颜色表达，不要再加字号。

---

## 二、辅助入口抢视觉中心

### 2.1 设置按钮做成主按钮同款

```css
/* ❌ 设置按钮与「保存」同等视觉权重 */
.btn-settings {
  background: var(--accent); color: #fff;
  padding: 10px 20px; border-radius: 8px; font-size: 15px;
  box-shadow: 0 2px 8px rgba(0,0,0,.15);
}

/* ✅ 中性幽灵按钮，仅 hover 时提亮 */
.btn-settings {
  background: transparent; color: var(--text-secondary);
  padding: 6px 8px; border-radius: 6px; font-size: 13px;
}
.btn-settings:hover { background: var(--surface-hover); color: var(--text); }
```

### 2.2 行内操作常驻高对比

```html
<!-- ❌ 每行常驻三个彩色按钮，视线被操作列吸走 -->
<td>
  <button class="op op-edit">编辑</button>
  <button class="op op-copy">复制</button>
  <button class="op op-del">删除</button>
</td>

<!-- ✅ 默认低对比，行 hover 时才显形；语义色只在 hover 到具体按钮时出现 -->
<td class="row-ops">
  <button class="op" aria-label="编辑" title="编辑"><svg …></button>
  <button class="op" aria-label="复制" title="复制"><svg …></button>
  <button class="op op-danger" aria-label="删除" title="删除"><svg …></button>
</td>
```
```css
.op { opacity: .45; }
tr:hover .op, .op:focus-visible { opacity: 1; }
.op-danger:hover { color: var(--danger); }
```

### 2.3 两个以上 primary 按钮同屏

**症状**：「保存」「发布」「导出」三个都是实心强调色。

**改法**：一屏一个 primary（通常是终结性主操作），其余降为 secondary（描边）/ ghost（无边框）。

---

## 三、图标

### 3.1 语义错配

```html
<!-- ❌ 齿轮表示筛选、× 表示删除 -->
<button title="筛选"><GearIcon/></button>
<button title="删除"><XIcon/></button>

<!-- ✅ -->
<button title="筛选"><FilterIcon/></button>   <!-- 漏斗 -->
<button title="删除"><TrashIcon/></button>    <!-- 垃圾桶 -->
<button title="关闭"><XIcon/></button>        <!-- × 只用于关闭/取消 -->
```

### 3.2 混用图标库 / 风格

**症状**：导航用 Lucide（2px 线宽），表格操作用 Material Symbols（填充风格），右上用自创 SVG。

**改法**：全站统一一个库。确需补充图标时，优先在**同一库**里找替代，其次才是按该库的网格/线宽自绘。

### 3.3 自创抽象图标

```svg
<!-- ❌ 三条抽象曲线表示「同步」，无人能认 -->
<svg viewBox="0 0 24 24"><path d="M4 8c4-6 12-6 16 0M4 16c4 6 12 6 16 0M12 4v16"/></svg>

<!-- ✅ 通用环形箭头（refresh-cw），一眼可识别 -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
</svg>
```

### 3.4 图标无 aria-label

```html
<!-- ❌ 屏幕阅读器与 hover 都无法获知功能 -->
<button class="icon-btn"><svg …></button>

<!-- ✅ -->
<button class="icon-btn" aria-label="刷新" title="刷新"><svg …></button>
```

### 3.5 图标与文字尺寸不匹配

```css
/* ❌ 14px 文字配 24px 图标 */
.meta { font-size: 14px; }
.meta svg { width: 24px; height: 24px; }

/* ✅ 16px 图标 + 4-6px 间隙 */
.meta { font-size: 14px; display: inline-flex; align-items: center; gap: 6px; }
.meta svg { width: 16px; height: 16px; color: currentColor; }
```

---

## 四、层级表达手段

### 4.1 用强度而非对比建立层级

```css
/* ❌ 把所有东西都加强 → 平级竞争 */
.card-title { font-size: 20px; font-weight: 700; color: var(--accent); }
.card-desc  { font-size: 15px; color: var(--text); }

/* ✅ 主要元素保持常规，把次要元素调弱 → 对比自然成立 */
.card-title { font-size: 14px; font-weight: 600; color: var(--text); }
.card-desc  { font-size: 13px; color: var(--text-secondary); }
```

### 4.2 用色块做分组

```html
<!-- ❌ 每个分组一个彩色背景块 -->
<div class="group" style="background:#EEF4FF">…</div>
<div class="group" style="background:#F6F6F6">…</div>

<!-- ✅ 靠间距分组（组间距 > 组内间距）+ 1px 分隔线 -->
<div class="group">…</div>
<hr class="divider" />
<div class="group">…</div>
```
```css
.group { display: flex; flex-direction: column; gap: 8px; }
.group + .group { margin-top: 24px; }
.divider { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
```

### 4.3 营销页式布局入侵工具类界面

**症状**：后台页顶部 200px 高的渐变 hero + 48px 粗标题 + 居中大 CTA 按钮 + 三张带阴影的特性卡。

**改法**：工具类界面顶部就是「页面标题（18-20px）+ 一句说明 + 右上主操作」，高度控制在 48-64px。

---

## 五、装饰性视觉

### 5.1 静态卡片加阴影

```css
/* ❌ 平贴在背景上的卡片不该有阴影 */
.card { box-shadow: 0 4px 20px rgba(0,0,0,.12), 0 1px 3px rgba(0,0,0,.08); border-radius: 16px; }

/* ✅ 1px 边框，阴影留给真正浮起的层 */
.card { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.dropdown { box-shadow: 0 4px 12px rgba(0,0,0,.10); }   /* 浮层才用 */
```

### 5.2 装饰性渐变

```css
/* ❌ 纯装饰渐变 */
.btn-primary { background: linear-gradient(135deg,#6366F1,#8B5CF6); }
.page-header { background: linear-gradient(120deg,#0EA5E9 0%,#6366F1 100%); }

/* ✅ 单色实底 */
.btn-primary { background: var(--accent); }
.page-header { background: var(--surface); border-bottom: 1px solid var(--border); }
```

### 5.3 大圆角 / 厚边框

```css
/* ❌ */
.btn { border-radius: 999px; padding: 12px 28px; }
.panel { border: 3px solid var(--accent); border-radius: 20px; }

/* ✅ */
.btn { border-radius: 6px; padding: 6px 12px; }
.panel { border: 1px solid var(--border); border-radius: 8px; }
/* 仅选中态用 2px */
.panel.is-selected { border: 2px solid var(--accent); }
```

### 5.4 强调色滥用

**症状**：标题、图标、边框、标签背景、按钮全用强调色 → 等于没有强调。

**改法**：强调色面积控制在 5% 以内，只给「当前唯一的主操作」和「选中态」。

---

## 六、状态缺失

### 6.1 focus 被抹掉

```css
/* ❌ */
button:focus { outline: none; }

/* ✅ */
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

### 6.2 数据区只有「有数据」一种状态

**缺失**：loading / empty / error / partial。
**补齐**：
- `loading` → 骨架屏（优先）或 spinner，尺寸与真实内容一致，避免跳动
- `empty` → 一句人话 + 一个主操作（不要只放插画）
- `error` → 一句人话 + 重试按钮（不要只显示错误码）
- `disabled` → 降低不透明度 + `cursor: not-allowed` + 说明为什么（tooltip）

---

## 七、工程侧

### 7.1 硬编码颜色

```css
/* ❌ */
.badge { color: #2997FF; background: #0B0E14; }

/* ✅ 使用项目既有令牌 */
.badge { color: var(--accent); background: var(--surface-1); }
```

### 7.2 只做浅色主题

暗色主题不是「把背景反过来」，需要单独校准：
- 降低强调色饱和度（亮色在暗底上会刺眼）
- 阴影在暗色下几乎无效 → 改用边框 + 背景层级（surface-1 / surface-2）
- 分隔线用低透明度白色，不要用纯黑

### 7.3 窄屏塌缩

```css
/* ❌ 窄屏下表格被压到不可读 / 表单变双列 */
@media (max-width: 640px) { .form { grid-template-columns: 1fr 1fr; } }

/* ✅ 窄屏单列 + 表格横向滚动 */
@media (max-width: 640px) {
  .form { grid-template-columns: 1fr; }
  .table-wrap { overflow-x: auto; }
}
```

### 7.4 动效过度

```css
/* ❌ 交错入场 + 弹跳 */
.list-item { animation: bounceIn .6s; animation-delay: calc(var(--i) * 80ms); }

/* ✅ 无动画或 120ms 淡入，尊重系统偏好 */
@media (prefers-reduced-motion: reduce) { * { animation: none; transition: none; } }
```
