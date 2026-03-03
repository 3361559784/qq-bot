const test = require('node:test');
const assert = require('node:assert/strict');
const { getComputerUseRuntimeConfig } = require('../../../src/v2/services/computerUseService');

function withEnv(temp) {
  const prev = {};
  for (const [k, v] of Object.entries(temp)) {
    prev[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('provider mode auto resolves to github_models when GitHub token exists', () => {
  const restore = withEnv({
    ARIS_CU_PROVIDER_MODE: 'auto',
    GITHUB_MODELS_TOKEN: 'ghm_xxx',
    GITHUB_TOKEN: null,
    GH_TOKEN: null,
    OPENAI_API_KEY: null,
    ARIS_CU_PLANNER_MODELS: ''
  });

  const cfg = getComputerUseRuntimeConfig(process.env);
  assert.equal(cfg.providerMode, 'github_models');
  assert.equal(Array.isArray(cfg.plannerModels), true);
  assert.equal(cfg.plannerModels[0], 'openai/gpt-5-nano');
  restore();
});

test('provider mode auto resolves to openai_compatible when GitHub token missing', () => {
  const restore = withEnv({
    ARIS_CU_PROVIDER_MODE: 'auto',
    GITHUB_MODELS_TOKEN: null,
    GITHUB_TOKEN: null,
    GH_TOKEN: null,
    OPENAI_API_KEY: 'sk_xxx'
  });

  const cfg = getComputerUseRuntimeConfig(process.env);
  assert.equal(cfg.providerMode, 'openai_compatible');
  restore();
});

test('planner models prefer ARIS_CU_PLANNER_MODELS over single fallback', () => {
  const restore = withEnv({
    ARIS_CU_PLANNER_MODELS: 'openai/gpt-5-nano, openai/gpt-4.1-mini, openai/gpt-5-nano',
    ARIS_CU_PLANNER_MODEL: 'openai/gpt-4o-mini'
  });

  const cfg = getComputerUseRuntimeConfig(process.env);
  assert.deepEqual(cfg.plannerModels, ['openai/gpt-5-nano', 'openai/gpt-4.1-mini']);
  assert.equal(cfg.plannerModel, 'openai/gpt-5-nano');
  restore();
});
