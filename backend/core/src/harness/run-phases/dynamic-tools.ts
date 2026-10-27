// 动态工具选择（默认开启，DYNAMIC_TOOLS=false 关闭）：按当前用户输入的相关性
// 从全量工具中选出子集，降低简单输入首呼时全量工具 schema 的固定开销。
// 执行仍走全量注册表，仅「发送给 LLM 的 schema」做裁剪。P1#21 自 runInner 迁出，逐字等价。
import type { ToolSchema } from '../../types';
import { selectToolsForInput } from '../../tools';
import type { StepToolsSelection } from '../run-context';

export interface DynamicToolsInput {
  allSchemas: ToolSchema[];
  /** 当前记忆历史（取最近一条 user 消息内容做相关性匹配）。 */
  messages: Array<{ role: string; content?: unknown }>;
  /** 本 run 已实际调用过的工具名（并入硬允许集，保证多步任务可复用）。 */
  usedTools: Set<string>;
  /** opts.allowTools（调用方声明的硬允许集）。 */
  allowTools?: string[];
}

export function selectStepTools(input: DynamicToolsInput): StepToolsSelection {
  const { allSchemas, messages, usedTools, allowTools } = input;
  let stepTools = allSchemas;
  const dynamicOn = process.env.DYNAMIC_TOOLS !== 'false';
  if (dynamicOn && allSchemas.length > 0) {
    const latestUser = [...messages]
      .reverse()
      .find((m) => m.role === 'user');
    const inputText =
      typeof latestUser?.content === 'string' ? latestUser.content : '';
    const topK = Number(process.env.DYNAMIC_TOOL_TOPK ?? 8) || 8;
    // 把本 run 已用过的工具并入硬允许，保证多步任务后续步骤仍可调用。
    const allow = new Set(allowTools ?? []);
    for (const t of usedTools) allow.add(t);
    const subset = selectToolsForInput(allSchemas, inputText, {
      allowTools: [...allow],
      topK
    });
    // 首轮发「相关性子集」而非全量：动态工具选择的核心收益。
    // 此前用 looksLikeTask（正则含几乎所有中文疑问词）判断回退全量，导致任何真实
    // 问答都发全量 schema，问候/寒暄之外的优化形同虚设——用户实测简单问答「工具」
    // 项高达 ~12968 tok，其中 ~92% 来自 MCP 工具的大 schema（内置工具仅 ~1151 tok）。
    // 安全网：若子集为空（输入与任何工具描述零关键词重叠），且输入不像问候/空，
    // 则回退全量——避免「模型看不到任何工具」导致真实任务彻底丧失工具能力；
    // 纯问候/空输入保持空子集（本就不需要工具）。已用过的工具（usedTools）恒在
    // allow 中，故子集不会为空，不会触发此回退。
    let chosen = subset;
    if (subset.length === 0) {
      const isGreeting =
        /^你好|^hello|^hi|^嗨|good.?morning|good.?afternoon|good.?evening|^\s*$/i.test(
          inputText
        );
      if (!isGreeting) chosen = allSchemas;
    }
    stepTools = chosen;
  }
  return { tools: stepTools, dynamicOn };
}
