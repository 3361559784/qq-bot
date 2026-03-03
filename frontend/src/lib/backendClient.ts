import { buildSignedHeaders } from './proxySigner';

export class ProxyError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ProxyEnv {
  baseUrl: string;
  authKey: string;
  signatureSecret: string;
  timeoutMs: number;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

export function getProxyEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnv {
  const baseUrl = String(env.ARIS_API_INTERNAL_BASE_URL || 'http://127.0.0.1:3000').trim();
  const authKey = String(env.ARIS_AUTH_KEY || '').trim();
  const signatureSecret = String(env.ARIS_AUTH_SIGNATURE_SECRET || '').trim();
  const timeoutMs = clampInt(env.ARIS_PROXY_TIMEOUT_MS, 1000, 180000, 30000);

  if (!baseUrl) throw new ProxyError(500, 'proxy_config_error', 'ARIS_API_INTERNAL_BASE_URL is required');
  if (!authKey) throw new ProxyError(500, 'proxy_config_error', 'ARIS_AUTH_KEY is required on frontend server');
  if (!signatureSecret) throw new ProxyError(500, 'proxy_config_error', 'ARIS_AUTH_SIGNATURE_SECRET is required on frontend server');

  return { baseUrl, authKey, signatureSecret, timeoutMs };
}

function ensureBackendPath(path: string): string {
  const normalized = String(path || '').trim();
  if (!normalized.startsWith('/api/v3/')) {
    throw new ProxyError(500, 'proxy_path_error', `backend path must start with /api/v3/: ${normalized}`);
  }
  return normalized;
}

function buildTargetUrl(baseUrl: string, backendPath: string, query?: URLSearchParams | string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const q = typeof query === 'string' ? query : query?.toString() || '';
  return q ? `${base}${backendPath}?${q}` : `${base}${backendPath}`;
}

export interface BackendRequestOptions {
  method?: string;
  backendPath: string;
  query?: URLSearchParams | string;
  body?: unknown;
  headers?: HeadersInit;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function requestBackend(options: BackendRequestOptions): Promise<Response> {
  const envCfg = getProxyEnv(options.env || process.env);
  const method = String(options.method || 'GET').toUpperCase();
  const backendPath = ensureBackendPath(options.backendPath);
  const url = buildTargetUrl(envCfg.baseUrl, backendPath, options.query);
  const timeoutMs = clampInt(options.timeoutMs ?? envCfg.timeoutMs, 1000, 180000, envCfg.timeoutMs);

  const signedHeaders = buildSignedHeaders({
    method,
    routePath: backendPath,
    authKey: envCfg.authKey,
    signatureSecret: envCfg.signatureSecret
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = new Headers(options.headers || {});
  for (const [k, v] of Object.entries(signedHeaders)) {
    headers.set(k, v);
  }
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  try {
    const upstream = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      cache: 'no-store'
    });
    return upstream;
  } catch (err) {
    const msg = String((err as Error)?.message || err || 'proxy_failed');
    if ((err as Error)?.name === 'AbortError') {
      throw new ProxyError(504, 'proxy_timeout', `upstream timeout after ${timeoutMs}ms`);
    }
    throw new ProxyError(502, 'proxy_unavailable', msg);
  } finally {
    clearTimeout(timer);
  }
}

export function buildErrorResponse(err: unknown): Response {
  if (err instanceof ProxyError) {
    return Response.json({
      success: false,
      error: err.code,
      message: err.message
    }, { status: err.status });
  }

  return Response.json({
    success: false,
    error: 'proxy_internal_error',
    message: String((err as Error)?.message || err || 'proxy_internal_error')
  }, { status: 500 });
}

export function buildPassthroughHeaders(upstream: Response, fallbackContentType = 'application/json; charset=utf-8'): Headers {
  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') || fallbackContentType);
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) headers.set('x-request-id', requestId);
  return headers;
}
