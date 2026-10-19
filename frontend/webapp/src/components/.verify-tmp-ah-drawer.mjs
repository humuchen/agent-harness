import 'svelte/internal/disclose-version';
import * as $ from 'svelte/internal/client';
import { onMount, onDestroy } from 'svelte';
import { APP_EVENTS } from '../app-events';

import {
	clampDrawerOffset,
	closingDelta,
	detectDrawerSwipe,
	drawerDragTransform,
	drawerSwipeProgress,
	inSwipeEdgeZone,
	isVerticalPlacement,
	shouldCloseDrawer,
	updateDrawerSwipeVelocity
} from '../utils/drawer-gesture';

import { acquireDrawerGestureExclusion, releaseDrawerGestureExclusion } from '../utils/system-gesture';
import { hapticSelection, hapticTap } from '../utils/haptics';

var root = $.from_html(`<div class="scrim svelte-103i8bp" role="presentation"></div>`);
var root_1 = $.from_html(`<div class="title svelte-103i8bp"> </div>`);
var root_2 = $.from_html(`<button type="button" class="close svelte-103i8bp" title="关闭"><span class="lbl-close svelte-103i8bp">关闭</span><span class="lbl-back svelte-103i8bp">返回</span> <span class="ico-close svelte-103i8bp" aria-hidden="true">×</span> <span class="ico-back svelte-103i8bp" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svelte-103i8bp"><path d="M15 18l-6-6 6-6" class="svelte-103i8bp"></path></svg></span></button>`);
var root_3 = $.from_html(`<div class="head svelte-103i8bp"><!> <!> <!></div>`);
var root_4 = $.from_html(`<div class="foot svelte-103i8bp"><!></div>`);
var root_5 = $.from_html(`<div class="foot svelte-103i8bp"><button type="button" class="btn ghost svelte-103i8bp"> </button> <button type="button" class="btn primary svelte-103i8bp"> </button></div>`);
var root_6 = $.from_html(`<div><!> <div class="panel svelte-103i8bp" role="dialog" aria-modal="true" tabindex="-1"><!> <div class="body svelte-103i8bp"><!></div> <!></div></div>`);

export default function Ah_drawer($$anchor, $$props) {
	$.push($$props, true);

	/**
	 * ah-drawer：通用抽屉组件（mac-ui 适配层）—— Svelte 迁移版
	 * -------------------------------------------------------------------
	 * 基于 @humuchen/mac-ui 的视觉令牌（--md-drawer-*）自行渲染抽屉面板
	 * （Lit 原版即如此：MacDrawer 的 portal 会丢失 shadow 样式）。
	 *
	 * 公开 API（保持原 AhDrawer 契约）：
	 *  - props：open（受控，父级持状态）/ placement / title / size / mask /
	 *    maskClosable / escClosable / showClose / confirmText / cancelText /
	 *    showFooter / fullscreen / swipeToClose
	 *  - 回调：onclose(reason: 'esc'|'mask'|'button'|'swipe') / onahOpen / onahConfirm
	 *  - 插槽：默认（body）、header、footer（Svelte snippet）
	 *
	 * 路由联动：订阅 window `ah:close-overlays`（app 壳在 Tab 切换 / 浏览器
	 * 后退前进时广播），收到后跳过离场动画立即关闭并回调 onclose。
	 *
	 * 移动端侧滑关闭（swipeToClose，默认开）：从面板内缘（自由缘）沿关闭方向拖拽，
	 * 面板跟手；松手按「距离阈值 + 甩动速度」双通道决策——过阈值/快甩则沿打开动画
	 * 同一条曲线滑出并走离场流程，未过则同曲线回弹。设计细节见 utils/drawer-gesture.ts
	 * 与文件底部「侧滑关闭」CSS 注释。
	 */
	// 触感反馈：侧滑关闭是纯手势（无 click），在手势确认/回弹处显式补震。
	/** 离场动画时长（ms），与 mac-ui 保持一致。 */
	const LEAVE_MS = 220;

	/** 打开动画曲线（@keyframes ahd-slide-in）：侧滑的跟手收尾（回弹/滑出）复用它，
	 *  保证「滑关闭」与「打开」的过渡手感一致。 */
	const OPEN_EASE = 'cubic-bezier(0.2, 0.8, 0.3, 1)';

	/** 拖拽结束后吞「合成 click」的窗口（ms）：指尖拖完松手若落在按钮上，浏览器会补发
	 *  一次 click，这里拦掉，避免误触（与 ah-swipe-item 同一问题域）。 */
	const CLICK_SWALLOW_MS = 400;

	/** 不启用手势的目标：输入类元素（文本选择/拖动）与宿主显式声明的排除区。 */
	const SWIPE_IGNORE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [data-no-swipe]';

	let open = $.prop($$props, 'open', 3, false),
		placement = $.prop($$props, 'placement', 3, 'right'),
		title = $.prop($$props, 'title', 3, ''),
		size = $.prop($$props, 'size', 3, '320px'),
		mask = $.prop($$props, 'mask', 3, true),
		maskClosable = $.prop($$props, 'maskClosable', 3, true),
		escClosable = $.prop($$props, 'escClosable', 3, true),
		showClose = $.prop($$props, 'showClose', 3, true),
		confirmText = $.prop($$props, 'confirmText', 3, '确定'),
		cancelText = $.prop($$props, 'cancelText', 3, '取消'),
		showFooter = $.prop($$props, 'showFooter', 3, false),
		fullscreen = $.prop($$props, 'fullscreen', 3, false),
		swipeToClose = $.prop($$props, 'swipeToClose', 3, true);

	/** 侧滑关闭手势开关（默认开）。仅触屏有效——鼠标拖拽不产生 touch 事件。 */
	let leaving = $.state(false);

	let panelEl = $.state(void 0);
	let scrimEl = $.state(void 0);
	let lastFocus = null;

	/* ------------------------------------------------------------------ *
	 * 侧滑关闭手势状态（非响应式：直接驱动 DOM，保证跟手无重渲染滞后）
	 * ------------------------------------------------------------------ */
	/** 一次触摸手势的生命周期状态。 */
	/** 轴是否已确认为关闭拖拽（未确认=普通点按/纵向滚动，不拦截）。 */
	/** 当前关闭向拖动量（px，已含橡皮筋衰减）。 */
	/** 面板在关闭轴上的尺寸（px）。 */
	/** 速度采样点（松手甩动判定用）。 */
	/** 最近一次采样速度（px/ms，正=朝关闭方向）。 */
	let swipe = null;

	/** 回弹收尾定时器（清内联 transition 用）。 */
	let snapTimer = null;

	/** open 属性变化：打开时锁滚动 + 聚焦关闭键 + 回调 ah-open；关闭时还原焦点与滚动。 */
	$.user_effect(() => {
		if (open()) {
			lastFocus = document.activeElement;

			if (mask()) document.body.style.overflow = 'hidden';

			requestAnimationFrame(() => {
				const target = $.get(panelEl)?.querySelector('.close') ?? $.get(panelEl);

				target?.focus();
			});

			$$props.onahOpen?.();
		} else if (lastFocus) {
			try {
				lastFocus.focus();
			} catch {
				/* 焦点目标已销毁时忽略 */
			}

			lastFocus = null;

			if (mask()) document.body.style.overflow = '';
		}
	});

	/**
	 * 打开期间向原生壳申请「系统返回手势排除区」（引用计数，见 utils/system-gesture.ts）。
	 *
	 * 为什么需要：移动端抽屉常为全屏，其内缘即屏幕对侧边缘，与 Android 10+ 的系统
	 * 返回手势同带——不排除则「抽屉内右滑关闭」会同时触发系统返回。iOS 壳内无
	 * UINavigationController，该系统手势不存在，无需对称处理（详见该文件头注释）。
	 * cleanup 挂在 $effect 上：open 翻转或组件销毁时必然配平释放。
	 */
	$.user_effect(() => {
		if (open() && swipeToClose()) {
			acquireDrawerGestureExclusion();

			return () => releaseDrawerGestureExclusion();
		}
	});

	onMount(() => {
		// 订阅全局「关闭所有覆盖层」信号（Tab 切换 / 浏览器后退前进），见文件头「路由联动」。
		window.addEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
	});

	onDestroy(() => {
		if (mask()) document.body.style.overflow = '';

		window.removeEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);

		if (snapTimer !== null) window.clearTimeout(snapTimer);

		snapTimer = null;
		swipe = null;
	});

	/** 路由变化时的强制关闭：跳过离场动画，但仍回调 onclose 让宿主同步自身状态。 */
	function onCloseOverlays() {
		if (open()) finish('button', true);
	}

	function finish(reason, skipAnimation = false) {
		if (!open() || $.get(leaving)) return;

		// 手势进行中被命令式关闭（esc/mask/按钮/路由）：中止跟手并清掉内联位移，
		// 否则 .leaving 的过渡会从「半开位移」这个错误起点播放。
		// （swipe 路径松手时已把 swipe 置空并写好目标 transform，不受此处影响。）
		if (swipe) resetSwipe();

		$.set(leaving, true);

		const dispatch = () => {
			$.set(leaving, false);
			$$props.onclose?.(reason);
		};

		if (skipAnimation) {
			dispatch();
		} else {
			window.setTimeout(dispatch, LEAVE_MS);
		}
	}

	function onKeydown(e) {
		if (e.key === 'Escape') {
			if (!escClosable()) return;

			e.stopPropagation();
			finish('esc');

			return;
		}

		if (e.key !== 'Tab') return;

		const focusables = getFocusableElements();

		if (!focusables.length) return;

		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		const activeIn = active !== null && focusables.includes(active);

		if (e.shiftKey && (active === first || !activeIn)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !activeIn)) {
			e.preventDefault();
			first.focus();
		}
	}

	/** 焦点圈闭环：面板内 + snippet 投影内容中的可聚焦元素（Svelte 无 light/shadow 之分，统一查面板内）。 */
	function getFocusableElements() {
		const els = Array.from($.get(panelEl)?.querySelectorAll('button, input, select, textarea, a[href], [tabindex]') ?? []);

		return els.filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
	}

	/* ------------------------------------------------------------------ *
	 * 侧滑关闭手势（移动端）
	 * ------------------------------------------------------------------ */
	/** 清掉跟手期写在面板上的全部内联样式，回到样式表定义的「全开」态。 */
	function clearSwipeStyles(node) {
		node.style.transform = '';
		node.style.transition = '';
		node.style.animation = '';
		node.style.willChange = '';
		node.style.userSelect = '';
		node.style.webkitUserSelect = '';
	}

	/** 中断进行中的手势：清状态 + 清内联样式（面板与遮罩）。 */
	function resetSwipe() {
		swipe = null;

		if (snapTimer !== null) {
			window.clearTimeout(snapTimer);
			snapTimer = null;
		}

		if ($.get(panelEl)) clearSwipeStyles($.get(panelEl));

		if ($.get(scrimEl)) {
			$.get(scrimEl).style.opacity = '';
			$.get(scrimEl).style.transition = '';
			$.get(scrimEl).style.animation = '';
		}
	}

	/** 吞掉拖拽松手后落在面板上的合成 click（防误触按钮）。 */
	function swallowClick(e) {
		e.preventDefault();
		e.stopPropagation();
	}

	/**
	 * 触摸起点是否落在「可横向滚动且确有溢出」的内容上（代码块 / 宽表等）。
	 * 命中则让位给原生横向滚动——否则从该处右滑会关掉抽屉而非滚动内容。
	 * 仅左右抽屉需要判定（垂直抽屉的关闭拖拽是纵向的，不抢横向滚动）。
	 */
	function inHorizontalScroller(el, panel) {
		let node = el;

		while (node && node !== panel) {
			const ox = getComputedStyle(node).overflowX;

			if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 1) {
				return true;
			}

			node = node.parentElement;
		}

		return false;
	}

	/** 触摸起点：记录候选手势（未确认前不拦截任何行为）。 */
	const onSwipeTouchStart = (e) => {
		if (!swipeToClose() || !open() || $.get(leaving) || swipe || e.touches.length !== 1) return;

		const t = e.touches[0];

		if (!t) return;

		const el = e.target;

		// 输入类元素（文本选择/拖动）与宿主显式排除区不启用手势
		if (el?.closest?.(SWIPE_IGNORE_SELECTOR)) return;

		const node = $.get(panelEl);

		if (!node) return;

		// 垂直方位抽屉：body 内是原生纵向滚动，只允许从头部/尾部「chrome 区」发起
		if (isVerticalPlacement(placement()) && el?.closest?.('.body')) return;

		// 左右抽屉：起点在可横向滚动的内容（代码块/宽表）上时让位给原生横向滚动
		if (!isVerticalPlacement(placement()) && inHorizontalScroller(el, node)) return;

		// 只认「面板内缘带」发起：与系统返回手势所在的屏幕最外侧边缘带错开
		if (!inSwipeEdgeZone(placement(), t.clientX, t.clientY, node.getBoundingClientRect())) {
			return;
		}

		const size = isVerticalPlacement(placement()) ? node.offsetHeight : node.offsetWidth;

		if (size <= 0) return; // 未布局（如 display:none）：无可跟随尺寸，放弃

		swipe = {
			x0: t.clientX,
			y0: t.clientY,
			confirmed: false,
			offset: 0,
			size,
			sample: null,
			velocity: 0
		};
	};

	/** 触摸移动：确认轴向后跟手（面板位移 + 遮罩等比例衰减）。 */
	const onSwipeTouchMove = (e) => {
		const s = swipe;
		const node = $.get(panelEl);

		if (!s || !node || e.touches.length !== 1) return;

		const t = e.touches[0];

		if (!t) return;

		const dx = t.clientX - s.x0;
		const dy = t.clientY - s.y0;

		// 未确认且不满足轴向条件 → 交回原生行为（纵向滚动等），不拦截
		if (detectDrawerSwipe(placement(), s.confirmed, dx, dy) !== 'drag') return;

		if (!s.confirmed) {
			s.confirmed = true;

			// 掐掉入场动画：CSS 动画（含 forwards fill）优先级高于内联样式，
			// 不掐则跟手 transform / 遮罩 opacity 都不生效。
			node.style.animation = 'none';

			node.style.transition = 'none';
			node.style.willChange = 'transform';

			// 拖拽期间禁止文本选择（长按选择会被横向拖动误启动）
			node.style.userSelect = 'none';

			node.style.webkitUserSelect = 'none';

			if ($.get(scrimEl)) {
				$.get(scrimEl).style.animation = 'none';
				$.get(scrimEl // 掐掉 fill 后基础值是 0，先补齐全显
				).style.opacity = '1';
			}

			// 手势确认的刻度感（纯手势无 click，显式补一次）
			hapticSelection();
		}

		// 非 passive 监听：阻止浏览器横向平移/overscroll，并抑制后续合成鼠标事件
		e.preventDefault();

		s.offset = clampDrawerOffset(closingDelta(placement(), dx, dy), s.size);

		const v = updateDrawerSwipeVelocity(s.sample, s.offset, Date.now());

		s.velocity = v.velocity;
		s.sample = v.sample;
		node.style.transform = drawerDragTransform(placement(), s.offset);

		if ($.get(scrimEl)) {
			$.get(scrimEl).style.opacity = String(1 - drawerSwipeProgress(s.offset, s.size));
		}
	};

	/** 松手 / 手势取消：按「距离阈值 + 甩动速度」决策关闭或回弹。 */
	const onSwipeTouchEnd = () => {
		const s = swipe;
		const node = $.get(panelEl);

		if (!s || !node) return;

		swipe = null;

		if (!s.confirmed) return; // 未确认：普通点按/纵向滚动，click 正常派发

		// 吞掉本次松手落在按钮上产生的合成 click（400ms 窗口内无人点击则自销）
		node.addEventListener('click', swallowClick, true);

		window.setTimeout(() => node.removeEventListener('click', swallowClick, true), CLICK_SWALLOW_MS);

		if (shouldCloseDrawer(s.offset, s.size, s.velocity)) {
			// 过阈值 / 快甩：沿打开动画同一条曲线推到全关位，再走既有离场流程
			// （finish 回调 onclose，由父级把 open 置 false 完成卸载）。
			node.style.transition = `transform ${LEAVE_MS}ms ${OPEN_EASE}, opacity ${LEAVE_MS}ms ease`;

			node.style.transform = drawerDragTransform(placement(), s.size);

			if ($.get(scrimEl)) {
				$.get(scrimEl).style.transition = `opacity ${LEAVE_MS}ms ease`;
				$.get(scrimEl).style.opacity = '0';
			}

			finish('swipe');
		} else {
			// 未过阈值：回弹到全开（同曲线），轻震提示「没关成」
			node.style.transition = `transform ${LEAVE_MS}ms ${OPEN_EASE}`;

			node.style.transform = '';

			if ($.get(scrimEl)) {
				$.get(scrimEl).style.transition = `opacity ${LEAVE_MS}ms ease`;
				$.get(scrimEl).style.opacity = '1';
			}

			hapticTap('light');

			// 回弹收尾后清掉内联 transition/will-change，避免残留影响后续离场动画
			snapTimer = window.setTimeout(
				() => {
					snapTimer = null;

					if (node.isConnected) {
						node.style.transition = '';
						node.style.willChange = '';
					}
				},
				LEAVE_MS + 60
			);
		}
	};

	/** 手势被系统接管（来电/多指）：按当前位移就近吸附，语义同松手。 */
	const onSwipeTouchCancel = () => onSwipeTouchEnd();

	/**
	 * 侧滑关闭手势（Svelte action，挂在面板上）。
	 *
	 * 为什么用 action 而非模板 ontouchmove：Svelte 5 把 touchstart/touchmove 委派为
	 * passive 监听（svelte 的 PASSIVE_EVENTS），passive 内 preventDefault 不生效——
	 * 而「阻止浏览器横向平移 / 抑制合成 click」正是本手势的必需项。这里显式
	 * addEventListener('touchmove', …, { passive: false })。面板随 {#if open}
	 * 反复重建，action 随之反复挂载，监听器天然随之生灭。
	 */
	function drawerSwipeGesture(node) {
		node.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
		node.addEventListener('touchmove', onSwipeTouchMove, { passive: false });
		node.addEventListener('touchend', onSwipeTouchEnd);
		node.addEventListener('touchcancel', onSwipeTouchCancel);

		return {
			destroy() {
				node.removeEventListener('touchstart', onSwipeTouchStart);
				node.removeEventListener('touchmove', onSwipeTouchMove);
				node.removeEventListener('touchend', onSwipeTouchEnd);
				node.removeEventListener('touchcancel', onSwipeTouchCancel);
				node.removeEventListener('click', swallowClick, true);

				if (snapTimer !== null) {
					window.clearTimeout(snapTimer);
					snapTimer = null;
				}

				swipe = null;
			}
		};
	}

	var fragment = $.comment();
	var node_1 = $.first_child(fragment);

	{
		var consequent_6 = ($$anchor) => {
			var div = root_6();
			var node_2 = $.child(div);

			{
				var consequent = ($$anchor) => {
					var div_1 = root();

					$.bind_this(div_1, ($$value) => $.set(scrimEl, $$value), () => $.get(scrimEl));

					$.delegated('click', div_1, (e) => {
						if (maskClosable() && e.target === e.currentTarget) finish('mask');
					});

					$.append($$anchor, div_1);
				};

				$.if(node_2, ($$render) => {
					if (mask()) $$render(consequent);
				});
			}

			var div_2 = $.sibling(node_2, 2);
			var node_3 = $.child(div_2);

			{
				var consequent_3 = ($$anchor) => {
					var div_3 = root_3();
					var node_4 = $.child(div_3);

					{
						var consequent_1 = ($$anchor) => {
							var div_4 = root_1();
							var text = $.only_child(div_4, true);

							$.template_effect(() => $.set_text(text, title()));
							$.append($$anchor, div_4);
						};

						$.if(node_4, ($$render) => {
							if (title()) $$render(consequent_1);
						});
					}

					var node_5 = $.sibling(node_4, 2);

					$.snippet(node_5, () => $$props.header ?? $.noop);

					var node_6 = $.sibling(node_5, 2);

					{
						var consequent_2 = ($$anchor) => {
							var button = root_2();

							$.delegated('click', button, () => finish('button'));
							$.append($$anchor, button);
						};

						$.if(node_6, ($$render) => {
							if (showClose()) $$render(consequent_2);
						});
					}

					$.reset(div_3);
					$.append($$anchor, div_3);
				};

				$.if(node_3, ($$render) => {
					if (title() || showClose()) $$render(consequent_3);
				});
			}

			var div_5 = $.sibling(node_3, 2);
			var node_7 = $.child(div_5);

			$.snippet(node_7, () => $$props.children ?? $.noop);
			$.reset(div_5);

			var node_8 = $.sibling(div_5, 2);

			{
				var consequent_5 = ($$anchor) => {
					var fragment_1 = $.comment();
					var node_9 = $.first_child(fragment_1);

					{
						var consequent_4 = ($$anchor) => {
							var div_6 = root_4();
							var node_10 = $.child(div_6);

							$.snippet(node_10, () => $$props.footer);
							$.reset(div_6);
							$.append($$anchor, div_6);
						};

						var alternate = ($$anchor) => {
							var div_7 = root_5();
							var button_1 = $.child(div_7);
							var text_1 = $.only_child(button_1, true);
							var button_2 = $.sibling(button_1, 2);
							var text_2 = $.only_child(button_2, true);

							$.reset(div_7);

							$.template_effect(() => {
								$.set_text(text_1, cancelText());
								$.set_text(text_2, confirmText());
							});

							$.delegated('click', button_1, () => finish('button'));
							$.delegated('click', button_2, () => $$props.onahConfirm?.());
							$.append($$anchor, div_7);
						};

						$.if(node_9, ($$render) => {
							if ($$props.footer) $$render(consequent_4); else $$render(alternate, -1);
						});
					}

					$.append($$anchor, fragment_1);
				};

				$.if(node_8, ($$render) => {
					if (showFooter()) $$render(consequent_5);
				});
			}

			$.reset(div_2);
			$.bind_this(div_2, ($$value) => $.set(panelEl, $$value), () => $.get(panelEl));
			$.action(div_2, ($$node) => drawerSwipeGesture?.($$node));
			$.reset(div);

			$.template_effect(() => {
				$.set_class(div, 1, `overlay no-pill ${placement() ?? ''}${$.get(leaving) ? ' leaving' : ''}${fullscreen() ? ' fullscreen' : ''}`, 'svelte-103i8bp');
				$.set_style(div_2, `--ahd-size: ${size() ?? ''}`);
				$.set_attribute(div_2, 'aria-label', title() || '抽屉');
			});

			$.delegated('touchstart', div, (e) => e.stopPropagation(), void 0, true);
			$.delegated('touchmove', div, (e) => e.stopPropagation(), void 0, true);
			$.delegated('touchend', div, (e) => e.stopPropagation());
			$.event('touchcancel', div, (e) => e.stopPropagation());
			$.delegated('keydown', div_2, onKeydown);
			$.append($$anchor, div);
		};

		$.if(node_1, ($$render) => {
			if (open()) $$render(consequent_6);
		});
	}

	$.append($$anchor, fragment);
	$.pop();
}

$.delegate(['touchstart', 'touchmove', 'touchend', 'click', 'keydown']);