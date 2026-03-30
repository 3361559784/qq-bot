const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseOverlayFromText,
  resolveActiveOverlay,
  applyOverlayToReply
} = require('../src/v2/core/roleplayOverlay');

test('roleplayOverlay: parse exact reply with no punctuation constraint', () => {
  const overlay = parseOverlayFromText('听懂就回复我（收到）不要加标点');
  assert.equal(Boolean(overlay), true);
  assert.equal(overlay.exactReply, '收到');
  assert.equal(overlay.noPunctuation, true);
  assert.equal(overlay.persist, true);
});

test('roleplayOverlay: active overlay expires after two subsequent user turns', () => {
  const history = [
    { role: 'user', content: '听懂就回复我（收到）不要加标点', metadata: { roleplay_overlay: parseOverlayFromText('听懂就回复我（收到）不要加标点') } },
    { role: 'assistant', content: '收到' },
    { role: 'user', content: '第二句', metadata: {} },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '第三句', metadata: {} },
    { role: 'assistant', content: 'ok' }
  ];

  const active = resolveActiveOverlay(history, null);
  assert.equal(Boolean(active), true);
  assert.equal(active.remainingUserTurns >= 0, true);

  const expiredHistory = [
    ...history,
    { role: 'user', content: '第四句', metadata: {} },
    { role: 'assistant', content: 'ok' }
  ];
  const expired = resolveActiveOverlay(expiredHistory, null);
  assert.equal(expired, null);
});

test('roleplayOverlay: applyOverlayToReply supports exact-format one-shot', () => {
  const result = applyOverlayToReply('爱丽丝会照做。', {
    exactReply: '收到',
    noPunctuation: true,
    justTriggered: true
  });

  assert.equal(result.overlayApplied, true);
  assert.equal(result.exactFormat, true);
  assert.equal(result.content, '收到');
});
