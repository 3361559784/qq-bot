import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyError, requestBackend } from '../src/lib/backendClient';

test('backend client signs and forwards request', async () => {
  const prevFetch = global.fetch;
  let calledUrl = '';
  let calledHeaders: Headers | null = null;

  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url);
    calledHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'rid_proxy_test' }
    });
  }) as typeof fetch;

  try {
    const response = await requestBackend({
      method: 'POST',
      backendPath: '/api/v3/chat',
      body: { content: 'hello' },
      env: {
        ...process.env,
        ARIS_API_INTERNAL_BASE_URL: 'http://api:3000',
        ARIS_AUTH_KEY: 'test_key',
        ARIS_AUTH_SIGNATURE_SECRET: 'test_secret',
        ARIS_PROXY_TIMEOUT_MS: '1000'
      }
    });

    assert.equal(response.status, 200);
    assert.equal(calledUrl, 'http://api:3000/api/v3/chat');
    assert.equal(Boolean(calledHeaders?.get('x-aris-signature')), true);
    assert.equal(calledHeaders?.get('x-aris-key'), 'test_key');
  } finally {
    global.fetch = prevFetch;
  }
});

test('backend client returns timeout error when upstream hangs', async () => {
  const prevFetch = global.fetch;
  global.fetch = ((_: string | URL | Request, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const abortErr = new Error('aborted');
      (abortErr as Error & { name: string }).name = 'AbortError';
      reject(abortErr);
    }, { once: true });
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => requestBackend({
        method: 'GET',
        backendPath: '/api/v3/chat',
        timeoutMs: 20,
        env: {
          ...process.env,
          ARIS_API_INTERNAL_BASE_URL: 'http://api:3000',
          ARIS_AUTH_KEY: 'test_key',
          ARIS_AUTH_SIGNATURE_SECRET: 'test_secret'
        }
      }),
      (err: unknown) => {
        assert.ok(err instanceof ProxyError);
        assert.equal((err as ProxyError).status, 504);
        return true;
      }
    );
  } finally {
    global.fetch = prevFetch;
  }
});
