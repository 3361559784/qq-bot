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
 * 目标：避免消耗 gpt-4o 的每日请求，把 gpt-4o 留给图像专用。
 */
function getTextModels() {
  const envModels = parseCsv(process.env.ARIS_TEXT_MODELS);
  // 默认：尽量用“免费/低成本 & 可用性高”的 GitHub Models 文本模型做兜底链。
  // 注意：这里刻意不包含 gpt-4o（留给图像专用）。
  const models = envModels.length > 0
    ? envModels
    : [
        'gpt-4o-mini',
        'gpt-4.1-mini',
        'microsoft/phi-4-mini-instruct',
        'microsoft/phi-4',
        'Phi-4',
        'deepseek/deepseek-v3-0324',
        'mistral-ai/mistral-small-2503',
        'meta/llama-3.3-70b-instruct',
        // 兼容部分仓库/旧命名
        'Meta-Llama-3-70B-Instruct',
        'Meta-Llama-3-8B-Instruct',
        'Llama-3.3-70B-Instruct',
        // 额外可选兜底（不同租户可能不开放，失败会被 fallback 逻辑跳过/标记）
        'AI21-Jamba-Instruct'
      ];
  return uniq(models);
}

/**
 * 意图路由（Perception）模型链。
 * - 首选 ARIS_INTENT_MODEL（兼容旧变量）
 * - 可用 ARIS_INTENT_MODELS 覆盖为逗号分隔列表
 * - 自动追加 gpt-4o-mini 作为最后兜底（避免选了不存在模型导致完全不可用）
 */
function getIntentModels() {
  const envList = parseCsv(process.env.ARIS_INTENT_MODELS);
  const primary = process.env.ARIS_INTENT_MODEL;

  // 意图路由属于纯文本 JSON 分类：优先便宜稳定，避免占用 gpt-4o。
  const models = envList.length > 0
    ? envList
    : [
        primary || 'gpt-4o-mini',
        'gpt-4.1-mini',
        'microsoft/phi-4-mini-instruct',
        'microsoft/phi-4',
        'Phi-4',
        'mistral-ai/mistral-small-2503',
        'deepseek/deepseek-v3-0324',
        'meta/llama-3.3-70b-instruct',
        'Meta-Llama-3-8B-Instruct',
        'AI21-Jamba-Instruct'
      ];
  if (!models.includes('gpt-4o-mini')) models.push('gpt-4o-mini');

  // 明确不把 gpt-4o 放进“纯文本意图路由”链路
  return uniq(models.filter(m => m !== 'gpt-4o'));
}

/**
 * 视觉（图像）模型链。
 * 默认只用 gpt-4o，确保 gpt-4o 专门处理图像。
 * 如需在 gpt-4o 限流时自动降级，可设置：ARIS_VISION_ALLOW_MINI_FALLBACK=true
 */
function getVisionModels() {
  const envList = parseCsv(process.env.ARIS_VISION_MODELS);
  const models = envList.length > 0 ? envList : ['gpt-4o'];

  if (String(process.env.ARIS_VISION_ALLOW_MINI_FALLBACK).toLowerCase() === 'true') {
    if (!models.includes('gpt-4o-mini')) models.push('gpt-4o-mini');
  }

  // vision 链路允许 gpt-4o（以及可选 gpt-4o-mini）
  return uniq(models);
}

/**
 * OCR 文本解析（非图像输入）使用的模型。
 * 默认使用 gpt-4o-mini，避免占用 gpt-4o 配额。
 */
function getOcrParseModel() {
  return process.env.ARIS_OCR_PARSE_MODEL || 'gpt-4o-mini';
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
