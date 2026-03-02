const test = require('node:test');
const assert = require('node:assert/strict');
const { getRuntimeConfig } = require('../../src/functions/schoolbot/config/runtime');

test('runtime config defaults and gptsovits env mapping', () => {
  const cfg = getRuntimeConfig({
    ARIS_DEBUG_RESPONSE: 'false',
    ARIS_GPTSOVITS_API_URL: 'http://127.0.0.1:9874',
    ARIS_GPTSOVITS_REF_AUDIO_PATH: '/tmp/ref.wav',
    ARIS_GPTSOVITS_REF_PROMPT_TEXT: 'hello',
    ARIS_GPTSOVITS_REF_PROMPT_LANG: 'ja'
  });

  assert.equal(cfg.response.exposeDebugMeta, false);
  assert.equal(cfg.gptsovits.apiUrl, 'http://127.0.0.1:9874');
  assert.equal(cfg.gptsovits.refAudioPath, '/tmp/ref.wav');
  assert.equal(cfg.gptsovits.refPromptText, 'hello');
});
