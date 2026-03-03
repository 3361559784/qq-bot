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

function parseRuntimeProfile(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'host' || mode === 'server') return mode;
  return 'host';
}

function parseTriggerMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'explicit' || mode === 'auto' || mode === 'both') return mode;
  return 'both';
}

function parseConfirmMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'periodic' || mode === 'always' || mode === 'never') return mode;
  return 'periodic';
}

function parseTransportMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'mcp_stdio' || mode === 'http_agent' || mode === 'hybrid') return mode;
  return 'mcp_stdio';
}

function resolveRelayEnabled(env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  const enabled = parseBool(env.ARIS_CU_RELAY_ENABLE_DEV, true);
  const forceProd = parseBool(env.ARIS_CU_RELAY_FORCE_PROD, false);
  if (nodeEnv === 'production' && !forceProd) return false;
  return enabled;
}

function parseRefusalPolicyVersion(value) {
  const ver = String(value || '').trim().toLowerCase();
  return ver || 'relaxed_v1';
}

function getRuntimeConfig(env = process.env) {
  const runtimeProfile = parseRuntimeProfile(env.ARIS_RUNTIME_PROFILE);
  const defaultCuEnabled = runtimeProfile === 'host';
  return {
    response: {
      exposeDebugMeta: parseBool(env.ARIS_DEBUG_RESPONSE, false)
    },
    profile: runtimeProfile,
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
    refusalPolicy: {
      version: parseRefusalPolicyVersion(env.ARIS_REFUSAL_POLICY_VERSION),
      percent: clampInt(env.ARIS_REFUSAL_POLICY_PERCENT, 0, 100, 0),
      modelEnabled: parseBool(env.ARIS_REFUSAL_MODEL_ENABLED, true),
      modelHardMinConf: clampInt(Number(env.ARIS_REFUSAL_MODEL_HARD_MIN_CONF || 0.85) * 100, 0, 100, 85) / 100,
      clarifyMaxRounds: clampInt(env.ARIS_REFUSAL_CLARIFY_MAX_ROUNDS, 0, 5, 1),
      delegatedMode: String(env.ARIS_REFUSAL_DELEGATED_MODE || 'degrade').trim().toLowerCase(),
      hardBlockScope: String(env.ARIS_REFUSAL_HARD_BLOCK_SCOPE || 'minimal').trim().toLowerCase()
    },
    gptsovits: {
      apiUrl: String(env.ARIS_GPTSOVITS_API_URL || '').trim(),
      gptWeights: String(env.ARIS_GPTSOVITS_GPT_WEIGHTS || 'GPT_weights_v2/Aris-e15.ckpt').trim(),
      sovitsWeights: String(env.ARIS_GPTSOVITS_SOVITS_WEIGHTS || 'SoVITS_weights_v2/Aris_e16_s272.pth').trim(),
      refAudioPath: String(env.ARIS_GPTSOVITS_REF_AUDIO_PATH || '').trim(),
      refPromptText: String(env.ARIS_GPTSOVITS_REF_PROMPT_TEXT || '').trim(),
      refPromptLang: String(env.ARIS_GPTSOVITS_REF_PROMPT_LANG || 'ja').trim()
    },
    computerUse: {
      enabled: parseBool(env.ARIS_CU_ENABLED, defaultCuEnabled),
      transport: parseTransportMode(env.ARIS_CU_TRANSPORT),
      triggerMode: parseTriggerMode(env.ARIS_CU_TRIGGER_MODE),
      confirmMode: parseConfirmMode(env.ARIS_CU_CONFIRM_MODE),
      confirmEverySteps: clampInt(env.ARIS_CU_CONFIRM_EVERY_STEPS, 1, 50, 5),
      stepMaxRetry: clampInt(env.ARIS_CU_STEP_MAX_RETRY, 0, 10, 2),
      maxSteps: clampInt(env.ARIS_CU_MAX_STEPS, 1, 200, 30),
      syncWaitMs: clampInt(env.ARIS_CU_SYNC_WAIT_MS, 1000, 180000, 18000),
      leaseTtlSec: clampInt(env.ARIS_CU_LEASE_TTL_SEC, 5, 300, 45),
      remoteEndpoint: String(env.ARIS_CU_REMOTE_ENDPOINT || '').trim(),
      agentToken: String(env.ARIS_CU_AGENT_TOKEN || '').trim(),
      plannerModel: String(env.ARIS_CU_PLANNER_MODEL || 'gpt-4o-mini').trim(),
      mcpServerCmd: String(env.ARIS_CU_MCP_SERVER_CMD || 'python3 main.py').trim(),
      mcpServerCwd: String(env.ARIS_CU_MCP_SERVER_CWD || 'local/mcp-computer-use-server').trim(),
      mcpTimeoutMs: clampInt(env.ARIS_CU_MCP_TIMEOUT_MS, 1000, 180000, 30000),
      openaiBaseUrl: String(env.ARIS_CU_OPENAI_BASE_URL || '').trim(),
      relay: {
        provider: String(env.ARIS_CU_RELAY_PROVIDER || 'chatgpt_plus_poc').trim(),
        enabled: resolveRelayEnabled(env),
        maxRetry: clampInt(env.ARIS_CU_RELAY_MAX_RETRY, 0, 10, 2),
        timeoutMs: clampInt(env.ARIS_CU_RELAY_TIMEOUT_MS, 1000, 180000, 45000),
        browserProfileDir: String(env.ARIS_CU_RELAY_BROWSER_PROFILE_DIR || '').trim(),
        headless: parseBool(env.ARIS_CU_RELAY_HEADLESS, false),
        forceProd: parseBool(env.ARIS_CU_RELAY_FORCE_PROD, false)
      }
    }
  };
}

module.exports = {
  getRuntimeConfig
};
