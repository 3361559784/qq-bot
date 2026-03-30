const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseLegacyQqEvent } = require('../src/functions/schoolBot');
const { legacyQqToMessageRequest, normalizeMessageRequest } = require('../src/v2/core/channelAdapter');

const QQ_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'qq');
const REPLAY_FILE = path.join(__dirname, 'legacy-replay', 'smoke.jsonl');

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('legacy replay smoke: schoolBot/v2 request shape consistency', async () => {
  const rows = readJsonl(REPLAY_FILE);
  assert.ok(rows.length > 0, 'replay rows should not be empty');

  for (const row of rows) {
    const fixturePath = path.join(QQ_FIXTURE_DIR, row.fixture);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const event = parseLegacyQqEvent(fixture.input, null);
    const reqFromLegacy = legacyQqToMessageRequest(event);

    const reqFromApi = normalizeMessageRequest({
      content: reqFromLegacy.content,
      user_id: reqFromLegacy.user_id,
      channel: reqFromLegacy.channel,
      context_id: reqFromLegacy.context_id,
      attachments: reqFromLegacy.attachments,
      metadata: reqFromLegacy.metadata,
      request_id: reqFromLegacy.request_id
    }, null);

    assert.equal(reqFromLegacy.channel, 'qq');
    assert.equal(reqFromApi.channel, 'qq');
    assert.equal(reqFromApi.content, reqFromLegacy.content);
    assert.equal(reqFromApi.user_id, reqFromLegacy.user_id);
    assert.equal(reqFromApi.context_id, reqFromLegacy.context_id);
    assert.ok(reqFromApi.request_id);
  }
});
