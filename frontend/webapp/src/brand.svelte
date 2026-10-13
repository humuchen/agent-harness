<script lang="ts">
  /**
   * 品牌页脚组件（Svelte 5 迁移版，原 <ah-brand-foot>，P3-1）。
   *
   * 渲染可配置的页脚品牌位。读取全局 BRAND 配置（由主应用在启动时通过
   * initBrand() 拉取并写入 CSS 变量），支持企业白标。
   */
  import { onMount } from 'svelte';
  import { BRAND_DEFAULT, type BrandConfig } from './theme/tokens';

  let brand: BrandConfig = $state(BRAND_DEFAULT);

  // 尝试从全局变量读取品牌配置
  onMount(() => {
    const globalBrand = (globalThis as unknown as { BRAND?: BrandConfig })
      .BRAND;
    if (globalBrand) {
      brand = globalBrand;
    }
  });
</script>

<div class="brand-foot-root">
  <div class="foot">
    <span class="product">{brand.productName}</span>
    <span>© {new Date().getFullYear()} · {brand.footer ?? BRAND_DEFAULT.footer}</span>
  </div>
</div>

<style>
  .brand-foot-root {
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
</style>
