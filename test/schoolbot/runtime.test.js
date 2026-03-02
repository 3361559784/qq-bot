const test = require('node:test');
const assert = require('node:assert/strict');
const { getRuntimeConfig } = require('../../src/functions/schoolbot/config/runtime');

test('runtime config defaults and gptsovits env mapping', () => {
  const cfg = getRuntimeConfig({
    ARIS_DEBUG_RESPONSE: 'false',
    ARIS_SCHOOLBOT_ENGINE: 'shadow',
    ARIS_SCHOOLBOT_V2_PERCENT: '30',
    ARIS_REQUIRE_INGRESS_AUTH: 'true',
    ARIS_INGRESS_SHARED_KEY: 'k1',
    ARIS_INGRESS_SIGNATURE_SECRET: 's1',
    ARIS_GPTSOVITS_API_URL: 'http://127.0.0.1:9874',
    ARIS_GPTSOVITS_REF_AUDIO_PATH: '/tmp/ref.wav',
    ARIS_GPTSOVITS_REF_PROMPT_TEXT: 'hello',
    ARIS_GPTSOVITS_REF_PROMPT_LANG: 'ja'
  });

  assert.equal(cfg.response.exposeDebugMeta, false);
  assert.equal(cfg.engine.mode, 'shadow');
  assert.equal(cfg.engine.v2Percent, 30);
  assert.equal(cfg.auth.requireIngressAuth, true);
  assert.equal(cfg.auth.sharedKey, 'k1');
  assert.equal(cfg.auth.signatureSecret, 's1');
  assert.equal(cfg.gptsovits.apiUrl, 'http://127.0.0.1:9874');
  assert.equal(cfg.gptsovits.refAudioPath, '/tmp/ref.wav');
  assert.equal(cfg.gptsovits.refPromptText, 'hello');
});
