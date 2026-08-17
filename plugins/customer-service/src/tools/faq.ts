import type { ToolRegistry } from '@agent-harness/core';
import { recordIntent } from '../store';

/** 演示 FAQ 语料（生产应替换为检索服务 / 向量库）。 */
interface FaqItem {
  q: string;
  a: string;
  tags: string[];
}

const FAQ_CORPUS: FaqItem[] = [
  {
    q: '如何申请退款？',
    a: '在「我的订单」中选择对应订单，点击「申请退款」，填写原因后提交；审核通常 1-3 个工作日完成。',
    tags: ['退款', 'refund'],
  },
  {
    q: '退款多久到账？',
    a: '退款审核通过后原路退回：微信 / 支付宝约 1-3 天，银行卡约 3-7 个工作日。',
    tags: ['退款'],
  },
  {
    q: '怎么查询订单物流？',
    a: '进入「我的订单」→ 对应订单 →「查看物流」即可看到实时轨迹；也可凭运单号在快递官网查询。',
    tags: ['查询订单', '物流', 'logistics'],
  },
  {
    q: '支持哪些登录方式？',
    a: '支持手机号验证码、微信、Apple ID 登录；企业版还支持 SSO 单点登录。',
    tags: ['技术支持', '登录', 'login'],
  },
  {
    q: '忘记密码怎么办？',
    a: '登录页点击「忘记密码」，通过注册手机号接收验证码重置；如手机号已停用请联系人工客服。',
    tags: ['技术支持', '密码', 'password'],
  },
];

/** 关键词打分：标题命中权重最高，其次标签，再次正文词。 */
function score(item: FaqItem, query: string): number {
  const q = query.toLowerCase();
  let s = 0;
  if (item.q.toLowerCase().includes(q)) s += 5;
  for (const t of item.tags) if (q.includes(t.toLowerCase())) s += 3;
  for (const w of q.split(/\s+/)) if (w && item.a.toLowerCase().includes(w)) s += 1;
  return s;
}

/** FAQ 标签 → 业务意图映射（用于管理后台意图分布统计）。 */
function tagToIntent(tags: string[]): string {
  const joined = tags.join(' ').toLowerCase();
  if (joined.includes('refund')) return '退款';
  if (joined.includes('logistics') || joined.includes('物流')) return '查询订单';
  if (joined.includes('login') || joined.includes('登录') || joined.includes('password') || joined.includes('密码')) return '技术支持';
  return '其它';
}

/**
 * 注册 FAQ 检索工具。工具名用短名 `faq_search`，loader 启用时会自动加 `customer-service__` 前缀
 * 合并进进程共享插件工具表，server 的 assembleAgent 再把它并运行，模型即可调用。
 */
export function registerFaqTool(tools: ToolRegistry): void {
  tools.register(
    'faq_search',
    '检索 FAQ 知识库，返回与用户问题最相关的标准答案（产品政策 / 常见问题）。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户的问题或关键词' },
        sessionId: { type: 'string', description: '可选：当前会话 id，用于把命中意图记入管理后台统计' },
      },
      required: ['query'],
    },
    async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '').trim();
      const sessionId = String(args.sessionId ?? '').trim();
      if (!query) return { found: false, answer: '请提供要检索的问题。' };
      const ranked = FAQ_CORPUS.map((it) => ({ it, s: score(it, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (!ranked.length) {
        if (sessionId) recordIntent(sessionId, '未知/未命中');
        return { found: false, answer: '知识库未找到相关条目，建议转人工。' };
      }
      if (sessionId) recordIntent(sessionId, tagToIntent(ranked[0].it.tags));
      return { found: true, answer: ranked[0].it.a, question: ranked[0].it.q };
    }
  );
}
