import { objectParams, ToolRegistry } from '../tools';

/**
 * 一个「技能」= 可组合的复合能力包：把一组工具 + 一段执行指引 + 触发词
 * 打包成一个模型可一键选用的能力单元。模型不需要裸调工具，而是先激活技能、
 * 拿到工作流提示，再使用其关联工具解决问题。
 *
 * 技能层完全独立于 Agent 主循环：它只做两件事——把「技能目录」注入系统提示词
 * （让模型知道有哪些能力可用），以及提供一个 builtin__use_skill 元工具（让模型
 * 在运行时激活技能并取回执行指引）。因此护栏 / 记忆 / 追踪对技能及其工具自动覆盖。
 */
export interface Skill {
  /** 唯一标识；模型通过 builtin__use_skill 的 skill 参数引用。 */
  id: string;
  /** 人类可读名称。 */
  title: string;
  /** 何时 / 为何使用该技能（注入系统提示词，供模型判断是否选用）。 */
  description: string;
  /** 触发词：用户消息包含其一即自动预激活（大小写不敏感）。 */
  triggers?: string[];
  /** 该技能依赖的工具名（仅用于提示与展示，不强制门控）。 */
  tools?: string[];
  /** 激活时注入给模型的执行指引 / 工作流。缺省回退到 description。 */
  prompt?: string;
  /** 是否启用；默认 true。 */
  enabled?: boolean;
}

/** 技能注册表：注册 / 查询 / 触发匹配 / 生成提示词段落。 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (!skill || !skill.id) throw new Error('Skill 必须包含非空 id');
    this.skills.set(skill.id, { enabled: true, ...skill });
  }

  registerMany(list: Skill[]): void {
    for (const s of list) this.register(s);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  enabledList(): Skill[] {
    return this.list().filter((s) => s.enabled !== false);
  }

  /** 根据用户消息匹配触发词，返回命中的已启用技能（去重、保序）。 */
  matchTriggers(text: string): Skill[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const out: Skill[] = [];
    const seen = new Set<string>();
    for (const s of this.enabledList()) {
      const hit = (s.triggers ?? []).some((t) => lower.includes(t.toLowerCase()));
      if (hit && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
    }
    return out;
  }

  /** 生成注入系统提示词的「可用技能」清单段落；无技能时返回空串。
   * @param compact 为 true 时仅输出一行桩（id 列表），用于问候/寒暄等
   *   明显不需要技能的输入，避免把 4+ 个技能说明无谓塞进系统提示。 */
  describeForPrompt(compact = false): string {
    const list = this.enabledList();
    if (!list.length) return '';
    if (compact) {
      const ids = list.map((s) => s.id).join(' / ');
      return `可用技能：${ids}（涉及对应需求时自动激活，无需主动声明）。`;
    }
    const lines = list.map((s) => {
      const toolLine = s.tools && s.tools.length ? `（关联工具：${s.tools.join('、')}）` : '';
      return `- ${s.id}：${s.description}${toolLine}`;
    });
    return (
      '## 可用技能（Skills）\n' +
      '当任务适合时，先调用 builtin__use_skill 激活对应技能以获取执行指引，再使用其关联工具。\n' +
      lines.join('\n')
    );
  }

  /** 输入是否命中任一已启用技能的触发词（用于按需注入完整技能目录）。 */
  hasTriggerMatch(input: string): boolean {
    if (!input) return false;
    return this.matchTriggers(input).length > 0;
  }
}

/** 默认技能集：把基础工具打包成模型可一键选用的复合能力。 */
export function defaultSkills(): Skill[] {
  return [
    {
      id: 'web-research',
      title: '联网检索',
      description: '需要获取最新 / 外部网页信息、查证事实、读取在线文档时使用。',
      triggers: ['搜索', '查一下', '最新', '官网', '网页', 'fetch', 'search', '查资料', '天气', '新闻', '资讯', '未来几天', '未来', '情况'],
      tools: ['builtin__web_fetch'],
      prompt:
        '执行联网检索：先用 builtin__web_fetch 抓取相关页面，提炼与用户问题直接相关的事实，' +
        '并标注信息来源 URL。若一次抓取不够，可多抓几个来源交叉验证。',
    },
    {
      id: 'math',
      title: '精确计算',
      description: '涉及算术、公式、单位换算、统计等需要精确数值时使用，避免心算误差。',
      triggers: ['算', '计算', '多少', '百分比', 'compute', 'calculate', 'sqrt', '面积', '总和'],
      tools: ['builtin__calculator'],
      prompt:
        '执行精确计算：把待算表达式整理为 builtin__calculator 支持的数学式（支持 + - * / % ^、' +
        '括号、pi/e、sqrt/abs/.../pow 等），调用工具得到精确结果。复杂分步时逐步计算。',
    },
    {
      id: 'files',
      title: '本地文件操作',
      description: '需要读取、浏览或搜索本地项目文件时使用。',
      triggers: ['读文件', '看文件', '搜索文件', '目录', '代码里', '源码', 'file', 'read'],
      tools: ['builtin__fs_read', 'builtin__fs_list', 'builtin__fs_search'],
      prompt:
        '执行本地文件操作：先用 builtin__fs_list 浏览目录、builtin__fs_search 按关键词检索，' +
        '定位后再用 builtin__fs_read 读取内容。所有路径都限定在沙箱根目录内。',
    },
    {
      id: 'current-time',
      title: '当前时间与时区',
      description: '需要“现在几点”、时区换算、相对时间（如“3 小时后”）时使用。',
      triggers: ['现在几点', '时间', '时区', '几点', '日期', 'time', 'now', '倒计时'],
      tools: ['builtin__datetime_now', 'builtin__datetime_convert', 'builtin__datetime_add'],
      prompt:
        '处理时间问题：用 builtin__datetime_now 获取当前时间，builtin__datetime_convert 做时区换算，' +
        'builtin__datetime_add 计算相对时间。始终基于真实当前时间作答。',
    },
  ];
}

/**
 * 注册 builtin__use_skill 元工具：模型调用它以激活技能并取回执行指引，
 * 从而按既定流程自动解决问题。找不到技能时返回可用清单，便于模型自愈。
 */
export function registerSkillTools(tools: ToolRegistry, registry: SkillRegistry): void {
  tools.register(
    'builtin__use_skill',
    '激活一个「技能」（复合能力包）。传入 skill id，返回该技能的执行指引与建议配合使用的工具，' +
      '让模型按既定流程自动解决问题。可用技能见系统提示词中的「可用技能」清单。',
    objectParams(
      {
        skill: {
          type: 'string',
          description: '技能 id，例如 web-research / math / files / current-time。',
        },
      },
      ['skill']
    ),
    async (args: Record<string, unknown>) => {
      const id = String(args.skill ?? '').trim();
      const s = registry.get(id);
      if (!s || s.enabled === false) {
        const ids = registry.enabledList().map((x) => x.id).join(', ');
        return `未找到已启用技能 "${id}"。可用技能：${ids || '（无）'}`;
      }
      const toolHint =
        s.tools && s.tools.length ? `\n建议配合使用的工具：${s.tools.join('、')}。` : '';
      return `已激活技能「${s.title}」。\n${s.prompt ?? s.description}${toolHint}`;
    },
    'builtin'
  );
}

/** 根据触发词自动预激活技能，生成应追加进系统提示词的段落；无命中返回空串。 */
export function skillBoostPrompt(text: string, registry: SkillRegistry): string {
  const matched = registry.matchTriggers(text);
  if (!matched.length) return '';
  const blocks = matched.map(
    (s) => `### 已自动启用技能：${s.title}\n${s.prompt ?? s.description}`
  );
  return '## 自动启用的技能\n' + blocks.join('\n\n');
}
