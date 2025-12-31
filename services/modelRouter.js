function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function uniq(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function toModelCfgs(modelNames, temperature) {
  return uniq(modelNames).map(name => ({ name, temp: temperature }));
}

/**
 * 纯文本（聊天/意图/计划/工具编排）默认模型链。
 * 
 * 🔄 2024-12-30 更新：
 * - 端点迁移到 https://models.github.ai/inference
 * - 模型 ID 格式: {publisher}/{model_name}
 * - 参考: https://docs.github.com/en/rest/models/catalog
 */
function getTextModels() {
  const envModels = parseCsv(process.env.ARIS_TEXT_MODELS);
  const models = envModels.length > 0
    ? envModels
    : [
        // OpenAI 系列（优先使用, Low tier）
        'openai/gpt-4o-mini',             // 首选：便宜、快速
        'openai/gpt-4.1-mini',            // 备用
        'openai/gpt-4.1-nano',            // 极低成本
        // Microsoft Phi 系列 (Low tier)
        'microsoft/phi-4-mini-instruct',
        'microsoft/phi-4',
        // Meta Llama 系列
        'meta/meta-llama-3.1-8b-instruct',  // Low tier
        'meta/llama-3.3-70b-instruct',      // High tier
        // Mistral 系列 (Low tier)
        'mistral-ai/mistral-small-2503',
        'mistral-ai/ministral-3b',
        // DeepSeek (High tier)
        'deepseek/deepseek-v3-0324',
        // Cohere (Low tier)
        'cohere/cohere-command-r-08-2024'
      ];
  return uniq(models);
}

/**
 * 意图路由（Perception）模型链。
 */
function getIntentModels() {
  const envList = parseCsv(process.env.ARIS_INTENT_MODELS);
  const primary = process.env.ARIS_INTENT_MODEL;

  const models = envList.length > 0
    ? envList
    : [
        primary || 'openai/gpt-4o-mini',
        'openai/gpt-4.1-mini',
        'microsoft/phi-4-mini-instruct',
        'microsoft/phi-4',
        'mistral-ai/mistral-small-2503',
        'meta/meta-llama-3.1-8b-instruct',
        'deepseek/deepseek-v3-0324'
      ];
  if (!models.includes('openai/gpt-4o-mini')) models.push('openai/gpt-4o-mini');

  return uniq(models.filter(m => m !== 'openai/gpt-4o'));
}

/**
 * 视觉（图像）模型链。
 */
function getVisionModels() {
  const envList = parseCsv(process.env.ARIS_VISION_MODELS);
  const models = envList.length > 0 ? envList : ['openai/gpt-4o'];

  if (String(process.env.ARIS_VISION_ALLOW_MINI_FALLBACK).toLowerCase() === 'true') {
    if (!models.includes('openai/gpt-4o-mini')) models.push('openai/gpt-4o-mini');
  }

  return uniq(models);
}

/**
 * OCR 文本解析模型。
 */
function getOcrParseModel() {
  return process.env.ARIS_OCR_PARSE_MODEL || 'openai/gpt-4o-mini';
}

function getPerceptionModelCfgs() {
  return toModelCfgs(getIntentModels(), 0.1);
}

function getResponseModelCfgs() {
  return toModelCfgs(getTextModels(), 0.9);
}

module.exports = {
  getTextModels,
  getIntentModels,
  getVisionModels,
  getOcrParseModel,
  getPerceptionModelCfgs,
  getResponseModelCfgs
};
