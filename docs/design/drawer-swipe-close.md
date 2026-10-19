# 抽屉（Drawer）侧滑关闭 —— 设计方案与实现说明

> 场景：移动端抽屉框「从边缘向侧边滑动 → 平滑关闭」。本文记录交互规格、手势状态机、
> 手势冲突（系统返回 / 应用壳边缘手势）的处置，以及双端一致性策略。
>
> 代码落点：
> - 纯逻辑：`frontend/webapp/src/utils/drawer-gesture.ts`（+ `.test.ts`）
> - 组件集成：`frontend/webapp/src/components/ah-drawer.svelte`（+ `ah-drawer-swipe.test.ts`）
> - 系统手势桥接：`frontend/webapp/src/utils/system-gesture.ts`（+ `.test.ts`）
> - Android 原生：`mobile/native-overrides/java/com/agentharness/mobile/MainActivity.java`
>   （`AhSystemGesture` JSInterface，由 `harden-android.mjs` 回打生成目录）

## 1. 交互规格

| 项 | 规格 |
|---|---|
| 发起区 | 面板**内缘带**（自由缘，朝屏幕中心那侧），带宽 32px |
| 方向 | right 抽屉向右滑、left 向左、bottom 向下、top 向上（沿关闭轴） |
| 跟手 | 面板实时跟随指尖；遮罩透明度按 `1 - 进度` 等比例衰减；越过全关位后按 0.3 阻抗衰减（橡皮筋） |
| 松手 | 距离 ≥ 面板尺寸 35% **或** 甩动速度 ≥ 0.5px/ms 且拖动量 ≥ 24px → 关闭；否则回弹 |
| 收尾曲线 | 回弹 / 滑出均复用打开动画曲线 `cubic-bezier(0.2, 0.8, 0.3, 1)` 220ms，与入场一致 |
| 触感 | 手势确认给刻度感；回弹给轻震（纯手势无 click，显式补震） |
| 例外 | 输入类元素（`input/textarea/select/[contenteditable]`）、`[data-no-swipe]` 区、可横向滚动且有溢出的内容（代码块/宽表，自动判定让位原生横向滚动）不发起；top/bottom 抽屉仅允许从头部/尾部 chrome 区发起（body 内是原生纵向滚动） |

## 2. 手势状态机

```
touchstart ── 命中内缘带 & 可测量尺寸 ──▶ candidate（不拦截任何行为）
   │
   ├─ 纵向占优 / 反向位移 ──▶ 放弃（body 原生滚动不受影响）
   │
touchmove ── 关闭轴位移 > 10px 且 > 垂直轴 × 1.2 ──▶ confirmed（掐入场动画、跟手）
   │                                                    │
touchend / touchcancel ── 距离/速度决策 ──┬─ 过阈值或快甩 ─▶ 推到全关位 → finish('swipe') → 离场动画 → onclose('swipe')
                                          └─ 否则 ─────────▶ 回弹到全开（同曲线）
```

一次手势中途**不回退**：确认后即使纵向大幅漂移也保持拖拽（与列表行滑动露钮
`utils/swipe-gesture.ts` 同一约定）。反向（朝打开方向）位移不确认——面板已全开，
没有可跟随空间。

## 3. 手势冲突处置

冲突有三个来源，分别在不同层解决：

| 冲突 | 处置 | 落点 |
|---|---|---|
| 浏览器原生横向平移 / Chrome Overscroll 返回导航 | 左右抽屉面板 `touch-action: pan-y`（纵向滚动交还 body，横向交还手势）；确认后非 passive `preventDefault` | `ah-drawer.svelte` CSS + action |
| Android 10+ 系统返回手势（边缘内滑） | 抽屉打开期间登记**系统手势排除区**（`setSystemGestureExclusionRects`，仅影响返回手势、不影响底部 Home 手势），关闭即解除；引用计数支持抽屉叠开 | `MainActivity.java`（`window.AhSystemGesture` JSInterface）+ `system-gesture.ts` |
| 应用壳「左缘右滑开侧栏」手势 | overlay 根对 touch 事件停止冒泡——模态覆盖层消费输入，壳手势收不到；`mask=false` 时外部触摸本就穿透，不受影响 | `ah-drawer.svelte` overlay 根 |

关于 iOS：本壳 rootViewController 是裸 `CAPBridgeViewController`（无
UINavigationController），交互式返回识别器不存在；WKWebView 的
`allowsBackForwardNavigationGestures` 默认关闭。即 iOS 壳内没有「边缘侧滑返回」
这一系统手势，抽屉侧滑关闭不存在系统级冲突——web 层消费手势即可，**双端用户感知一致**。
Android 侧排除区 API 自 API 29 提供，恰是系统返回手势引入的版本，低版本无需排除。

## 4. 双端一致性要点

- 手势判定 / 跟手 / 阈值 / 曲线全部在 web 层（同一份代码跑双端），原生只做系统手势排除；
- 关闭原因新增 `'swipe'`（`DrawerCloseReason` 联合类型扩展），宿主 `onclose` 无需改动
  （现有宿主均不区分原因）；
- 松手落点在按钮上时的合成 click 被 400ms 窗口吞掉，避免双端都误触；
- 触感经 `utils/haptics.ts` 既有三级降级（原生 Haptics → Web Vibration → 静默），双端语义一致。

## 5. 测试

- `utils/drawer-gesture.test.ts`：边缘带 / 轴向确认 / 橡皮筋钳制 / 速度采样 / 阈值与甩动决策 / transform 映射（31 例）；
- `utils/system-gesture.test.ts`：引用计数、原生通道调用、纯 Web 静默降级（6 例）；
- `components/ah-drawer-swipe.test.ts`：jsdom 模拟触摸——跟手 / 过阈值关闭 / 回弹 /
  纵向不误触 / 区外忽略 / 甩动关闭 / left·bottom 方位 / swipeToClose=false /
  路由中断清残留 / overlay 停止冒泡 / 合成 click 吞掉 / 曲线契约 / 排除区申请与释放（15 例）。
