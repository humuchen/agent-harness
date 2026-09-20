/**
 * 对客触达话术模板（B4/B5 子集）。
 *
 * 合规内建（与 medical-ad-guard 同一口径，模板层面直接规避）：
 * - 不承诺疗效/安全性（无「保证/100%/绝对」类用语）；
 * - 不做诊断、不提术前术后对比、不报固定价；
 * - 每条消息附风险提示（医疗广告合规硬要求）。
 *
 * 模板为静态文案 + 线索字段占位（项目名/称呼），不含任何 LLM 生成内容，
 * 因此不引入幻觉风险；生日/复购等运营自拟文案走 scheduleManualJob 的合规筛查入口。
 */

/** 风险提示（每条对客消息末尾必附）。 */
export const RISK_HINT = '医疗美容有风险，最终以面诊方案为准。';

/** 清洗占位符：去首尾空白 + 截断，避免把超长字段拼进对客文案。 */
function clean(s: string | undefined, max = 24): string {
  const t = String(s ?? '').trim();
  return t ? t.slice(0, max) : '';
}

/** 欢迎语（加好友/首次进线）。 */
export function buildWelcomeText(name?: string, project?: string): string {
  const who = clean(name);
  const proj = clean(project);
  const head = who ? `${who}您好` : '您好';
  const mid = proj ? `，关于「${proj}」` : '';
  return `${head}，感谢您的咨询${mid}。您可以继续提问，也可以回复「预约」，我来帮您安排线下面诊。${RISK_HINT}`;
}

/** 沉默回捞（node='first' 对应 2h，'second' 对应 24h）。 */
export function buildRecallText(node: 'first' | 'second', name?: string, project?: string): string {
  const who = clean(name);
  const proj = clean(project);
  const head = who ? `${who}您好` : '您好';
  if (node === 'first') {
    return `${head}，刚才的咨询还在继续吗？如需了解适合您的方案或预约面诊，随时回复我。${RISK_HINT}`;
  }
  const mid = proj ? `日前您咨询过「${proj}」` : '日前您咨询过相关项目';
  return `${head}，${mid}。如近期有意向，可以回复我，帮您协调面诊时间。${RISK_HINT}`;
}
