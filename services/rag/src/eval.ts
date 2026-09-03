/**
 * RAG 评估体系（P0）：检索质量 + 生成质量的自动化评估。
 *
 * 评估维度：
 * 1. Retrieval Recall@K：检索结果中 ground truth chunk 的覆盖率
 * 2. Retrieval Precision@K：检索结果中相关 chunk 的比例
 * 3. NDCG@K：排序质量（位置加权）
 * 4. Faithfulness：生成内容是否基于检索结果（无幻觉）
 * 5. Answer Correctness：生成答案与 ground truth 的语义相似度
 *
 * 使用方式：
 * - 单元测试：直接调用 evaluator 函数
 * - CLI：`node scripts/rag-eval.cjs --dataset <path>`
 * - CI：集成到测试流程
 */

import type { RetrieveResult } from './store';
import { tokenize } from './embed';

// ---------------------------------------------------------------------------
// 评估数据集格式
// ---------------------------------------------------------------------------

export interface EvalSample {
  /** 查询文本 */
  query: string;
  /** 期望的 ground truth chunk IDs（用于 recall 计算） */
  groundTruthChunkIds?: string[];
  /** 期望的 ground truth 答案（用于 correctness 计算） */
  groundTruthAnswer?: string;
  /** 生成的答案（用于 faithfulness/correctness 计算） */
  generatedAnswer?: string;
  /** 元数据标签（用于分组统计） */
  tags?: string[];
}

export interface EvalDataset {
  name: string;
  samples: EvalSample[];
}

// ---------------------------------------------------------------------------
// 评估结果格式
// ---------------------------------------------------------------------------

export interface EvalMetric {
  name: string;
  value: number;
  unit: string;
}

export interface EvalResult {
  dataset: string;
  sampleCount: number;
  metrics: EvalMetric[];
  /** 每个 sample 的明细（用于调试） */
  sampleResults?: EvalSampleResult[];
}

export interface EvalSampleResult {
  query: string;
  recall: number;
  precision: number;
  ndcg: number;
  faithfulness?: number;
  correctness?: number;
}

// ---------------------------------------------------------------------------
// 检索质量评估器
// ---------------------------------------------------------------------------

/**
 * 计算 Recall@K：检索结果中 ground truth chunk 的覆盖率。
 */
export function calcRecallAtK(
  results: RetrieveResult[],
  groundTruthIds: string[],
  k?: number
): number {
  const relevantIds = new Set(groundTruthIds);
  const retrieved = k ? results.slice(0, k) : results;
  const hitIds = retrieved.filter((r) => relevantIds.has(r.chunk_id));
  return relevantIds.size > 0 ? hitIds.length / relevantIds.size : 0;
}

/**
 * 计算 Precision@K：检索结果中相关 chunk 的比例。
 */
export function calcPrecisionAtK(
  results: RetrieveResult[],
  groundTruthIds: string[],
  k?: number
): number {
  const relevantIds = new Set(groundTruthIds);
  const retrieved = k ? results.slice(0, k) : results;
  const hitIds = retrieved.filter((r) => relevantIds.has(r.chunk_id));
  return retrieved.length > 0 ? hitIds.length / retrieved.length : 0;
}

/**
 * 计算 NDCG@K（Normalized Discounted Cumulative Gain）。
 * 假设每个相关文档 gain=1，不相关 gain=0。
 */
export function calcNDCGAtK(
  results: RetrieveResult[],
  groundTruthIds: string[],
  k?: number
): number {
  const relevantIds = new Set(groundTruthIds);
  const retrieved = k ? results.slice(0, k) : results;
  
  // DCG：累积增益按位置折扣
  let dcg = 0;
  for (let i = 0; i < retrieved.length; i++) {
    const chunk = retrieved[i];
    if (!chunk) continue;
    const isRelevant = relevantIds.has(chunk.chunk_id);
    dcg += isRelevant ? (1 / Math.log2(i + 2)) : 0;
  }
  
  // IDCG：理想排序的累积增益
  const idealHits = Math.min(retrieved.length, groundTruthIds.length);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += (1 / Math.log2(i + 2));
  }
  
  return idcg > 0 ? dcg / idcg : 0;
}

// ---------------------------------------------------------------------------
// 生成质量评估器（基于关键词重叠 + 简单语义）
// ---------------------------------------------------------------------------

/**
 * 计算 Faithfulness：生成内容是否基于检索结果（无幻觉）。
 * 简化版：检查生成内容中的关键实体是否在检索结果中出现。
 */
export function calcFaithfulness(
  generatedAnswer: string,
  retrievedContents: string[]
): number {
  if (!generatedAnswer || retrievedContents.length === 0) return 0;
  
  const answerTerms = new Set(tokenize(generatedAnswer));
  if (answerTerms.size === 0) return 1;
  
  let matchedTerms = 0;
  for (const content of retrievedContents) {
    const contentTerms = new Set(tokenize(content));
    for (const term of answerTerms) {
      if (contentTerms.has(term)) {
        matchedTerms++;
        break; // 每个答案 term 只计一次匹配
      }
    }
  }
  
  return answerTerms.size > 0 ? matchedTerms / answerTerms.size : 0;
}

/**
 * 计算 Answer Correctness：生成答案与 ground truth 的语义相似度。
 * 简化版：基于关键词重叠的 Jaccard 相似度。
 */
export function calcCorrectness(
  generatedAnswer: string,
  groundTruthAnswer: string
): number {
  if (!generatedAnswer || !groundTruthAnswer) return 0;
  
  const genTerms = new Set(tokenize(generatedAnswer));
  const gtTerms = new Set(tokenize(groundTruthAnswer));
  
  if (genTerms.size === 0 || gtTerms.size === 0) return 0;
  
  // Jaccard 相似度
  let intersection = 0;
  for (const term of genTerms) {
    if (gtTerms.has(term)) intersection++;
  }
  
  const union = genTerms.size + gtTerms.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ---------------------------------------------------------------------------
// 批量评估器
// ---------------------------------------------------------------------------

export interface EvalOptions {
  /** 评估的 K 值（默认 5） */
  k?: number;
  /** 是否输出每个 sample 的明细（默认 false） */
  verbose?: boolean;
}

export class RAGEvaluator {
  private options: EvalOptions;

  constructor(options: EvalOptions = {}) {
    this.options = { k: 5, verbose: false, ...options };
  }

  /**
   * 评估单个 sample。
   */
  evaluateSample(sample: EvalSample, results: RetrieveResult[]): EvalSampleResult {
    const recall = sample.groundTruthChunkIds?.length
      ? calcRecallAtK(results, sample.groundTruthChunkIds, this.options.k)
      : 0;
    
    const precision = sample.groundTruthChunkIds?.length
      ? calcPrecisionAtK(results, sample.groundTruthChunkIds, this.options.k)
      : 0;
    
    const ndcg = sample.groundTruthChunkIds?.length
      ? calcNDCGAtK(results, sample.groundTruthChunkIds, this.options.k)
      : 0;

    const faithfulness = sample.generatedAnswer && results.length > 0
      ? calcFaithfulness(sample.generatedAnswer, results.map((r) => r.content))
      : undefined;

    const correctness = sample.generatedAnswer && sample.groundTruthAnswer
      ? calcCorrectness(sample.generatedAnswer, sample.groundTruthAnswer)
      : undefined;

    return { query: sample.query, recall, precision, ndcg, faithfulness, correctness };
  }

  /**
   * 评估整个数据集。
   */
  async evaluate(dataset: EvalDataset, retrieveFn: (query: string) => Promise<RetrieveResult[]>): Promise<EvalResult> {
    const sampleResults: EvalSampleResult[] = [];

    for (const sample of dataset.samples) {
      const results = await retrieveFn(sample.query);
      const sampleResult = this.evaluateSample(sample, results);
      sampleResults.push(sampleResult);
    }
    
    // 聚合指标
    const metrics: EvalMetric[] = [];
    
    if (sampleResults.length > 0) {
      const avgRecall = sampleResults.reduce((s, r) => s + r.recall, 0) / sampleResults.length;
      const avgPrecision = sampleResults.reduce((s, r) => s + r.precision, 0) / sampleResults.length;
      const avgNDCG = sampleResults.reduce((s, r) => s + r.ndcg, 0) / sampleResults.length;
      
      metrics.push({ name: 'recall@k', value: avgRecall, unit: '' });
      metrics.push({ name: 'precision@k', value: avgPrecision, unit: '' });
      metrics.push({ name: 'ndcg@k', value: avgNDCG, unit: '' });
      
      // Faithfulness（如果有）
      const faithful = sampleResults.filter((r) => r.faithfulness !== undefined);
      if (faithful.length > 0) {
        const avgFaithfulness = faithful.reduce((s, r) => s + (r.faithfulness ?? 0), 0) / faithful.length;
        metrics.push({ name: 'faithfulness', value: avgFaithfulness, unit: '' });
      }
      
      // Correctness（如果有）
      const correct = sampleResults.filter((r) => r.correctness !== undefined);
      if (correct.length > 0) {
        const avgCorrectness = correct.reduce((s, r) => s + (r.correctness ?? 0), 0) / correct.length;
        metrics.push({ name: 'correctness', value: avgCorrectness, unit: '' });
      }
    }
    
    return Promise.resolve({
      dataset: dataset.name,
      sampleCount: dataset.samples.length,
      metrics,
      ...(this.options.verbose ? { sampleResults } : {}),
    });
  }
}

/** 工厂函数 */
export function createRAGEvaluator(options: EvalOptions = {}) {
  return new RAGEvaluator(options);
}
