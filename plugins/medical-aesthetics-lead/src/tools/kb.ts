import type { ToolRegistry } from '@agent-harness/core';

/** 内置医美项目语料（合规描述：只讲原理/适应症/注意事项，不含疗效承诺与术前术后对比）。 */
interface ProjectItem {
  name: string;
  category: string;
  summary: string;
  faq: string[];
}

const PROJECT_CORPUS: ProjectItem[] = [
  {
    name: '双眼皮/重睑',
    category: '眼整形',
    summary:
      '通过切开或埋线方式形成重睑线。具体术式需面诊结合眼型、皮肤厚度、提肌力量评估后定制，效果因人而异。',
    faq: ['埋线和切开怎么选？', '恢复期一般多久？', '需要拆线吗？'],
  },
  {
    name: '玻尿酸填充',
    category: '微整注射',
    summary:
      '以透明质酸填充凹陷或塑形（如隆鼻、丰唇、泪沟）。属可逆注射类项目，方案需面诊评估，维持时长因产品与个人代谢而异。',
    faq: ['能维持多久？', '会不会移位？', '适合哪些部位？'],
  },
  {
    name: '热玛吉/超声炮',
    category: '抗衰光电',
    summary:
      '以射频/聚焦超声作用于皮肤及筋膜层，改善松弛。属无创抗衰，需由医师评估皮肤状态后制定能量参数，效果逐步显现。',
    faq: ['多久做一次？', '疼不疼？', '适合什么年龄？'],
  },
  {
    name: '光子嫩肤',
    category: '皮肤管理',
    summary:
      '以强脉冲光改善肤色不均、浅表色斑与红血丝。属日常维养类光电，需按肤质制定疗程，术后注意防晒。',
    faq: ['要几次见效？', '术后怎么护理？', '会反黑吗？'],
  },
  {
    name: '吸脂塑形',
    category: '形体雕塑',
    summary:
      '针对局部顽固脂肪进行抽吸塑形。属手术类项目，需面诊评估脂肪厚度与皮肤回弹，并充分告知术前术后注意事项。',
    faq: ['要穿多久塑身衣？', '会皮肤凹凸吗？', '多久能运动？'],
  },
  {
    name: '隆鼻',
    category: '鼻整形',
    summary:
      '通过假体/自体软骨综合塑造鼻部形态。术式与材料需结合面部比例面诊设计，效果因个体基础而异。',
    faq: ['用什么材料好？', '恢复期多久？', '能有多自然？'],
  },
];

/** 关键词打分：项目名权重最高，其次类目，再次正文/FAQ 词。 */
function score(it: ProjectItem, q: string): number {
  const s = q.toLowerCase();
  let n = 0;
  if (it.name.toLowerCase().includes(s)) n += 6;
  if (it.category.toLowerCase().includes(s)) n += 4;
  for (const w of q.split(/\s+/)) {
    if (w && (it.summary.toLowerCase().includes(w) || it.faq.some((f) => f.toLowerCase().includes(w)))) n += 1;
  }
  return n;
}

/**
 * project_kb_search：检索医美项目知识库（合规描述）。
 * 工具名短名，由 loader 自动加 `medical-aesthetics-lead__` 前缀。
 */
export function registerKbTool(tools: ToolRegistry): void {
  tools.register(
    'project_kb_search',
    '检索医美项目知识库（合规描述：只讲原理/适应症/注意事项，不含疗效承诺与术前术后对比）。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户想了解的项目或诉求关键词' },
      },
      required: ['query'],
    },
    async (args: Record<string, unknown>) => {
      const q = String(args.query ?? '').trim();
      if (!q) return { found: false, answer: '请描述你想了解的项目或诉求。' };
      const ranked = PROJECT_CORPUS.map((it) => ({ it, s: score(it, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (!ranked.length) {
        return { found: false, answer: '暂未收录该项目，建议预约面诊由医生结合个人基础评估。' };
      }
      const top = ranked[0].it;
      return {
        found: true,
        project: top.name,
        category: top.category,
        summary: top.summary,
        faq: top.faq,
        more: ranked.slice(1, 4).map((x) => x.it.name),
      };
    }
  );
}
