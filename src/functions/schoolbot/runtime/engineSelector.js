function stableBucket(seed) {
  const text = String(seed || 'default');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100;
}

function normalizeMode(mode) {
  const value = String(mode || '').toLowerCase();
  if (value === 'v2' || value === 'shadow' || value === 'legacy') return value;
  return 'legacy';
}

function pickByPercent(percent, bucket) {
  return bucket < Math.max(0, Math.min(100, Number(percent) || 0));
}

function selectSchoolBotEngine({
  requestId,
  userId,
  runtimeConfig,
  overrideMode = null,
  overridePercent = null
} = {}) {
  const cfg = runtimeConfig || {};
  const mode = normalizeMode(overrideMode || cfg.engine?.mode || 'legacy');
  const percent = Math.max(0, Math.min(100, Number(overridePercent ?? cfg.engine?.v2Percent ?? 0) || 0));
  const bucketSeed = `${String(userId || '')}:${String(requestId || '')}`;
  const bucket = stableBucket(bucketSeed);

  if (mode === 'legacy') {
    return {
      mode,
      primary: 'legacy',
      shadow: null,
      percent,
      bucket,
      sampledToV2: false
    };
  }

  if (mode === 'shadow') {
    return {
      mode,
      primary: 'legacy',
      shadow: pickByPercent(percent, bucket) ? 'v2' : null,
      percent,
      bucket,
      sampledToV2: pickByPercent(percent, bucket)
    };
  }

  const sampled = pickByPercent(percent, bucket);
  return {
    mode,
    primary: sampled ? 'v2' : 'legacy',
    shadow: sampled ? null : null,
    percent,
    bucket,
    sampledToV2: sampled
  };
}

module.exports = {
  selectSchoolBotEngine,
  stableBucket
};
