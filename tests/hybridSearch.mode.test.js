const test = require('node:test');
const assert = require('node:assert/strict');

const { hybridSearch } = require('../services/hybridSearch');

test('hybridSearch: can disable LLM fallback in strict retrieval mode', async () => {
  const result = await hybridSearch('量子纠缠是什么', { log: () => {} }, {
    skipCache: true,
    skipLocal: true,
    skipDDG: true,
    skipSerp: true,
    allowLlmFallback: false
  });

  assert.equal(result.success, false);
  assert.equal(result.source, 'none');
  assert.equal(Array.isArray(result.fallbackChain), true);
  assert.equal(result.fallbackChain.some((x) => x.layer === 'L4_llm' && x.status === 'disabled'), true);
});
