/**
 * 合规审计视图（ah-audit）。
 *
 * 补齐「审计写入已就绪、读取侧缺失」的缺口：管理员可回答
 * 「谁在什么时间做了什么、谁审批了谁、有没有越权拦截」。
 *
 * 数据源：`GET /api/audit`（读 AUDIT_LOG 落盘的 append-only JSONL，见 audit-query.ts）。
 * 支持 actor / action / outcome / 时间范围 / 自由文本过滤 + 分页。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authedFetch } from './api';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';

interface AuditEvent {
  ts?: string;
  tenantId?: string | null;
  actor?: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied' | 'info';
  target?: string;
  detail?: Record<string, unknown>;
}
interface AuditResult {
  count: number;
  total: number;
  events: AuditEvent[];
  summary: {
    byOutcome: Record<string, number>;
    topActions: Array<{ action: string; count: number }>;
    actors: number;
    window?: { from: string; to: string };
  };
  file: string | null;
  truncatedLines: number;
}

const PAGE = 50;

function fmtTime(ts?: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('zh-CN', { hour12: false });
}

const OUTCOME_LABEL: Record<string, string> = {
  success: '成功',
  failure: '失败',
  denied: '拒绝',
  info: '信息'
};

@customElement('ah-audit')
export class AhAudit extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 12px;
      }
      .filter-bar input,
      .filter-bar select {
        padding: 6px 10px;
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-sm);
        background: transparent;
        color: var(--ah-text);
        font: inherit;
        font-size: 13px;
        min-width: 120px;
      }
      .filter-bar input.grow {
        flex: 1;
        min-width: 180px;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 12px;
        font-size: 13px;
        color: var(--ah-text-muted);
      }
      .mono {
        font-family: var(--ah-font-mono);
        font-size: 12px;
      }
      .warn-banner {
        border: 1px solid var(--ah-warning);
        background: var(--ah-warning-soft);
        color: var(--ah-text);
        border-radius: var(--ah-radius-md);
        padding: 10px 12px;
        font-size: 13px;
        margin-bottom: 12px;
      }
    `,
  ];

  @state() data: AuditResult | null = null;
  @state() loading = true;
  @state() offset = 0;
  @state() fActor = '';
  @state() fAction = '';
  @state() fOutcome = '';
  @state() fQ = '';

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    try {
      const qs = new URLSearchParams();
      qs.set('limit', String(PAGE));
      qs.set('offset', String(this.offset));
      if (this.fActor.trim()) qs.set('actor', this.fActor.trim());
      if (this.fAction.trim()) qs.set('action', this.fAction.trim());
      if (this.fOutcome) qs.set('outcome', this.fOutcome);
      if (this.fQ.trim()) qs.set('q', this.fQ.trim());
      const res = await authedFetch(`/api/audit?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = (await res.json()) as AuditResult;
    } catch (e: any) {
      notifyError(e, { title: '合规审计', key: 'audit' });
    } finally {
      this.loading = false;
    }
  }

  /** 过滤条件变更：回到第一页再查。 */
  private applyFilters(): void {
    this.offset = 0;
    void this.refresh();
  }

  private outcomeClass(o: string): string {
    if (o === 'denied' || o === 'failure') return 'warn';
    if (o === 'success') return 'ok';
    return '';
  }

  render() {
    const d = this.data;
    const total = d?.total ?? 0;
    const denied = d?.summary.byOutcome.denied ?? 0;
    const failure = d?.summary.byOutcome.failure ?? 0;
    const actors = d?.summary.actors ?? 0;
    const canPrev = this.offset > 0;
    const canNext = this.offset + PAGE < total;

    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <div class="section-title" style="margin:0">合规审计</div>
            <div class="muted-sm">
              谁在何时做了什么 · 谁审批了谁 · 越权拦截记录
              ${d?.file ? html`· 源文件 <span class="mono">${d.file}</span>` : nothing}
            </div>
          </div>
          <button class="ghost" @click=${() => this.refresh()}>
            ${this.loading ? '加载中…' : '刷新'}
          </button>
        </div>

        ${d && !d.file
          ? html`<div class="warn-banner">
              审计日志未落盘：未配置 <code>AUDIT_LOG</code>，或文件尚未产生。
              配置后此处将显示完整审计时间线（鉴权 / 审批 / 敏感动作 / 配额拒绝）。
            </div>`
          : nothing}
        ${d && d.truncatedLines > 0
          ? html`<div class="warn-banner">
              审计文件较大，已忽略更早的 ${d.truncatedLines} 行（仅展示最新窗口）。
            </div>`
          : nothing}

        <div class="cards">
          <div class="kpi"><div class="v">${total}</div><div class="k">命中事件</div></div>
          <div class="kpi"><div class="v ${denied ? 'warn' : 'ok'}">${denied}</div><div class="k">越权/拒绝</div></div>
          <div class="kpi"><div class="v ${failure ? 'warn' : 'ok'}">${failure}</div><div class="k">失败</div></div>
          <div class="kpi"><div class="v accent">${actors}</div><div class="k">参与主体</div></div>
        </div>

        <div class="filter-bar">
          <input
            placeholder="主体（actor）"
            .value=${this.fActor}
            @input=${(e: any) => (this.fActor = e.target.value)}
            @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.applyFilters()}
          />
          <input
            placeholder="动作（如 agent.run）"
            .value=${this.fAction}
            @input=${(e: any) => (this.fAction = e.target.value)}
            @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.applyFilters()}
          />
          <select @change=${(e: any) => (this.fOutcome = e.target.value)}>
            <option value="">全部结果</option>
            <option value="success">成功</option>
            <option value="failure">失败</option>
            <option value="denied">拒绝</option>
            <option value="info">信息</option>
          </select>
          <input
            class="grow"
            placeholder="自由文本（动作 / 主体 / 目标 / 详情）"
            .value=${this.fQ}
            @input=${(e: any) => (this.fQ = e.target.value)}
            @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.applyFilters()}
          />
          <button class="ghost" @click=${() => this.applyFilters()}>查询</button>
          <button
            class="ghost"
            @click=${() => {
              this.fActor = '';
              this.fAction = '';
              this.fOutcome = '';
              this.fQ = '';
              this.applyFilters();
            }}
          >
            重置
          </button>
        </div>

        <section>
          <div class="panel-scroll">
            <table class="matrix">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>主体</th>
                  <th>动作</th>
                  <th>结果</th>
                  <th>目标</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                ${(d?.events ?? []).map(
                  (e) => html`
                    <tr>
                      <td class="meta">${fmtTime(e.ts)}</td>
                      <td class="act">${e.actor ?? '—'}</td>
                      <td class="mono">${e.action}</td>
                      <td>
                        <span class="pill ${this.outcomeClass(e.outcome)}">
                          ${OUTCOME_LABEL[e.outcome] ?? e.outcome}
                        </span>
                      </td>
                      <td class="meta">${e.target ?? '—'}</td>
                      <td class="meta mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        ${e.detail ? JSON.stringify(e.detail) : '—'}
                      </td>
                    </tr>
                  `
                )}
                ${(d?.events ?? []).length === 0
                  ? html`<tr>
                      <td colspan="6" class="muted">
                        ${this.loading ? '加载中…' : '无匹配审计记录'}
                      </td>
                    </tr>`
                  : nothing}
              </tbody>
            </table>
          </div>
          <div class="pager">
            <span>共 ${total} 条 · 第 ${Math.floor(this.offset / PAGE) + 1} 页</span>
            <button class="ghost" ?disabled=${!canPrev} @click=${() => { this.offset = Math.max(0, this.offset - PAGE); void this.refresh(); }}>
              上一页
            </button>
            <button class="ghost" ?disabled=${!canNext} @click=${() => { this.offset += PAGE; void this.refresh(); }}>
              下一页
            </button>
          </div>
        </section>
      </section>
    `;
  }
}
