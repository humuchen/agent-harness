// 记忆装配段（runInner 段 C）：持久化载入 + 系统提示注入 + 用户消息入窗。
// P1#21 自 runInner 迁出，语句顺序与语义逐字等价。
import type { Memory } from '../../memory';
import { buildUserContent } from '../content-blocks';

export interface MemorySetupInput {
  memory: Memory;
  systemPrompt?: string;
  /** 原始用户输入（多模态路径的 text 块取它）。 */
  userInput: string;
  /** 指代消解后的输入（纯文本路径取它）。 */
  resolvedInput: string;
  imageAttachments?: Array<{ url: string; name: string; type: string }>;
}

export async function setupRunMemory(input: MemorySetupInput): Promise<void> {
  const { memory } = input;
  // 若配置了持久化路径，先载入历史记忆（窗口 + 长期笔记）。
  if (memory.hasPersistence) {
    try {
      await memory.load();
    } catch {
      /* 首次运行无存档，忽略 */
    }
  }
  // 将长期记忆注入系统提示词，使模型能看到跨运行的上下文。
  const ctx = memory.systemContext();
  const sysContent =
    ctx && input.systemPrompt
      ? `${input.systemPrompt}\n\n${ctx}`
      : input.systemPrompt;
  if (sysContent && !memory.history().some((m) => m.role === 'system')) {
    memory.add({ role: 'system', content: sysContent });
  }
  // 图片附件：转为 ContentBlock[] 传给 LLM；无图片时退化为纯文本。
  // （构造逻辑在 harness/content-blocks.ts：多模态路径 text 块取 userInput、
  //  纯文本路径取 resolvedInput，与拆分前一致。）
  memory.add({
    role: 'user',
    content: buildUserContent(input.userInput, input.resolvedInput, input.imageAttachments)
  });
}
