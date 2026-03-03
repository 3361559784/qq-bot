import { buildErrorResponse, buildPassthroughHeaders, requestBackend } from '@/lib/backendClient';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: { id: string } }): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const id = encodeURIComponent(String(context?.params?.id || '').trim());
    const upstream = await requestBackend({
      method: 'POST',
      backendPath: `/api/v3/computer-use/jobs/${id}/cancel`,
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
