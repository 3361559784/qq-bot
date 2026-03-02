const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateIngressAuth } = require('../../../src/functions/schoolbot/http/authGuard');

function makeRequest(headers = {}) {
  const normalized = new Map();
  Object.entries(headers).forEach(([k, v]) => normalized.set(String(k).toLowerCase(), String(v)));
  return {
    headers: {
      get: (key) => normalized.get(String(key).toLowerCase()) || null
    }
  };
}

test('auth guard: disabled auth should allow request', () => {
  const req = makeRequest();
  const out = validateIngressAuth({
    request: req,
    bodyText: '{}',
    runtimeConfig: { auth: { requireIngressAuth: false } }
  });

  assert.equal(out.ok, true);
  assert.equal(out.mode, 'disabled');
});

test('auth guard: shared key success and failure', () => {
  const pass = validateIngressAuth({
    request: makeRequest({ 'x-aris-key': 'k1' }),
    bodyText: '{}',
    runtimeConfig: {
      auth: {
        requireIngressAuth: true,
        sharedKey: 'k1',
        signatureSecret: ''
      }
    }
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.mode, 'shared_key');

  const fail = validateIngressAuth({
    request: makeRequest({ 'x-aris-key': 'bad' }),
    bodyText: '{}',
    runtimeConfig: {
      auth: {
        requireIngressAuth: true,
        sharedKey: 'k1',
        signatureSecret: ''
      }
    }
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.status, 401);
});

test('auth guard: signature verification success', () => {
  const bodyText = '{"message":"hello"}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = 'sig_secret';
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyText}`).digest('hex');

  const out = validateIngressAuth({
    request: makeRequest({
      'x-aris-timestamp': timestamp,
      'x-aris-signature': `sha256=${signature}`
    }),
    bodyText,
    runtimeConfig: {
      auth: {
        requireIngressAuth: true,
        sharedKey: '',
        signatureSecret: secret,
        signatureMaxSkewSec: 300
      }
    }
  });

  assert.equal(out.ok, true);
  assert.equal(out.mode, 'signature');
});
