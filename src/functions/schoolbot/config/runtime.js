function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function getRuntimeConfig(env = process.env) {
  return {
    response: {
      exposeDebugMeta: parseBool(env.ARIS_DEBUG_RESPONSE, false)
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
