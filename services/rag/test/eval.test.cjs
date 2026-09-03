/**
 * RAG 评估器单元测试（P0）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ragDist = path.join(__dirname, '../../../services/rag/dist/index.js');
const {
  calcRecallAtK,
  calcPrecisionAtK,
  calcNDCGAtK,
  calcFaithfulness,
  calcCorrectness,
  createRAGEvaluator,
} = require(ragDist);

describe('检索质量评估', () => {
  const results = [
    { chunk_id: 'c1', content: '特斯拉续航 600km' },
    { chunk_id: 'c2', content: '比亚迪续航 500km' },
    { chunk_id: 'c3', content: '蔚来续航 650km' },
  ];
  const groundTruth = ['c1', 'c2'];

  it('Recall@K 应正确计算', () => {
    const recall = calcRecallAtK(results, groundTruth, 2);
    assert.equal(recall, 1.0);
  });

  it('Precision@K 应正确计算', () => {
    const precision = calcPrecisionAtK(results, groundTruth, 2);
    assert.equal(precision, 1.0);
  });

  it('NDCG@K 应正确计算', () => {
    const ndcg = calcNDCGAtK(results, groundTruth, 2);
    assert.equal(ndcg, 1.0);
  });

  it('Recall 在检索不全时应降低', () => {
    const partialResults = [
      { chunk_id: 'c1', content: '特斯拉续航 600km' },
      { chunk_id: 'c4', content: '无关内容' },
    ];
    const recall = calcRecallAtK(partialResults, groundTruth, 2);
    assert.equal(recall, 0.5);
  });
});

describe('生成质量评估', () => {
  it('Faithfulness 应基于关键词重叠', () => {
    const answer = '特斯拉的续航很长，达到 600km';
    const contexts = ['特斯拉 Model 3 续航 600km', '比亚迪汉续航 500km'];
    const faith = calcFaithfulness(answer, contexts);
    assert.ok(faith > 0);
    assert.ok(faith <= 1);
  });

  it('Correctness 应基于 Jaccard 相似度', () => {
    const gen = '特斯拉续航 600km';
    const gt = '特斯拉 Model 3 续航 600km';
    const correct = calcCorrectness(gen, gt);
    assert.ok(correct > 0.5);
  });

  it('空答案时应返回 0', () => {
    assert.equal(calcFaithfulness('', ['content']), 0);
    assert.equal(calcCorrectness('', 'gt'), 0);
  });
});

describe('RAGEvaluator', () => {
  it('应评估整个数据集', async () => {
    const evaluator = createRAGEvaluator({ k: 3 });
    const dataset = {
      name: 'test-dataset',
      samples: [
        {
          query: '特斯拉续航',
          groundTruthChunkIds: ['c1'],
          generatedAnswer: '特斯拉续航 600km',
          groundTruthAnswer: '特斯拉 Model 3 续航 600km',
        },
      ],
    };
    const retrieveFn = async (query) => [
      { chunk_id: 'c1', content: '特斯拉续航 600km', score: 0.9 },
    ];

    const result = await evaluator.evaluate(dataset, retrieveFn);
    assert.equal(result.dataset, 'test-dataset');
    assert.equal(result.sampleCount, 1);
    assert.ok(result.metrics.length > 0);
  });
});
