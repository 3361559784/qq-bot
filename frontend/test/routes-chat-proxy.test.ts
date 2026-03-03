import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as chatPost } from '../src/app/api/chat/route';
import { POST as streamPost } from '../src/app/api/chat/stream/route';

function setProxyEnv() {
  process.env.ARIS_API_INTERNAL_BASE_URL = 'http://api:3000';
  process.env.ARIS_AUTH_KEY = 'proxy_key';
  process.env.ARIS_AUTH_SIGNATURE_SECRET = 'proxy_secret';
  process.env.ARIS_PROXY_TIMEOUT_MS = '1000';
}

test('chat proxy route forwards POST payload to backend', async () => {
  setProxyEnv();
  const prevFetch = global.fetch;
  let hitUrl = '';

  global.fetch = (async (url: string | URL | Request) => {
    hitUrl = String(url);
    return new Response(JSON.stringify({ id: 'x', content: 'ok' }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-request-id': 'rid_chat_proxy'
      }
    });
  }) as typeof fetch;

  try {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' })
    });

    const res = await chatPost(req);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.content, 'ok');
    assert.equal(hitUrl, 'http://api:3000/api/v3/chat');
  } finally {
    global.fetch = prevFetch;
  }
});

test('chat stream proxy route passes through SSE body', async () => {
  setProxyEnv();
  const prevFetch = global.fetch;

  global.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"token","content":"A"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'rid_stream_proxy'
      }
    });
  }) as typeof fetch;

  try {
    const req = new Request('http://localhost/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'stream me' })
    });

    const res = await streamPost(req);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /"token"/);
    assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), true);
  } finally {
    global.fetch = prevFetch;
  }
});
