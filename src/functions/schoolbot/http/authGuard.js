const crypto = require('node:crypto');

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function normalizeSignature(sig) {
  const raw = String(sig || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().startsWith('sha256=')) {
    return raw.slice(7).trim();
  }
  return raw;
}

function parseBearerToken(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isTimestampFresh(timestampSeconds, maxSkewSec) {
  const ts = Number(timestampSeconds);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= Number(maxSkewSec || 300);
}

function verifyBodySignature({ bodyText, timestamp, secret, signature }) {
  if (!secret) return false;
  const normalizedSig = normalizeSignature(signature);
  if (!normalizedSig) return false;
  const payload = `${String(timestamp || '')}.${String(bodyText || '')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return timingSafeEqualString(normalizedSig, expected);
}

function validateIngressAuth({ request, bodyText = '', runtimeConfig }) {
  const cfg = runtimeConfig?.auth || {};

  if (!cfg.requireIngressAuth) {
    return { ok: true, mode: 'disabled' };
  }

  const sharedKey = String(cfg.sharedKey || '').trim();
  const signatureSecret = String(cfg.signatureSecret || '').trim();

  if (!sharedKey && !signatureSecret) {
    return {
      ok: false,
      status: 500,
      reason: 'ingress_auth_misconfigured',
      message: 'Ingress auth enabled but no key/signature secret configured.'
    };
  }

  const keyHeader = request?.headers?.get('x-aris-key')
    || request?.headers?.get('x-schoolbot-key')
    || parseBearerToken(request?.headers?.get('authorization'));

  if (sharedKey && keyHeader && timingSafeEqualString(keyHeader, sharedKey)) {
    return { ok: true, mode: 'shared_key' };
  }

  const timestamp = request?.headers?.get('x-aris-timestamp') || '';
  const signature = request?.headers?.get('x-aris-signature') || '';

  if (signatureSecret && signature) {
    if (!isTimestampFresh(timestamp, cfg.signatureMaxSkewSec)) {
      return {
        ok: false,
        status: 401,
        reason: 'invalid_signature_timestamp',
        message: 'Invalid or stale request timestamp.'
      };
    }

    if (verifyBodySignature({ bodyText, timestamp, secret: signatureSecret, signature })) {
      return { ok: true, mode: 'signature' };
    }

    return {
      ok: false,
      status: 401,
      reason: 'invalid_signature',
      message: 'Request signature verification failed.'
    };
  }

  return {
    ok: false,
    status: 401,
    reason: 'unauthorized',
    message: 'Missing or invalid ingress credentials.'
  };
}

module.exports = {
  validateIngressAuth,
  normalizeSignature,
  verifyBodySignature
};
