/**
 * 置信度阀门单元测试（P0）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const coreDist = path.join(__dirname, '../../../backend/core/dist/index.js');
const { ConfidenceGate } = require(coreDist);
const { DEFAULT_AGENT_ID, makeDefaultAgentCard } = require(coreDist);

describe('ConfidenceGate', () => {
  it('应通过高置信度候选', () => {
    const gate = new ConfidenceGate({ threshold: 0.5 });
    const card = makeDefaultAgentCard();
    const best = { card, score: 0.8, domainScore: 1, capabilityScore: 1, healthFactor: 1, slaFactor: 1 };
    const intent = { domain: 'generic', intent: 'qa', requiredCapabilities: [], source: 'rule' };
    const result = gate.check(best, intent, {});
    assert.equal(result.id, DEFAULT_AGENT_ID);
  });

  it('应在低置信度时返回 null（fallback 模式）', () => {
    const gate = new ConfidenceGate({ threshold: 0.7, behavior: 'fallback' });
    const card = makeDefaultAgentCard();
    const best = { card, score: 0.3, domainScore: 0.3, capabilityScore: 1, healthFactor: 1, slaFactor: 1 };
    const intent = { domain: 'medical-aesthetics', intent: 'qa', requiredCapabilities: [], source: 'rule' };
    const result = gate.check(best, intent, {});
    assert.equal(result, null);
  });

  it('应在低置信度时返回信号（signal 模式）', () => {
    const gate = new ConfidenceGate({ threshold: 0.7, behavior: 'signal' });
    const card = makeDefaultAgentCard();
    const best = { card, score: 0.3, domainScore: 0.3, capabilityScore: 1, healthFactor: 1, slaFactor: 1 };
    const intent = { domain: 'medical-aesthetics', intent: 'qa', requiredCapabilities: [], source: 'rule' };
    const result = gate.check(best, intent, {});
    assert.equal(result.decidedBy, 'fallback_low_confidence');
    assert.equal(result.confidence, 0.3);
    assert.equal(result.threshold, 0.7);
  });
});
