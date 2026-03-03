const crypto = require('crypto');

function hmacHex(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const aa = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (aa.length === 0 || bb.length === 0 || aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifySignature({ timestamp, method, url, secret, signature }) {
  const canonical = `${timestamp}\n${method.toUpperCase()}\n${url}`;
  const expected = hmacHex(secret, canonical);
  const actual = String(signature || '').replace(/^sha256=/i, '').trim();
  return timingSafeEqualHex(expected, actual);
}

function createAuthMiddleware(options = {}) {
  const authKey = String(options.authKey || process.env.ARIS_AUTH_KEY || '').trim();
  const secret = String(options.signatureSecret || process.env.ARIS_AUTH_SIGNATURE_SECRET || '').trim();
  const skewSec = Number(options.maxSkewSec || process.env.ARIS_AUTH_MAX_SKEW_SEC || 300);
  const disabledRaw = options.disabled ?? process.env.ARIS_AUTH_DISABLED ?? '';
  const disabled = String(disabledRaw).toLowerCase() === 'true';

  return function authMiddleware(request, reply, done) {
    if (disabled) return done();

    const url = String(request.url || '/');
    if (url === '/healthz' || url === '/readyz') return done();

    const gotKey = String(request.headers['x-aris-key'] || '').trim();
    if (!authKey || gotKey !== authKey) {
      reply.code(401).send({ error: 'unauthorized_key' });
      return;
    }

    const timestamp = String(request.headers['x-aris-timestamp'] || '').trim();
    const signature = String(request.headers['x-aris-signature'] || '').trim();
    const ts = Number(timestamp);
    if (!timestamp || !Number.isFinite(ts)) {
      reply.code(401).send({ error: 'invalid_timestamp' });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Math.trunc(ts)) > skewSec) {
      reply.code(401).send({ error: 'timestamp_skew_exceeded' });
      return;
    }

    if (!secret) {
      reply.code(500).send({ error: 'signature_secret_not_configured' });
      return;
    }

    const ok = verifySignature({
      timestamp,
      method: request.method,
      url: request.routeOptions?.url || request.url,
      secret,
      signature
    });

    if (!ok) {
      reply.code(401).send({ error: 'invalid_signature' });
      return;
    }

    done();
  };
}

module.exports = {
  createAuthMiddleware,
  verifySignature
};
