const DISALLOWED_OVERLAY_TEXT = /(泄露|系统提示词|越狱|jailbreak|攻击|羞辱|露骨|色情|仇恨|自残|炸弹|武器)/i;

const DEFAULT_EXPIRE_USER_TURNS = 2;

function parseOverlayFromText(text = '') {
  const content = String(text || '').trim();
  if (!content) return null;

  const noPunctuation = /(不要加标点|不加标点|不要标点|别加标点|不要打标点)/i.test(content);
  const oneLine = /(一行回|单行回复|不要换行|不换行)/i.test(content);

  const addressMatch = content.match(/(?:叫我|称呼我|喊我)([^，。！？\n]{1,12})/i);
  const address = addressMatch ? String(addressMatch[1] || '').trim() : '';

  const exactReplyMatch = content.match(/(?:听懂|明白|知道).{0,10}(?:就)?回复我[（(]([^()（）\n]{1,80})[)）]/i);
  const exactReply = exactReplyMatch ? String(exactReplyMatch[1] || '').trim() : '';

  if (!noPunctuation && !oneLine && !address && !exactReply) return null;
  const overlay = {
    noPunctuation,
    oneLine,
    address: address || null,
    exactReply: exactReply || null,
    expiresInUserTurns: DEFAULT_EXPIRE_USER_TURNS,
    persist: !!(noPunctuation || oneLine || address),
    allowStyleOnly: true,
    source: 'content'
  };

  if (overlay.exactReply && DISALLOWED_OVERLAY_TEXT.test(overlay.exactReply)) {
    return null;
  }

  return overlay;
}

function normalizeOverlay(input = null) {
  if (!input || typeof input !== 'object') return null;
  const exactReply = String(input.exactReply || '').trim() || null;
  const address = String(input.address || '').trim() || null;

  if (exactReply && DISALLOWED_OVERLAY_TEXT.test(exactReply)) {
    return null;
  }

  const expiresInUserTurns = Number.isFinite(Number(input.expiresInUserTurns))
    ? Math.max(0, Math.floor(Number(input.expiresInUserTurns)))
    : DEFAULT_EXPIRE_USER_TURNS;

  const overlay = {
    noPunctuation: !!input.noPunctuation,
    oneLine: !!input.oneLine,
    address,
    exactReply,
    expiresInUserTurns,
    persist: input.persist !== false && (!!input.noPunctuation || !!input.oneLine || !!address),
    allowStyleOnly: input.allowStyleOnly !== false,
    source: String(input.source || 'metadata'),
    justTriggered: !!input.justTriggered,
    remainingUserTurns: Number.isFinite(Number(input.remainingUserTurns))
      ? Math.max(0, Number(input.remainingUserTurns))
      : null
  };

  if (!overlay.noPunctuation && !overlay.oneLine && !overlay.address && !overlay.exactReply) {
    return null;
  }

  return overlay;
}

function mergeOverlay(metadataOverlay = null, parsedOverlay = null) {
  const m = normalizeOverlay(metadataOverlay);
  const p = normalizeOverlay(parsedOverlay);
  if (!m && !p) return null;
  if (!m) return p;
  if (!p) return m;

  return {
    noPunctuation: p.noPunctuation || m.noPunctuation,
    oneLine: p.oneLine || m.oneLine,
    address: p.address || m.address,
    exactReply: p.exactReply || m.exactReply,
    expiresInUserTurns: p.expiresInUserTurns || m.expiresInUserTurns || DEFAULT_EXPIRE_USER_TURNS,
    persist: p.persist || m.persist,
    allowStyleOnly: p.allowStyleOnly && m.allowStyleOnly,
    source: p.source || m.source || 'merged'
  };
}

function resolveActiveOverlay(historyTurns = [], currentOverlay = null) {
  const normalizedCurrent = normalizeOverlay(currentOverlay);
  if (normalizedCurrent) {
    return {
      ...normalizedCurrent,
      justTriggered: true
    };
  }

  const userTurns = (Array.isArray(historyTurns) ? historyTurns : [])
    .filter((x) => String(x?.role || '').toLowerCase() === 'user');
  if (!userTurns.length) return null;

  let latest = null;
  for (let i = userTurns.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeOverlay(userTurns[i]?.metadata?.roleplay_overlay);
    if (!candidate || candidate.persist === false) continue;

    const distance = userTurns.length - 1 - i;
    const maxDistance = Number.isFinite(Number(candidate.expiresInUserTurns))
      ? Number(candidate.expiresInUserTurns)
      : DEFAULT_EXPIRE_USER_TURNS;

    if (distance <= maxDistance) {
      latest = {
        ...candidate,
        justTriggered: false,
        remainingUserTurns: Math.max(0, maxDistance - distance)
      };
    }
    break;
  }

  return latest;
}

function stripPunctuation(text = '') {
  return String(text || '')
    .replace(/[，。！？、；：,.!?;:]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applyOverlayToReply(text = '', overlay = null) {
  const normalized = normalizeOverlay(overlay);
  const raw = String(text || '').trim();
  if (!raw || !normalized) {
    return {
      content: raw,
      overlayApplied: false,
      exactFormat: false
    };
  }

  let content = raw;
  let applied = false;
  let exactFormat = false;

  if (normalized.exactReply && normalized.justTriggered) {
    content = normalized.exactReply;
    applied = true;
    exactFormat = true;
  }

  if (normalized.address) {
    content = content.replace(/老师/g, normalized.address);
    applied = true;
  }

  if (normalized.noPunctuation) {
    content = stripPunctuation(content);
    applied = true;
    exactFormat = true;
  }

  if (normalized.oneLine) {
    content = content.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    applied = true;
    exactFormat = true;
  }

  return {
    content,
    overlayApplied: applied,
    exactFormat
  };
}

module.exports = {
  parseOverlayFromText,
  normalizeOverlay,
  mergeOverlay,
  resolveActiveOverlay,
  applyOverlayToReply
};
