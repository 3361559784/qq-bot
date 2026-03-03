function makeRequestLike(request, body = {}) {
  const headersObj = request.headers || {};
  const queryObj = request.query || {};

  return {
    method: request.method,
    headers: {
      get: (key) => headersObj[String(key || '').toLowerCase()] || null
    },
    query: {
      get: (key) => {
        const val = queryObj[String(key || '')];
        if (val === undefined || val === null) return null;
        return String(val);
      }
    },
    text: async () => JSON.stringify(body || {}),
    json: async () => (body || {})
  };
}

function jsonBody(response) {
  if (!response) return null;
  if (response.jsonBody && typeof response.jsonBody === 'object') return response.jsonBody;
  if (typeof response.body === 'string') {
    try {
      return JSON.parse(response.body);
    } catch {
      return { message: response.body };
    }
  }
  if (response.body && typeof response.body === 'object') return response.body;
  return null;
}

module.exports = {
  makeRequestLike,
  jsonBody
};
