import 'svelte/internal/disclose-version';
import * as $ from 'svelte/internal/client';
import { onDestroy, onMount } from 'svelte';
import { changePassword, derivePassword, bytesToHex } from '../api';
import { notify } from './ah-notification';
import { validateChangePassword } from '../utils/auth-validation';
import { APP_EVENTS } from '../app-events';
import AhDrawer from './ah-drawer.svelte';

var root = $.from_html(`<div class="field svelte-wm8mxo"><label for="ah-pw-old" class="svelte-wm8mxo">当前密码</label> <input id="ah-pw-old" type="password" autocomplete="current-password" placeholder="请输入当前密码" class="svelte-wm8mxo"/></div> <div class="field svelte-wm8mxo"><label for="ah-pw-new" class="svelte-wm8mxo">新密码（至少 8 位）</label> <input id="ah-pw-new" type="password" autocomplete="new-password" placeholder="请输入新密码" class="svelte-wm8mxo"/></div> <div class="field svelte-wm8mxo"><label for="ah-pw-confirm" class="svelte-wm8mxo">确认新密码</label> <input id="ah-pw-confirm" type="password" autocomplete="new-password" placeholder="请输入确认密码" class="svelte-wm8mxo"/></div>`, 1);
var root_1 = $.from_html(`<button type="button" class="btn ghost svelte-wm8mxo">取消</button> <button type="button" class="btn primary svelte-wm8mxo"> </button>`, 1);
var root_2 = $.from_html(`<div class="pw-scrim svelte-wm8mxo" role="button" tabindex="-1" aria-label="关闭"><div class="panel svelte-wm8mxo" role="dialog" aria-modal="true" aria-label="修改密码"><div class="head svelte-wm8mxo"><span class="title svelte-wm8mxo">修改密码</span> <button class="close svelte-wm8mxo" title="关闭" aria-label="关闭">×</button></div> <div class="body svelte-wm8mxo"><!></div> <div class="foot svelte-wm8mxo"><button class="btn ghost svelte-wm8mxo">取消</button> <button class="btn primary svelte-wm8mxo"> </button></div></div></div>`);
var root_3 = $.from_html(`<div class="pw-root no-pill svelte-wm8mxo"><!></div>`);

export default function Password_dialog($$anchor, $$props) {
	$.push($$props, true);

	/**
	 * ah-password-dialog：修改密码弹层（共享组件）—— 双形态：桌面模态 / 移动端抽屉。
	 *
	 * 由 user-menu（顶栏头像下拉 / 移动端「我的」页）承载的改密入口使用；
	 * 抽为独立组件是为了把表单与校验从菜单组件里分出来，便于单测与复用。
	 * （设置中心已移除「账户」分组，改密入口全站只有 user-menu 一处。）
	 *
	 * 形态分派（本组件内做结构切换，父级无感知，两处入口自动各得其所）：
	 *  - 桌面（宽 ≥760px 且指针精细）：居中模态，Esc / 遮罩 / 取消 / × 关闭。
	 *  - 移动端（(max-width: 760px), (pointer: coarse)——与全站 CSS 断点一致）：
	 *    全屏右侧抽屉（placement=right + fullscreen，与「我的→设置」同款形态），
	 *    复用 AhDrawer 全部能力：跟手侧滑关闭、松手阈值/回弹、系统手势排除
	 *    （Android 10+ 返回手势）、safe-area、焦点圈、路由联动关闭。
	 *    断点翻转（转屏 / 拔掉外接屏）实时切换形态。
	 *    注：这里必须用 JS 判定——模态与抽屉是两棵 DOM 树，CSS 媒体查询做不了
	 *    结构切换（ah-drawer 内「避免 JS 媒体查询」的注释针对的是纯视觉切换，
	 *    与此不冲突）。
	 *
	 * 提交中（busy）的关闭策略，两形态语义一致——「提交中禁止关闭」：
	 *  - 模态：close() 的 busy 早退兜底（Esc/遮罩/× 均汇入）。
	 *  - 抽屉：除 close() 兜底外，直接在 props 层关掉全部关闭路径
	 *    （maskClosable/escClosable/showClose/swipeToClose = !busy）。不能只靠
	 *    兜底——AhDrawer 的离场流程是「先播动画再回调 onclose」，父级 busy 拒绝
	 *    会呈现「滑出去又弹回来」的抖动，观感差；props 层禁用则根本不发起。
	 *
	 * 校验与提交（两形态共用）：
	 *  - 校验前移到前端（规则同登录 / 注册，见 utils/auth-validation.ts）；校验失败 /
	 *    后端报错 / 网络异常一律走 ah-notification，弹层内不保留内联错误条。
	 *  - 新密码客户端 PBKDF2 派生后提交（P1-14），明文新密码不出网；旧密码仍需服务端校验。
	 *
	 * 视觉：仅引用 --ah-* 语义令牌，与全站（topbar / ah-modal / 登录页）一致；深浅主题自适应。
	 * 原 :host 为 display:contents → 根壳 .pw-root（display:contents）。
	 * 注意：遮罩类名为 .pw-scrim 而非 .scrim —— 刻意避开全局抽屉遮罩规则，见下方样式注释。
	 */
	let /** 受控打开态：由父组件绑定（bind:open），内部关闭时派发 ah-pw-close。 */
	open = $.prop($$props, 'open', 15, false);

	let oldPw = $.state('');
	let newPw = $.state('');
	let confirmPw = $.state('');
	let busy = $.state(false);
	let rootEl = $.state(void 0);

	/* ── 移动端判定（结构性切换，见文件头「形态分派」）── */
	const mobileMq = typeof matchMedia === 'function'
		? matchMedia('(max-width: 760px), (pointer: coarse)')
		: undefined;

	/** 无 matchMedia 的环境（jsdom 单测）回退 false → 模态，保持既有测试路径。 */
	let asDrawer = $.state($.proxy(mobileMq?.matches ?? false));

	const onMqChange = () => {
		$.set(asDrawer, mobileMq?.matches ?? false, true);
	};

	/** 上一次 open 快照：仅在 false → true 跳变时重置草稿（对齐原 willUpdate 语义）。 */
	let wasOpen = false;

	$.user_effect(() => {
		if (open() && !wasOpen) {
			// 每次「打开」都重置草稿与忙碌态，避免上次输入残留。
			$.set(oldPw, '');

			$.set(newPw, '');
			$.set(confirmPw, '');
			$.set(busy, false);
		}

		wasOpen = open();
	});

	onMount(() => {
		// 挂载期再取一次（模块求值到挂载之间视口可能已变），并跟随断点翻转实时切换形态。
		if (mobileMq) {
			$.set(asDrawer, mobileMq.matches, true);
			mobileMq.addEventListener('change', onMqChange);
		}

		window.addEventListener('keydown', onKeydown);
		window.addEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
	});

	onDestroy(() => {
		mobileMq?.removeEventListener('change', onMqChange);
		window.removeEventListener('keydown', onKeydown);
		window.removeEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
	});

	/** 路由切换或浏览器后退/前进时关闭弹层（提交中不响应，避免请求悬挂）。 */
	function onCloseOverlays() {
		if (open()) close();
	}

	const onKeydown = (e) => {
		// 抽屉形态下 Esc 由 AhDrawer 面板统一处理（尊重其 escClosable，busy 时已禁）。
		if (e.key === 'Escape' && open() && !$.get(asDrawer)) close();
	};

	/** 关闭并通知父级同步（提交中不响应，避免请求悬挂）。 */
	function close() {
		if ($.get(busy)) return;

		open(false);
		$.get(rootEl)?.dispatchEvent(new CustomEvent('ah-pw-close', { bubbles: true, composed: true }));
	}

	async function submit() {
		if ($.get(busy)) return;

		// 前端校验（规则与后端一致，见 utils/auth-validation.ts）：不发请求即给出反馈。
		const invalid = validateChangePassword({
			oldPassword: $.get(oldPw),
			newPassword: $.get(newPw),
			confirm: $.get(confirmPw)
		});

		if (invalid) {
			notify.warning(invalid, { key: 'change-password' });

			return;
		}

		$.set(busy, true);

		// P1-14: 新密码客户端 PBKDF2 派生，不传输明文。旧密码仍以 plaintext 校验（服务端需验证）。
		const newSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));

		const newDerivedHex = await derivePassword($.get(newPw), newSalt);
		const r = await changePassword($.get(oldPw), '', { salt: newSalt, derivedHex: newDerivedHex });

		$.set(busy, false);

		if (!r.ok) {
			// 后端业务错误（旧密码错误 / 新密码太弱 / OAuth 账户不支持…）统一走通知。
			notify.error(r.error ?? '修改失败。', { key: 'change-password' });

			return;
		}

		open(false);
		$.get(rootEl)?.dispatchEvent(new CustomEvent('ah-pw-close', { bubbles: true, composed: true }));
		notify.success('密码已修改，下次登录请使用新密码');
	}

	var div = root_3();

	{
		const fields = ($$anchor) => {
			var fragment = root();
			var div_1 = $.first_child(fragment);
			var input = $.sibling($.child(div_1), 2);

			$.remove_input_defaults(input);
			$.reset(div_1);

			var div_2 = $.sibling(div_1, 2);
			var input_1 = $.sibling($.child(div_2), 2);

			$.remove_input_defaults(input_1);
			$.reset(div_2);

			var div_3 = $.sibling(div_2, 2);
			var input_2 = $.sibling($.child(div_3), 2);

			$.remove_input_defaults(input_2);
			$.reset(div_3);

			$.template_effect(() => {
				$.set_value(input, $.get(oldPw));
				$.set_value(input_1, $.get(newPw));
				$.set_value(input_2, $.get(confirmPw));
			});

			$.delegated('input', input, (e) => $.set(oldPw, e.currentTarget.value, true));
			$.delegated('input', input_1, (e) => $.set(newPw, e.currentTarget.value, true));
			$.delegated('input', input_2, (e) => $.set(confirmPw, e.currentTarget.value, true));

			$.delegated('keydown', input_2, (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					void submit();
				}
			});

			$.append($$anchor, fragment);
		};

		var node = $.child(div);

		{
			var consequent_1 = ($$anchor) => {
				var fragment_1 = $.comment();
				var node_1 = $.first_child(fragment_1);

				{
					var consequent = ($$anchor) => {
						{
							const footer = ($$anchor) => {
								var fragment_3 = root_1();
								var button = $.first_child(fragment_3);
								var button_1 = $.sibling(button, 2);
								var text = $.only_child(button_1, true);

								$.template_effect(() => {
									button.disabled = $.get(busy);
									button_1.disabled = $.get(busy);
									$.set_text(text, $.get(busy) ? '提交中…' : '修改');
								});

								$.delegated('click', button, () => close());
								$.delegated('click', button_1, () => submit());
								$.append($$anchor, fragment_3);
							};

							let $0 = $.derived(() => !$.get(busy));
							let $1 = $.derived(() => !$.get(busy));
							let $2 = $.derived(() => !$.get(busy));
							let $3 = $.derived(() => !$.get(busy));

							AhDrawer($$anchor, {
								get open() {
									return open();
								},
								placement: 'right',
								title: '修改密码',
								size: '100vw',
								fullscreen: true,
								get maskClosable() {
									return $.get($0);
								},

								get escClosable() {
									return $.get($1);
								},

								get showClose() {
									return $.get($2);
								},

								get swipeToClose() {
									return $.get($3);
								},
								onclose: () => close(),
								showFooter: true,
								footer,
								children: ($$anchor, $$slotProps) => {
									fields($$anchor);
								},
								$$slots: { footer: true, default: true }
							});
						}
					};

					var alternate = ($$anchor) => {
						var div_4 = root_2();
						var div_5 = $.child(div_4);
						var div_6 = $.child(div_5);
						var button_2 = $.sibling($.child(div_6), 2);

						$.reset(div_6);

						var div_7 = $.sibling(div_6, 2);
						var node_2 = $.child(div_7);

						fields(node_2);
						$.reset(div_7);

						var div_8 = $.sibling(div_7, 2);
						var button_3 = $.child(div_8);
						var button_4 = $.sibling(button_3, 2);
						var text_1 = $.only_child(button_4, true);

						$.reset(div_8);
						$.reset(div_5);
						$.reset(div_4);

						$.template_effect(() => {
							button_3.disabled = $.get(busy);
							button_4.disabled = $.get(busy);
							$.set_text(text_1, $.get(busy) ? '提交中…' : '修改');
						});

						$.delegated('click', div_4, (e) => {
							if (e.target === e.currentTarget) close();
						});

						$.delegated('keydown', div_4, (e) => {
							if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
								e.preventDefault();
								close();
							}
						});

						$.delegated('click', button_2, () => close());
						$.delegated('click', button_3, () => close());
						$.delegated('click', button_4, () => submit());
						$.append($$anchor, div_4);
					};

					$.if(node_1, ($$render) => {
						if ($.get(asDrawer)) $$render(consequent); else $$render(alternate, -1);
					});
				}

				$.append($$anchor, fragment_1);
			};

			$.if(node, ($$render) => {
				if (open()) $$render(consequent_1);
			});
		}

		$.reset(div);
		$.bind_this(div, ($$value) => $.set(rootEl, $$value), () => $.get(rootEl));
	}

	$.append($$anchor, div);
	$.pop();
}

$.delegate(['input', 'keydown', 'click']);