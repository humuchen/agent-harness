/**
 * <ah-brand-foot> — 品牌页脚组件 (P3-1)。
 *
 * 渲染可配置的页脚品牌位。读取全局 BRAND 配置（由主应用在启动时通过
 * initBrand() 拉取并写入 CSS 变量），支持企业白标。
 */
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BRAND_DEFAULT, type BrandConfig } from './theme/tokens';

@customElement('ah-brand-foot')
export class AhBrandFoot extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: var(--ah-radius-md, 12px);
      text-align: center;
      font-size: 12px;
      color: var(--ah-text-faint, #5d6675);
    }
    .foot {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .product {
      font-weight: 600;
      color: var(--ah-text, #e6edf3);
    }
  `;

  @state()
  private brand: BrandConfig = BRAND_DEFAULT;

  connectedCallback() {
    super.connectedCallback();
    // 尝试从全局变量读取品牌配置
    const globalBrand = (globalThis as unknown as { BRAND?: BrandConfig }).BRAND;
    if (globalBrand) {
      this.brand = globalBrand;
    }
  }

  render() {
    const year = new Date().getFullYear();
    return html`
      <div class="foot">
        <span class="product">${this.brand.productName}</span>
        <span>© ${year} · ${this.brand.footer ?? BRAND_DEFAULT.footer}</span>
      </div>
    `;
  }
}

export default AhBrandFoot;
