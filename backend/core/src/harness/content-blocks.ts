/**
 * 用户消息内容构造（P1-2：从 harness.ts 拆出）。
 *
 * 职责：把「用户输入 + 可选图片附件」构造为 Message.content 可接受的
 * 纯文本或多模态 ContentBlock[]。
 *
 * 纯函数：不做任何 memory 写入（由调用方 memory.add 消费返回值）。
 *
 * 行为契约（与拆分前逐字一致）：
 *   - 有图片附件时：text 块取 userInput（注意：不是指代消解后的 resolvedInput，
 *     这是既有行为，多模态路径不消费消解结果）；
 *   - 无图片附件时：返回 resolvedInput（指代消解后的纯文本）；
 *   - 超大 base64 原图（>1.5MB）强制 detail:'low'，由模型端降采样，
 *     覆盖前端压缩被绕过的入口（subagent / workflow / 直接构造 attachments 等）。
 */
import type { ContentBlock } from '../types';

/** 图片附件（调用方透传的服务端附件结构）。 */
export interface ImageAttachment {
  url: string;
  name: string;
  type: string;
}

/**
 * 构造用户消息内容：有图片时返回 ContentBlock[]，否则返回纯文本。
 * @param userInput 原始用户输入（多模态 text 块来源）
 * @param resolvedInput 指代消解后的输入（纯文本路径来源）
 * @param imageAttachments 可选图片附件
 */
export function buildUserContent(
  userInput: string,
  resolvedInput: string,
  imageAttachments?: ImageAttachment[]
): string | ContentBlock[] {
  // 图片附件：转为 ContentBlock[] 传给 LLM；无图片时退化为纯文本。
  if (imageAttachments && imageAttachments.length > 0) {
    // 零依赖兜底：对超大 base64 原图强制 detail:'low'，由模型端降采样到 512px，
    // 覆盖前端压缩被绕过的入口（subagent / workflow / 直接构造 attachments 等）。
    // 仅体积超限的图受影响，经前端压缩后的图保持原有质量。
    const forceLowDetail = (url: string): boolean => {
      if (!url.startsWith('data:image/')) return false;
      const approx = Math.ceil(((url.split(',')[1] ?? '').length * 3) / 4);
      return approx > 1.5 * 1024 * 1024;
    };
    const contentBlocks: ContentBlock[] = [];
    if (userInput) contentBlocks.push({ type: 'text', text: userInput });
    for (const img of imageAttachments) {
      const url = img.url;
      const detail = forceLowDetail(url) ? ('low' as const) : undefined;
      contentBlocks.push(
        detail
          ? { type: 'image_url', image_url: { url, detail } }
          : { type: 'image_url', image_url: { url } }
      );
    }
    return contentBlocks;
  }
  return resolvedInput;
}
