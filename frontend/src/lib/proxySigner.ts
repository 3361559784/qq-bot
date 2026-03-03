import crypto from 'node:crypto';

export function buildCanonicalString(timestamp: string, method: string, routePath: string): string {
  return `${timestamp}\n${method.toUpperCase()}\n${routePath}`;
}

export function signCanonical(secret: string, canonical: string): string {
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function buildSignedHeaders(input: {
  method: string;
  routePath: string;
  authKey: string;
  signatureSecret: string;
  timestamp?: string;
}): Record<string, string> {
  const timestamp = input.timestamp || String(Math.floor(Date.now() / 1000));
  const canonical = buildCanonicalString(timestamp, input.method, input.routePath);
  const signature = signCanonical(input.signatureSecret, canonical);
  return {
    'x-aris-key': input.authKey,
    'x-aris-timestamp': timestamp,
    'x-aris-signature': `sha256=${signature}`
  };
}
