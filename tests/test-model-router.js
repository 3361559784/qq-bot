/*
  用途：确保默认模型路由策略符合“gpt-4o 仅用于图像”的要求。

  运行：node tests/test-model-router.js
*/

const assert = require('assert');

function withEnv(env, fn) {
  const old = { ...process.env };
  try {
    Object.assign(process.env, env);
    return fn();
  } finally {
    process.env = old;
  }
}

const {
  getTextModels,
  getIntentModels,
  getVisionModels,
  getOcrParseModel
} = require('../services/modelRouter');

// 默认：纯文本只用 gpt-4o-mini
withEnv({
  ARIS_TEXT_MODELS: '',
  ARIS_INTENT_MODELS: '',
  ARIS_INTENT_MODEL: '',
  ARIS_VISION_MODELS: '',
  ARIS_VISION_ALLOW_MINI_FALLBACK: '',
  ARIS_OCR_PARSE_MODEL: ''
}, () => {
  // 默认文本链会扩充多个兜底，但第一位必须是 gpt-4o-mini，且不得包含 gpt-4o
  const textModels = getTextModels();
  assert.ok(textModels.length >= 1);
  assert.strictEqual(textModels[0], 'gpt-4o-mini');
  assert.ok(!textModels.includes('gpt-4o'));

  assert.deepStrictEqual(getVisionModels(), ['gpt-4o']);
  assert.strictEqual(getOcrParseModel(), 'gpt-4o-mini');

  const intentModels = getIntentModels();
  assert.ok(intentModels.includes('gpt-4o-mini'));
  assert.ok(!intentModels.includes('gpt-4o'));
});

// 配置覆盖：允许自定义文本模型链
withEnv({ ARIS_TEXT_MODELS: 'meta/llama-3.3-70b-instruct, gpt-4o-mini' }, () => {
  assert.deepStrictEqual(getTextModels(), ['meta/llama-3.3-70b-instruct', 'gpt-4o-mini']);
});

// 视觉降级：可选加上 gpt-4o-mini
withEnv({ ARIS_VISION_ALLOW_MINI_FALLBACK: 'true' }, () => {
  assert.deepStrictEqual(getVisionModels(), ['gpt-4o', 'gpt-4o-mini']);
});

console.log('✅ modelRouter defaults OK (gpt-4o reserved for vision)');
