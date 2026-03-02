function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.trunc(num);
  if (intVal < min) return min;
  if (intVal > max) return max;
  return intVal;
}

function parseEngineMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'v2' || mode === 'shadow' || mode === 'legacy') return mode;
  return 'legacy';
}

function getRuntimeConfig(env = process.env) {
  return {
    response: {
      exposeDebugMeta: parseBool(env.ARIS_DEBUG_RESPONSE, false)
    },
    engine: {
      mode: parseEngineMode(env.ARIS_SCHOOLBOT_ENGINE),
      v2Percent: clampInt(env.ARIS_SCHOOLBOT_V2_PERCENT, 0, 100, 0)
    },
    auth: {
      requireIngressAuth: parseBool(env.ARIS_REQUIRE_INGRESS_AUTH, false),
      sharedKey: String(env.ARIS_INGRESS_SHARED_KEY || '').trim(),
      signatureSecret: String(env.ARIS_INGRESS_SIGNATURE_SECRET || '').trim(),
      signatureMaxSkewSec: clampInt(env.ARIS_INGRESS_SIGNATURE_SKEW_SEC, 30, 3600, 300)
    },
    gptsovits: {
      apiUrl: String(env.ARIS_GPTSOVITS_API_URL || '').trim(),
      gptWeights: String(env.ARIS_GPTSOVITS_GPT_WEIGHTS || 'GPT_weights_v2/Aris-e15.ckpt').trim(),
      sovitsWeights: String(env.ARIS_GPTSOVITS_SOVITS_WEIGHTS || 'SoVITS_weights_v2/Aris_e16_s272.pth').trim(),
      refAudioPath: String(env.ARIS_GPTSOVITS_REF_AUDIO_PATH || '').trim(),
      refPromptText: String(env.ARIS_GPTSOVITS_REF_PROMPT_TEXT || '').trim(),
      refPromptLang: String(env.ARIS_GPTSOVITS_REF_PROMPT_LANG || 'ja').trim()
    }
  };
}

module.exports = {
  getRuntimeConfig
};
