const test = require('node:test');
const assert = require('node:assert/strict');
const { getComputerUseRuntimeConfig, resolveRelayEnabled } = require('../../../src/v2/services/computerUseService');

function withEnv(temp) {
  const prev = {};
  for (const [k, v] of Object.entries(temp)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('relay guard: enabled in development when switch on', () => {
  const restore = withEnv({
    NODE_ENV: 'development',
    ARIS_CU_RELAY_ENABLE_DEV: 'true',
    ARIS_CU_RELAY_FORCE_PROD: 'false'
  });

  assert.equal(resolveRelayEnabled(process.env), true);
  const cfg = getComputerUseRuntimeConfig(process.env);
  assert.equal(cfg.relay.enabled, true);
  restore();
});

test('relay guard: disabled in production by default', () => {
  const restore = withEnv({
    NODE_ENV: 'production',
    ARIS_CU_RELAY_ENABLE_DEV: 'true',
    ARIS_CU_RELAY_FORCE_PROD: 'false'
  });

  assert.equal(resolveRelayEnabled(process.env), false);
  const cfg = getComputerUseRuntimeConfig(process.env);
  assert.equal(cfg.relay.enabled, false);
  restore();
});

test('relay guard: can be forced in production explicitly', () => {
  const restore = withEnv({
    NODE_ENV: 'production',
    ARIS_CU_RELAY_ENABLE_DEV: 'true',
    ARIS_CU_RELAY_FORCE_PROD: 'true'
  });

  assert.equal(resolveRelayEnabled(process.env), true);
  const cfg = getComputerUseRuntimeConfig(process.env);
  assert.equal(cfg.relay.enabled, true);
  restore();
});
