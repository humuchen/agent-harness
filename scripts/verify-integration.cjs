/**
 * 集成验证脚本：检查架构模块是否真正接入运行链路
 *
 * 用法:
 *   node scripts/verify-integration.cjs [module]
 *
 * 支持的 module:
 *   confidence-gate  - 检查 ConfidenceGate 是否集成到 router
 *   coreference      - 检查 EntityTracker 是否集成到 harness
 *   rag-eval         - 检查 RAG 评估端点是否存在
 *   trace-integration - 检查 traceId 是否从 harness 传递到 RAG
 *
 * 示例:
 *   node scripts/verify-integration.cjs confidence-gate
 *   node scripts/verify-integration.cjs all
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function checkFile(filePath, symbols) {
  const fullPath = path.join(ROOT, filePath);
  if (!fs.existsSync(fullPath)) {
    return { exists: false, found: [] };
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const found = symbols.filter(sym => content.includes(sym));
  return { exists: true, found };
}

const checks = {
  'confidence-gate': {
    module: 'backend/core/src/router/confidence-gate.ts',
    test: 'backend/core/test/confidence-gate.test.cjs',
    integration: 'backend/core/src/router/router.ts',
    symbols: ['getConfidenceGate', 'ConfidenceGate']
  },
  'coreference': {
    module: 'backend/core/src/coreference.ts',
    test: 'backend/core/test/coreference.test.cjs',
    integration: 'backend/core/src/harness.ts',
    symbols: ['resolveAndTrack', 'EntityTracker']
  },
  'rag-eval': {
    module: 'services/rag/src/eval.ts',
    test: 'services/rag/test/eval.test.cjs',
    integration: 'services/rag/src/server.ts',
    symbols: ['createRAGEvaluator', 'RAGEvaluator']
  },
  'trace-integration': {
    module: 'services/rag/src/retrieve.ts',
    test: null,
    integration: 'access/server/src/run-queue.ts',
    symbols: ['traceId', 'trace_id']
  }
};

function verify(moduleName) {
  const check = checks[moduleName];
  if (!check) {
    console.error(`Unknown module: ${moduleName}`);
    console.log('Supported:', Object.keys(checks).join(', '));
    process.exit(1);
  }

  console.log(`\n=== ${moduleName} ===`);

  // 1. Module exists
  const moduleCheck = checkFile(check.module, [check.symbols[0]]);
  console.log(`  [1] Module exists: ${moduleCheck.exists ? '✅' : '❌'}`);

  // 2. Test exists
  if (check.test) {
    console.log(`  [2] Test exists: ${fs.existsSync(path.join(ROOT, check.test)) ? '✅' : '❌'}`);
  } else {
    console.log(`  [2] Test: N/A`);
  }

  // 3. Integration check
  const integrationCheck = checkFile(check.integration, check.symbols);
  console.log(`  [3] Integrated: ${integrationCheck.found.length > 0 ? '✅' : '❌'}`);
  if (integrationCheck.found.length > 0) {
    console.log(`      Found symbols: ${integrationCheck.found.join(', ')}`);
  }

  // Summary
  const allPassed = moduleCheck.exists && integrationCheck.found.length > 0;
  console.log(`  Status: ${allPassed ? '✅ INTEGRATED' : '⚠️ NOT INTEGRATED'}`);

  return allPassed;
}

const target = process.argv[2] || 'all';
if (target === 'all') {
  const results = Object.keys(checks).map(k => ({ key: k, passed: verify(k) }));
  const allPassed = results.every(r => r.passed);
  console.log(`\n=== Summary ===`);
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${results.filter(r => r.passed).length}`);
  console.log(`Failed: ${results.filter(r => !r.passed).length}`);
  process.exit(allPassed ? 0 : 1);
} else {
  const passed = verify(target);
  process.exit(passed ? 0 : 1);
}
