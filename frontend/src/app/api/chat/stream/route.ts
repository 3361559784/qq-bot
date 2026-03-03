import { buildErrorResponse, requestBackend } from '@/lib/backendClient';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const upstream = await requestBackend({
      method: 'POST',
      backendPath: '/api/v3/chat/stream',
      body
    });

    if (!upstream.body) {
      return Response.json({
        success: false,
        error: 'empty_stream_body',
        message: 'upstream stream body is empty'
      }, { status: 502 });
    }

    const headers = new Headers();
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.set('cache-control', 'no-cache');
    headers.set('connection', 'keep-alive');
    const requestId = upstream.headers.get('x-request-id');
    if (requestId) headers.set('x-request-id', requestId);

    return new Response(upstream.body, {
      status: upstream.status,
      headers
    });
  } catch (err) {
    return buildErrorResponse(err);
  }
}
