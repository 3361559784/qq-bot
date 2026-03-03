import { buildErrorResponse, buildPassthroughHeaders, requestBackend } from '@/lib/backendClient';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const upstream = await requestBackend({
      method: 'GET',
      backendPath: '/api/v3/computer-use/jobs',
      query: url.searchParams
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: buildPassthroughHeaders(upstream)
    });
  } catch (err) {
    return buildErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const upstream = await requestBackend({
      method: 'POST',
      backendPath: '/api/v3/computer-use/jobs',
      body
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: buildPassthroughHeaders(upstream)
    });
  } catch (err) {
    return buildErrorResponse(err);
  }
}
