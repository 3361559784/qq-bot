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
    ARIS_REFUSAL_POLICY_VERSION: 'relaxed_v1',
    ARIS_REFUSAL_POLICY_PERCENT: '30',
    ARIS_REFUSAL_MODEL_ENABLED: 'true',
    ARIS_REFUSAL_MODEL_HARD_MIN_CONF: '0.85',
    ARIS_REFUSAL_CLARIFY_MAX_ROUNDS: '1',
    ARIS_REFUSAL_DELEGATED_MODE: 'degrade',
    ARIS_REFUSAL_HARD_BLOCK_SCOPE: 'minimal',
    ARIS_RUNTIME_PROFILE: 'host',
    ARIS_CU_ENABLED: 'true',
    ARIS_CU_TRIGGER_MODE: 'both',
    ARIS_CU_CONFIRM_MODE: 'periodic',
    ARIS_CU_CONFIRM_EVERY_STEPS: '5',
    ARIS_CU_STEP_MAX_RETRY: '2',
    ARIS_CU_MAX_STEPS: '30',
    ARIS_CU_SYNC_WAIT_MS: '18000',
    ARIS_CU_LEASE_TTL_SEC: '45',
    ARIS_CU_REMOTE_ENDPOINT: '',
    ARIS_CU_AGENT_TOKEN: 'agent_token',
    ARIS_CU_PLANNER_MODEL: 'gpt-4o-mini',
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
  assert.equal(cfg.refusalPolicy.version, 'relaxed_v1');
  assert.equal(cfg.refusalPolicy.percent, 30);
  assert.equal(cfg.refusalPolicy.modelEnabled, true);
  assert.equal(cfg.refusalPolicy.modelHardMinConf, 0.85);
  assert.equal(cfg.refusalPolicy.clarifyMaxRounds, 1);
  assert.equal(cfg.refusalPolicy.delegatedMode, 'degrade');
  assert.equal(cfg.refusalPolicy.hardBlockScope, 'minimal');
  assert.equal(cfg.profile, 'host');
  assert.equal(cfg.computerUse.enabled, true);
  assert.equal(cfg.computerUse.triggerMode, 'both');
  assert.equal(cfg.computerUse.confirmMode, 'periodic');
  assert.equal(cfg.computerUse.confirmEverySteps, 5);
  assert.equal(cfg.computerUse.stepMaxRetry, 2);
  assert.equal(cfg.computerUse.maxSteps, 30);
  assert.equal(cfg.computerUse.syncWaitMs, 18000);
  assert.equal(cfg.computerUse.leaseTtlSec, 45);
  assert.equal(cfg.computerUse.agentToken, 'agent_token');
  assert.equal(cfg.computerUse.plannerModel, 'gpt-4o-mini');
  assert.equal(cfg.gptsovits.apiUrl, 'http://127.0.0.1:9874');
  assert.equal(cfg.gptsovits.refAudioPath, '/tmp/ref.wav');
  assert.equal(cfg.gptsovits.refPromptText, 'hello');
});
