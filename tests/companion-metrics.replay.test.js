const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  applyAliceCompanionGuards,
  containsMetaLeak,
  containsServiceTone,
  containsOOCSelfReference
} = require('../src/v2/core/styleGuards');

const REPLAY_FILE = path.join(__dirname, 'replay-metrics', 'alice-style-replay.jsonl');

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function lastAssistantText(historyTurns = []) {
  const turns = (Array.isArray(historyTurns) ? historyTurns : [])
    .filter((x) => String(x?.role || '').toLowerCase() === 'assistant')
    .map((x) => String(x?.content || '').trim())
    .filter(Boolean);
  if (!turns.length) return '';
  return turns[turns.length - 1];
}

test('companion metrics replay: jsonl quality indicators stay in safe range', async () => {
  const rows = readJsonl(REPLAY_FILE);
  assert.ok(rows.length > 0, 'replay rows should not be empty');

  const stats = {
    total: rows.length,
    metaLeak: 0,
    serviceTone: 0,
    oocSelfRef: 0,
    catchphrase: 0,
    exactRepeat: 0,
    companionPrefix: 0
  };

  for (const row of rows) {
    const historyTurns = Array.isArray(row.historyTurns) ? row.historyTurns : [];
    const options = {
      historyTurns,
      emotionResponse: 'normal',
      allowMetaTalk: false,
      capabilityMode: 'chat',
      safetyAction: 'pass',
      ...(row.options || {})
    };

    const output = applyAliceCompanionGuards(String(row.raw_output || ''), options);
    const expect = row.expect || {};

    if (expect.noMetaLeak) {
      assert.equal(containsMetaLeak(output), false, `[${row.id}] should not leak meta prompt`);
    }

    if (expect.noServiceTone) {
      assert.equal(containsServiceTone(output), false, `[${row.id}] should not keep service tone`);
    }

    if (expect.noOocSelfRef) {
      assert.equal(containsOOCSelfReference(output), false, `[${row.id}] should not keep OOC self-reference`);
    }

    if (expect.cooldownRemovedRepeatedCatchphrase) {
      assert.equal(/邦邦卡邦|光啊/.test(output), false, `[${row.id}] repeated catchphrase should be removed`);
    }

    if (expect.notExactRepeat) {
      assert.notEqual(output, lastAssistantText(historyTurns), `[${row.id}] should avoid exact repeat`);
    }

    if (expect.hasCompanionPrefix) {
      assert.match(output, /^(（|\(|\[)/, `[${row.id}] should keep companion prefix`);
    }

    if (expect.exactSame) {
      assert.equal(output, String(row.raw_output || '').trim(), `[${row.id}] exact format reply should stay unchanged`);
    }

    if (expect.keepsModelWords) {
      assert.match(output, /GPT-4o|模型能力/, `[${row.id}] model words should remain if no prompt leak`);
    }

    const metricExclude = row.metricExclude || {};
    const lastAssistant = lastAssistantText(historyTurns);

    if (!metricExclude.metaLeak && containsMetaLeak(output)) stats.metaLeak += 1;
    if (!metricExclude.serviceTone && containsServiceTone(output)) stats.serviceTone += 1;
    if (!metricExclude.oocSelfRef && containsOOCSelfReference(output)) stats.oocSelfRef += 1;
    if (!metricExclude.catchphrase && /邦邦卡邦|光啊/.test(output)) stats.catchphrase += 1;
    if (!metricExclude.exactRepeat && lastAssistant && output === lastAssistant) stats.exactRepeat += 1;
    if (!metricExclude.companionPrefix && /^(（|\(|\[)/.test(output)) stats.companionPrefix += 1;
  }

  const rate = (value) => value / Math.max(1, stats.total);

  const metaLeakRate = rate(stats.metaLeak);
  const serviceToneRate = rate(stats.serviceTone);
  const oocSelfRefRate = rate(stats.oocSelfRef);
  const catchphraseRate = rate(stats.catchphrase);
  const exactRepeatRate = rate(stats.exactRepeat);
  const companionPrefixRate = rate(stats.companionPrefix);

  assert.equal(metaLeakRate, 0, 'meta leak rate should be zero in replay set');
  assert.equal(serviceToneRate, 0, 'service tone rate should be zero in replay set');
  assert.equal(oocSelfRefRate, 0, 'OOC self-reference rate should be zero in replay set');
  assert.equal(exactRepeatRate, 0, 'exact repeat rate should be zero in replay set');
  assert.ok(catchphraseRate <= 0.2, `catchphrase rate should be <= 0.2, got ${catchphraseRate}`);
  assert.ok(companionPrefixRate >= 0.2, `companion prefix rate should be >= 0.2, got ${companionPrefixRate}`);
});
