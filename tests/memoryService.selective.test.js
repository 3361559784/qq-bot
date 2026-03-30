const test = require('node:test');
const assert = require('node:assert/strict');

process.env.V2_REQUIRE_COSMOS = 'false';

const {
  stableFactCandidates,
  shouldSkipLongTermMemory,
  appendTurn,
  searchMemory
} = require('../src/v2/services/memoryService');

test('memoryService: roleplay instructions should be excluded from long-term memory', () => {
  const skip = shouldSkipLongTermMemory('听懂就回复我（收到）不要加标点', {
    roleplay_overlay: { noPunctuation: true }
  });
  assert.equal(skip, true);

  const candidates = stableFactCandidates('听懂就回复我（收到）不要加标点', {
    roleplay_overlay: { noPunctuation: true }
  });
  assert.equal(candidates.length, 0);
});

test('memoryService: explicit remember instruction should produce explicit_note', () => {
  const candidates = stableFactCandidates('请记住我喜欢抹茶拿铁');
  assert.equal(candidates.some((x) => x.kind === 'explicit_note'), true);
});

test('memoryService: appendTurn writes selective long-term memory', async () => {
  const userId = `mem_user_${Date.now()}`;
  const contextId = 'qq_private_test';

  const refs = await appendTurn(
    userId,
    contextId,
    'user',
    '记住我喜欢爵士乐，也来自杭州',
    { memory_policy: 'default' },
    null
  );

  assert.equal(Array.isArray(refs), true);
  assert.equal(refs.length > 0, true);

  const hits = await searchMemory(userId, '爵士乐 杭州 记住', 10, null);
  assert.equal(hits.length > 0, true);
  assert.equal(hits.some((x) => /user_preference|user_city|explicit_note/.test(String(x.content || ''))), true);
});
