const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionKey,
  shouldCompact,
  estimateTranscriptTokens
} = require('../src/v2/core/sessionManager');

test('sessionManager: buildSessionKey resolves qq group from metadata and context_id', () => {
  const key = buildSessionKey({
    channel: 'qq',
    context_id: 'qq_group_778899',
    metadata: {
      message_type: 'group',
      group_id: '778899'
    }
  });

  assert.equal(key, 'qq_group:778899');
});

test('sessionManager: private message should not create session key', () => {
  const key = buildSessionKey({
    channel: 'qq',
    context_id: 'qq_private_123456',
    metadata: {
      message_type: 'private'
    }
  });

  assert.equal(key, null);
});

test('sessionManager: shouldCompact supports transcript array input', () => {
  const transcript = Array.from({ length: 25 }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn_${i}`
  }));

  assert.equal(shouldCompact(transcript, { maxEntries: 24, maxTokens: 12000 }), true);
  assert.equal(estimateTranscriptTokens(transcript) > 0, true);
});
