<script lang="ts">
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
  import { onDestroy, onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { changePassword, derivePassword, bytesToHex } from '../api';
  import { notify } from './ah-notification';
  import { validateChangePassword } from '../utils/auth-validation';
  import { APP_EVENTS } from '../app-events';
  import AhDrawer from './ah-drawer.svelte';

  let {
    /** 受控打开态：由父组件绑定（bind:open），内部关闭时派发 ah-pw-close。 */
    open = $bindable(false)
  }: { open?: boolean } = $props();

  let oldPw = $state('');
  let newPw = $state('');
  let confirmPw = $state('');
  let busy = $state(false);

  let rootEl: HTMLElement | undefined = $state();

  /* ── 移动端判定（结构性切换，见文件头「形态分派」）── */
  const mobileMq: MediaQueryList | undefined =
    typeof matchMedia === 'function'
      ? matchMedia('(max-width: 760px), (pointer: coarse)')
      : undefined;
  /** 无 matchMedia 的环境（jsdom 单测）回退 false → 模态，保持既有测试路径。 */
  let asDrawer = $state(mobileMq?.matches ?? false);

  const onMqChange = () => {
    asDrawer = mobileMq?.matches ?? false;
  };

  /** 上一次 open 快照：仅在 false → true 跳变时重置草稿（对齐原 willUpdate 语义）。 */
  let wasOpen = false;

  $effect(() => {
    if (open && !wasOpen) {
      // 每次「打开」都重置草稿与忙碌态，避免上次输入残留。
      oldPw = '';
      newPw = '';
      confirmPw = '';
      busy = false;
    }
    wasOpen = open;
  });

  onMount(() => {
    // 挂载期再取一次（模块求值到挂载之间视口可能已变），并跟随断点翻转实时切换形态。
    if (mobileMq) {
      asDrawer = mobileMq.matches;
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
    if (open) close();
  }

  const onKeydown = (e: KeyboardEvent) => {
    // 抽屉形态下 Esc 由 AhDrawer 面板统一处理（尊重其 escClosable，busy 时已禁）。
    if (e.key === 'Escape' && open && !asDrawer) close();
  };

  /** 关闭并通知父级同步（提交中不响应，避免请求悬挂）。 */
  function close() {
    if (busy) return;
    open = false;
    rootEl?.dispatchEvent(
      new CustomEvent('ah-pw-close', { bubbles: true, composed: true })
    );
  }

  async function submit() {
    if (busy) return;
    // 前端校验（规则与后端一致，见 utils/auth-validation.ts）：不发请求即给出反馈。
    const invalid = validateChangePassword({
      oldPassword: oldPw,
      newPassword: newPw,
      confirm: confirmPw
    });
    if (invalid) {
      notify.warning(invalid, { key: 'change-password' });
      return;
    }
    busy = true;
    // P1-14: 新密码客户端 PBKDF2 派生，不传输明文。旧密码仍以 plaintext 校验（服务端需验证）。
    const newSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const newDerivedHex = await derivePassword(newPw, newSalt);
    const r = await changePassword(oldPw, '', {
      salt: newSalt,
      derivedHex: newDerivedHex
    });
    busy = false;
    if (!r.ok) {
      // 后端业务错误（旧密码错误 / 新密码太弱 / OAuth 账户不支持…）统一走通知。
      notify.error(r.error ?? '修改失败。', { key: 'change-password' });
      return;
    }
    open = false;
    rootEl?.dispatchEvent(
      new CustomEvent('ah-pw-close', { bubbles: true, composed: true })
    );
    notify.success('密码已修改，下次登录请使用新密码');
  }
</script>

<div class="pw-root no-pill" bind:this={rootEl}>
  <!-- 表单字段：模态与抽屉两形态共用（Svelte snippet，避免双份维护）。
       声明在 .pw-root 内即可被下方两处 {@render fields()} 词法可见。 -->
  {#snippet fields()}
    <div class="field">
      <label for="ah-pw-old">当前密码</label>
      <input
        id="ah-pw-old"
        type="password"
        autocomplete="current-password"
        placeholder="请输入当前密码"
        value={oldPw}
        oninput={(e) => (oldPw = e.currentTarget.value)}
      />
    </div>
    <div class="field">
      <label for="ah-pw-new">新密码（至少 8 位）</label>
      <input
        id="ah-pw-new"
        type="password"
        autocomplete="new-password"
        placeholder="请输入新密码"
        value={newPw}
        oninput={(e) => (newPw = e.currentTarget.value)}
      />
    </div>
    <div class="field">
      <label for="ah-pw-confirm">确认新密码</label>
      <input
        id="ah-pw-confirm"
        type="password"
        autocomplete="new-password"
        placeholder="请输入确认密码"
        value={confirmPw}
        oninput={(e) => (confirmPw = e.currentTarget.value)}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
    </div>
  {/snippet}
  {#if open}
    {#if asDrawer}
      <!-- 移动端：全屏右侧抽屉（与「我的→设置」同款形态），带侧滑关闭手势。
           busy 时在 props 层关掉全部关闭路径（理由见文件头「提交中的关闭策略」）。 -->
      <AhDrawer
        open={open}
        placement="right"
        title="修改密码"
        size="100vw"
        fullscreen={true}
        maskClosable={!busy}
        escClosable={!busy}
        showClose={!busy}
        swipeToClose={!busy}
        onclose={() => close()}
        showFooter={true}
      >
        {@render fields()}
        {#snippet footer()}
          <button
            type="button"
            class="btn ghost"
            onclick={() => close()}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            class="btn primary"
            onclick={() => submit()}
            disabled={busy}
          >
            {busy ? '提交中…' : '修改'}
          </button>
        {/snippet}
      </AhDrawer>
    {:else}
      <div
        class="pw-scrim"
        role="button"
        tabindex="-1"
        aria-label="关闭"
        onclick={(e: MouseEvent) => {
          if (e.target === e.currentTarget) close();
        }}
        onkeydown={(e: KeyboardEvent) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            close();
          }
        }}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label="修改密码">
          <div class="head">
            <span class="title">修改密码</span>
            <button
              class="close"
              title="关闭"
              aria-label="关闭"
              onclick={() => close()}
            >
              ×
            </button>
          </div>
          <div class="body">
            {@render fields()}
          </div>
          <div class="foot">
            <button
              class="btn ghost"
              onclick={() => close()}
              disabled={busy}
            >
              取消
            </button>
            <button
              class="btn primary"
              onclick={() => submit()}
              disabled={busy}
            >
              {busy ? '提交中…' : '修改'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* 原 :host { display: contents } → 根壳（不产生盒子） */
  .pw-root {
    display: contents;
  }

  /* ⚠️ 类名刻意不叫 .scrim：全局样式（styles/mobile-drawer.ts）有
     `.scrim { opacity: 0; display: none; z-index: 40; background: rgba(0,0,0,.45) }`
     这条给应用壳抽屉遮罩用的规则 —— Svelte 迁移后无 Shadow DOM，同名类会直接
     命中本模态遮罩：opacity 未被组件自有规则覆盖（ Lit 时代 shadow 边界天然隔离），
     表现为「DOM 在、画面全无」（实测 computed opacity:0，整块模态含 panel 一起隐身）。
     故本组件遮罩统一前缀 pw-，与全局规则零碰撞。 */
  .pw-scrim {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    animation: ahpd-fade 0.16s ease;
  }
  @keyframes ahpd-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .panel {
    width: min(calc(100vw - 32px), 420px);
    background: var(--ah-surface-1);
    color: var(--ah-text);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-lg);
    box-shadow: var(--ah-shadow);
    overflow: hidden;
    animation: ahpd-pop 0.16s cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  @keyframes ahpd-pop {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pw-scrim,
    .panel {
      animation: none;
    }
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 18px 0;
  }
  .title {
    font-family: var(--ah-font-display);
    font-weight: 600;
    font-size: 15px;
  }
  .close {
    margin-left: auto;
    border: none;
    background: none;
    color: var(--ah-text-faint);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: var(--ah-radius-sm);
  }
  .close:hover {
    color: var(--ah-text);
    background: var(--ah-surface-2);
  }
  .body {
    padding: 12px 18px 4px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .field label {
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  .field input {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 12px;
    font-size: 14px;
    font-family: var(--ah-font-sans);
    color: var(--ah-text);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    border-radius: var(--ah-radius-md);
    outline: none;
  }
  .field input:focus {
    border-color: var(--ah-accent);
    box-shadow: 0 0 0 3px var(--ah-accent-soft);
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 16px 18px 18px;
  }
  .btn {
    min-width: 76px;
    padding: 8px 16px;
    font-size: 13px;
    font-family: var(--ah-font-sans);
    cursor: pointer;
    border-radius: var(--ah-radius-md);
    border: 1px solid var(--ah-border);
    transition: background 120ms ease, border-color 120ms ease,
      color 120ms ease;
  }
  .btn.ghost {
    background: transparent;
    color: var(--ah-text-muted);
  }
  .btn.ghost:hover {
    color: var(--ah-text);
    border-color: var(--ah-text-faint);
  }
  .btn.primary {
    background: var(--ah-accent);
    border-color: var(--ah-accent);
    color: #fff;
    font-weight: 600;
  }
  .btn.primary:hover {
    background: var(--ah-accent-strong);
    border-color: var(--ah-accent-strong);
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .btn:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 2px;
  }
</style>
