import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildCanonicalString, buildSignedHeaders, signCanonical } from '../src/lib/proxySigner';

test('proxy signer builds canonical string and sha256 signature', () => {
  const timestamp = '1710000000';
  const method = 'post';
  const routePath = '/api/v3/chat';
  const secret = 'secret_key_123';

  const canonical = buildCanonicalString(timestamp, method, routePath);
  assert.equal(canonical, '1710000000\nPOST\n/api/v3/chat');

  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  assert.equal(signCanonical(secret, canonical), expected);

  const headers = buildSignedHeaders({
    method,
    routePath,
    authKey: 'auth_key_abc',
    signatureSecret: secret,
    timestamp
  });

  assert.equal(headers['x-aris-key'], 'auth_key_abc');
  assert.equal(headers['x-aris-timestamp'], timestamp);
  assert.equal(headers['x-aris-signature'], `sha256=${expected}`);
});
