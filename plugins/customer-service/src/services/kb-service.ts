/**
 * 知识库服务：检索 / 插入。
 */
import { searchKb, insertKb, type KbRow } from '../repo/kb-repo';

/** 检索知识库（词面匹配，返回命中条目）。 */
export function search(input: { query: string; limit?: number }): KbRow[] {
  return searchKb(input.query, input.limit ?? 5);
}

/** 插入知识条目（运营经导入接口写入）。 */
export function add(input: { question: string; answer: string; category?: string }): KbRow {
  return insertKb(input);
}
