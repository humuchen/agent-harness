/**
 * 技能管理（ah-skills，P2-Skills）。
 *
 * 枚举企业 Agent 平台的技能目录，支持一键启停技能。
 * 数据来自后端 skill-registry.ts，端点：
 *   GET  /api/skills                   → { items: SkillDef[] }
 *   POST /api/skills/:id/enable        → 启用
 *   POST /api/skills/:id/disable       → 禁用
 * 组件本地定义 SkillDef 类型，绝不 import 服务端内部模块。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authedFetch } from './api';
import { sharedStyles } from './styles';

/** 与 access/server/src/skill-registry.ts 的 SkillDef 保持一致（前端本地定义，不跨层 import）。 */
export interface SkillDef {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: string;
}

interface SkillsPayload {
  items: SkillDef[];
}

@customElement('ah-skills')
export class AhSkills extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 14px;
      }
      .skill {
        background: var(--ah-surface-1);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .skill .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .skill .name {
        font-weight: 600;
        font-size: 15px;
      }
      .skill .desc {
        color: var(--ah-text-muted);
        font-size: 12.5px;
        line-height: 1.5;
        min-height: 38px;
      }
      .skill .foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .chip {
        font-size: 11px;
        padding: 1px 8px;
        border-radius: var(--ah-radius-pill);
        font-family: var(--ah-font-mono);
        background: var(--ah-surface-3);
        border: 1px solid var(--ah-border);
        color: var(--ah-text-muted);
      }
      .chip.ok {
        color: var(--ah-success);
        background: var(--ah-success-soft);
        border-color: transparent;
      }
      button.toggle {
        background: var(--ah-surface-2);
        border: 1px solid var(--ah-border);
        color: var(--ah-text-muted);
        border-radius: var(--ah-radius-pill);
        padding: 6px 16px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
      }
      button.toggle.on {
        background: var(--ah-success-soft);
        color: var(--ah-success);
        border-color: transparent;
      }
      button.toggle.off {
        background: var(--ah-surface-2);
        color: var(--ah-text-muted);
      }
      button.toggle:hover {
        border-color: var(--ah-accent);
        color: var(--ah-text);
      }
      .empty {
        padding: 28px 0;
        text-align: center;
        color: var(--ah-text-muted);
      }
    `,
  ];

  @state() items: SkillDef[] = [];
  @state() loading = true;
  @state() busy = new Set<string>();

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    try {
      const res = await authedFetch('/api/skills');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SkillsPayload;
      this.items = Array.isArray(data.items) ? data.items : [];
    } catch {
      this.items = [];
    } finally {
      this.loading = false;
    }
  }

  private async toggle(skill: SkillDef): Promise<void> {
    const nextEnabled = !skill.enabled;
    const action = nextEnabled ? 'enable' : 'disable';
    const s = new Set(this.busy);
    s.add(skill.id);
    this.busy = s;
    try {
      const res = await authedFetch(`/api/skills/${encodeURIComponent(skill.id)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.refresh();
    } catch {
      // 失败时静默保留原状态，下次刷新仍可重试。
    } finally {
      const s2 = new Set(this.busy);
      s2.delete(skill.id);
      this.busy = s2;
    }
  }

  private renderSkill(skill: SkillDef): unknown {
    const isOn = skill.enabled;
    const isBusy = this.busy.has(skill.id);
    return html`
      <div class="skill">
        <div class="head">
          <span class="name">${skill.name}</span>
          <span class="chip ${isOn ? 'ok' : ''}">${skill.source || 'builtin'}</span>
        </div>
        <div class="desc">${skill.description || ''}</div>
        <div class="foot">
          <span class="chip ${isOn ? 'ok' : ''}">${isOn ? '已启用' : '已禁用'}</span>
          <button
            class="toggle ${isOn ? 'on' : 'off'}"
            ?disabled=${isBusy}
            @click=${() => this.toggle(skill)}
          >
            ${isBusy ? '处理中…' : isOn ? '禁用' : '启用'}
          </button>
        </div>
      </div>
    `;
  }

  render() {
    if (this.loading) return html`<div class="muted">加载中…</div>`;
    if (!this.items.length)
      return html`<div class="empty">暂无技能。企业可在此注册并启停自定义技能。</div>`;
    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <div class="section-title" style="margin:0">技能管理</div>
            <div class="muted-sm">启停企业 Agent 平台的技能目录</div>
          </div>
          <button class="ghost" @click=${() => this.refresh()}>刷新</button>
        </div>
        <div class="grid">
          ${this.items.map((s) => this.renderSkill(s))}
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-skills': AhSkills;
  }
}
