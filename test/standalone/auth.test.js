const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../../src/standalone/app');

function sign(secret, timestamp, method, url) {
  const canonical = `${timestamp}\n${method}\n${url}`;
  const hex = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  return `sha256=${hex}`;
}

test('health endpoints do not require auth', async () => {
  const app = createApp({ logger: false, auth: { disabled: false, authKey: 'k', signatureSecret: 's' } });
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('chat requires key and signature by default', async () => {
  const app = createApp({ logger: false, auth: { authKey: 'k', signatureSecret: 's' } });
  const res = await app.inject({ method: 'POST', url: '/api/v3/chat', payload: { content: 'hello', user_id: 'u1' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('chat accepts valid key and signature', async () => {
  const authKey = 'k';
  const secret = 's';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(secret, ts, 'POST', '/api/v3/chat');

  const app = createApp({ logger: false, auth: { authKey, signatureSecret: secret } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v3/chat',
    headers: {
      'x-aris-key': authKey,
      'x-aris-timestamp': ts,
      'x-aris-signature': sig
    },
    payload: {
      content: '你好',
      user_id: 'u_auth_test'
    }
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(typeof body.content, 'string');
  await app.close();
});
