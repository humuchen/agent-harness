/**
 * plugin-kit：三业务插件（customer-service / medical-aesthetics-lead / memo）共享的
 * 基础设施原语（P1#25 抽取）。此前约 30% 的 infra 代码在三插件间复制粘贴且语义漂移：
 * HTML 转义 ma 版漏单引号（XSS 缺口）、readBody 上限 1MB/无上限不一、错误归一三套、
 * 令牌比较一处非常量时间。本模块把安全基线收敛到一处，避免「修了 ma 漏了 cs」。
 *
 * 约定：本目录只放「无业务语义」的纯原语；领域错误体系（如 ma 的 MaError）留在插件内。
 */

/**
 * HTML 转义（看板/视图服务端渲染用）：转义 & < > " ' 五个实体。
 * 单引号必须转义——模板属性若出现单引号包裹（如 title='...'），漏转义即成 XSS 注入点。
 */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}
