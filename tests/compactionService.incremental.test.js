const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeCompactionWindow,
  compactTranscript
} = require('../src/v2/core/compactionService');

function makeTurn(type, content, createdAt) {
  return {
    id: `${type}_${content}`,
    type,
    content,
    created_at: createdAt || new Date().toISOString(),
    metadata: {}
  };
}

test('compactionService: computes incremental compaction window after previous compaction', () => {
  const transcript = [];
  for (let i = 0; i < 20; i += 1) {
    transcript.push(makeTurn(i % 2 === 0 ? 'user' : 'assistant', `old_${i}`));
  }

  transcript.push({
    id: 'compaction_1',
    type: 'compaction',
    summary: 'old summary',
    kept_from_turn: 12,
    source_turn_count: 12,
    created_at: new Date().toISOString(),
    metadata: {}
  });

  for (let i = 20; i < 30; i += 1) {
    transcript.push(makeTurn(i % 2 === 0 ? 'user' : 'assistant', `new_${i}`));
  }

  const window = computeCompactionWindow(transcript, { keepRecent: 8 });

  assert.equal(window.fromTurn, 12);
  assert.equal(window.toTurn > window.fromTurn, true);
  assert.equal(window.sourceTurnCount > 0, true);
});

test('compactionService: compaction metadata accumulates summarized count incrementally', () => {
  const chatContext = {
    transcript: [],
    compaction_meta: {
      compaction_count: 1,
      source_turn_count: 12,
      kept_from_turn: 12,
      last_compaction_at: new Date().toISOString()
    }
  };

  for (let i = 0; i < 20; i += 1) {
    chatContext.transcript.push(makeTurn(i % 2 === 0 ? 'user' : 'assistant', `turn_${i}`));
  }

  compactTranscript(chatContext, 'incremental summary', {
    keepRecent: 8,
    fromTurn: 12,
    toTurn: 16,
    sourceTurnCount: 4,
    previousKeptFromTurn: 12
  });

  const latest = chatContext.transcript[chatContext.transcript.length - 1];
  assert.equal(latest.type, 'compaction');
  assert.equal(latest.kept_from_turn, 16);
  assert.equal(latest.source_turn_count, 4);
  assert.equal(chatContext.compaction_meta.source_turn_count, 16);
});
