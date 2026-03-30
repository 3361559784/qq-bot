function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'');
}

function normalizeMediaValue(value = '') {
  return decodeHtmlEntities(String(value || '').trim());
}

function isHttpUrl(value = '') {
  return /^https?:\/\//i.test(normalizeMediaValue(value));
}

function pickCandidateUrl(attachment = {}) {
  const candidates = [
    attachment?.url,
    attachment?.file,
    attachment?.raw?.data?.url,
    attachment?.raw?.data?.file,
    attachment?.raw?.data?.path
  ].map((x) => normalizeMediaValue(x)).filter(Boolean);

  return candidates.find((x) => isHttpUrl(x)) || '';
}

function pickFileId(attachment = {}) {
  const candidates = [
    attachment?.file,
    attachment?.raw?.data?.file,
    attachment?.url,
    attachment?.raw?.data?.url,
    attachment?.raw?.data?.path
  ].map((x) => normalizeMediaValue(x)).filter(Boolean);

  return candidates.find((x) => !isHttpUrl(x)) || '';
}

function getNapcatHeaders() {
  const token = String(process.env.NAPCAT_TOKEN || process.env.ONEBOT_TOKEN || '').trim();
  if (!token) {
    return { 'Content-Type': 'application/json' };
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
}

function parseNapcatImageUrl(payload = {}) {
  const direct = [
    payload?.url,
    payload?.data?.url,
    payload?.data?.file,
    payload?.result?.url,
    payload?.result?.file
  ].map((x) => normalizeMediaValue(x)).find((x) => isHttpUrl(x));

  return direct || '';
}

async function resolveViaNapcat(fileId = '', context = null) {
  const base = String(process.env.NAPCAT_API_URL || process.env.ONEBOT_API_URL || '').trim();
  if (!base) return '';

  const endpoint = `${base.replace(/\/+$/, '')}/get_image`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: getNapcatHeaders(),
      body: JSON.stringify({ file: fileId }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      context?.log?.(`[v2/qq-media] get_image failed status=${resp.status}`);
      return '';
    }

    const json = await resp.json().catch(() => ({}));
    const resolved = parseNapcatImageUrl(json);
    if (!resolved) {
      context?.log?.('[v2/qq-media] get_image succeeded but no resolvable url found');
    }
    return resolved;
  } catch (err) {
    clearTimeout(timer);
    context?.log?.(`[v2/qq-media] get_image error: ${err.message}`);
    return '';
  }
}

async function resolveQqImageUrl(attachment = {}, context = null) {
  const direct = pickCandidateUrl(attachment);
  if (direct) return direct;

  const fileId = pickFileId(attachment);
  if (!fileId) return '';

  const resolved = await resolveViaNapcat(fileId, context);
  if (resolved) return resolved;

  context?.log?.(`[v2/qq-media] unresolved image file id: ${fileId}`);
  return '';
}

async function pickFirstResolvedImageUrl(req = {}, context = null) {
  const metadataUrl = normalizeMediaValue(req?.metadata?.image_url || '');
  if (isHttpUrl(metadataUrl)) return metadataUrl;

  const attachments = Array.isArray(req?.attachments) ? req.attachments : [];
  for (const item of attachments) {
    if (String(item?.type || '').toLowerCase() !== 'image') continue;
    // eslint-disable-next-line no-await-in-loop
    const url = await resolveQqImageUrl(item, context);
    if (url) return url;
  }

  return '';
}

module.exports = {
  decodeHtmlEntities,
  normalizeMediaValue,
  isHttpUrl,
  resolveQqImageUrl,
  pickFirstResolvedImageUrl
};
