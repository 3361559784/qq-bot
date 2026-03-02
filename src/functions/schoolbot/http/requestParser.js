function getRequestId(request, fallbackBody = null) {
  const headerRid = (() => {
    try {
      return request?.headers?.get('x-request-id') || request?.headers?.get('x-correlation-id') || null;
    } catch {
      return null;
    }
  })();

  const bodyRid = fallbackBody?.requestId ? String(fallbackBody.requestId) : null;
  return headerRid || bodyRid || `rid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function parseBodySafely(request) {
  try {
    const bodyText = await request.text();
    if (!bodyText) return null;
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

module.exports = {
  getRequestId,
  parseBodySafely
};
