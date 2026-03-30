function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function parseJsonBody(request) {
  try {
    const raw = await request.text();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function sseHeaders(extra = {}) {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...extra
  };
}

function encodeSse(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${payload}\n\n`;
}

function safeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function pickLanguage(text) {
  const str = String(text || '');
  if (!str) return 'zh';
  if (/[ぁ-んァ-ヶ]/.test(str)) return 'ja';
  const latin = (str.match(/[A-Za-z]/g) || []).length;
  const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length;
  if (latin > cjk && latin > 2) return 'en';
  return 'zh';
}

function containsAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function trimContent(text, limit = 6000) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  return `${s.slice(0, Math.max(0, limit - 3))}...`;
}

module.exports = {
  nowIso,
  generateId,
  clampNumber,
  parseJsonBody,
  jsonResponse,
  sseHeaders,
  encodeSse,
  safeLower,
  pickLanguage,
  containsAny,
  trimContent
};
