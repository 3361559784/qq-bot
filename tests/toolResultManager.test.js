const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addToolResult,
  updateToolResults,
  pruneExpiredToolResults,
  pruneDuplicateToolResults,
  getActiveToolResults
} = require('../src/v2/core/toolResultManager');

test('toolResultManager: decrements ttl and prunes expired entries', () => {
  const ctx = { tool_results: [] };

  addToolResult(ctx, 'search.hybrid_search', { message: 'A' }, { expiresAfterTurns: 2 });
  assert.equal(ctx.tool_results.length, 1);
  assert.equal(ctx.tool_results[0].remaining_turns, 2);

  updateToolResults(ctx);
  assert.equal(ctx.tool_results[0].remaining_turns, 1);

  updateToolResults(ctx);
  const pruned = pruneExpiredToolResults(ctx);
  assert.equal(pruned, 1);
  assert.equal(ctx.tool_results.length, 0);
});

test('toolResultManager: keeps latest result for duplicate tool', () => {
  const ctx = { tool_results: [] };

  addToolResult(ctx, 'search.hybrid_search', { message: 'old' }, { expiresAfterTurns: 3, summary: 'old-summary' });
  addToolResult(ctx, 'weather.get_weather', { message: 'weather' }, { expiresAfterTurns: 3, summary: 'weather-summary' });
  addToolResult(ctx, 'search.hybrid_search', { message: 'new' }, { expiresAfterTurns: 3, summary: 'new-summary' });

  const removed = pruneDuplicateToolResults(ctx);
  assert.equal(removed, 1);

  const active = getActiveToolResults(ctx);
  assert.equal(active.length, 2);
  assert.equal(active.some((x) => x.tool === 'search.hybrid_search' && /new-summary/.test(x.summary)), true);
});
