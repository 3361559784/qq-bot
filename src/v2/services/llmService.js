const { OpenAI } = require('openai');

let cachedClient = null;

const DEFAULT_MODEL_CHAIN = Object.freeze([
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini'
]);

function getClient() {
  if (cachedClient) return cachedClient;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_MODELS_TOKEN;
  if (!token) return null;
  cachedClient = new OpenAI({
    baseURL: 'https://models.github.ai/inference',
    apiKey: token
  });
  return cachedClient;
}

function pickModelChain(options = {}) {
  if (Array.isArray(options.models) && options.models.length > 0) {
    return options.models.filter(Boolean);
  }
  return [...DEFAULT_MODEL_CHAIN];
}

function isGpt5Family(model = '') {
  return /^gpt-5(?:$|-)/i.test(String(model || '').trim());
}

function getErrorStatus(err) {
  return Number(err?.status || err?.statusCode || err?.response?.status || 0) || 0;
}

function shouldFallbackOnError(err) {
  const status = getErrorStatus(err);
  const msg = String(err?.message || '').toLowerCase();

  if (status === 400) return false; // 参数错误，不允许 fallback 掩盖 bug
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;

  if (msg.includes('timeout') || msg.includes('timed out')) return true;
  if (msg.includes('model unavailable') || msg.includes('unknown model') || msg.includes('no such model')) return true;

  return false;
}

function createUsageZero() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function resolveMaxTokenLimit(options = {}) {
  const raw = options.max_completion_tokens ?? options.max_tokens;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

const MAX_VISION_IMAGE_BYTES = 4 * 1024 * 1024;

function extractResponseText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (part.type === 'text') return String(part.text || '');
      return '';
    })
    .join('')
    .trim();
}

function inferImageMimeType(imageUrl = '', headerType = '') {
  const byHeader = String(headerType || '').split(';')[0].trim().toLowerCase();
  if (byHeader.startsWith('image/')) return byHeader;

  const clean = String(imageUrl || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/jpeg';
}

async function convertImageUrlToDataUrl(imageUrl, context = null) {
  const raw = String(imageUrl || '').trim();
  if (!raw) return '';
  if (raw.startsWith('data:image/')) return raw;
  if (!/^https?:\/\//i.test(raw)) return raw;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    clearTimeout(timer);

    if (!resp.ok) {
      context?.log?.(`[v2/vision] image fetch failed status=${resp.status} url=${raw}`);
      return raw;
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return raw;
    if (buf.length > MAX_VISION_IMAGE_BYTES) {
      context?.log?.(`[v2/vision] image too large for inline upload size=${buf.length}`);
      return raw;
    }

    const mime = inferImageMimeType(raw, resp.headers.get('content-type'));
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    context?.log?.(`[v2/vision] inline image fetch failed: ${err.message}`);
    return raw;
  }
}

function buildVisionMessages({ imageUrl, question = '', supplementalText = '' } = {}) {
  const textBlocks = [];
  textBlocks.push(`用户问题：${String(question || '').trim() || '请直接理解这张图在表达什么。'}`);

  if (String(supplementalText || '').trim()) {
    textBlocks.push(`辅助识别结果（仅作补充，不要被它绑死）：${String(supplementalText).trim()}`);
  }

  textBlocks.push([
    '请直接用中文回答。',
    '如果这是表情包、动漫图、reaction image 或聊天截图，优先解释它传达的情绪、语气、态度和常见表达效果。',
    '不要只做生硬的“物体描述”。',
    '只根据可见内容回答；不确定时明确说不确定。'
  ].join(' '));

  return [
    {
      role: 'system',
      content: [
        '你负责图像理解。',
        '回答要像正常聊天，不要客服腔。',
        '对表情包、动漫图、二次元 reaction image，重点说情绪、动作、氛围和它大概率在表达什么。',
        '如果图里有文字，顺手提取关键文字；如果没有，不要硬编。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: textBlocks.join('\n\n') },
        { type: 'image_url', image_url: { url: String(imageUrl || '').trim() } }
      ]
    }
  ];
}

async function chatWithFallback(messages, options = {}, context = null) {
  const client = getClient();
  if (!client) {
    return {
      content: '',
      model: 'none',
      usage: createUsageZero(),
      error: 'missing_token'
    };
  }

  const models = pickModelChain(options);
  const temperature = Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.4;
  const maxTokens = resolveMaxTokenLimit(options);

  let lastError = null;
  for (const model of models) {
    const req = {
      model,
      temperature,
      messages
    };

    if (maxTokens !== null) {
      if (isGpt5Family(model)) {
        req.max_completion_tokens = maxTokens;
      } else {
        req.max_tokens = maxTokens;
      }
    }

    try {
      const resp = await client.chat.completions.create(req);
      const content = extractResponseText(resp.choices?.[0]?.message?.content);
      return {
        content,
        model,
        usage: {
          prompt_tokens: resp.usage?.prompt_tokens || 0,
          completion_tokens: resp.usage?.completion_tokens || 0,
          total_tokens: resp.usage?.total_tokens || 0
        },
        error: null
      };
    } catch (err) {
      lastError = err;

      const status = getErrorStatus(err);
      const fallback = shouldFallbackOnError(err);
      context?.log?.(`[v2/llm] model ${model} failed status=${status || 'n/a'} fallback=${fallback}: ${err.message}`);

      if (!fallback) {
        break;
      }
    }
  }

  return {
    content: '',
    model: 'failed',
    usage: createUsageZero(),
    error: lastError ? lastError.message : 'unknown_error'
  };
}

async function analyzeImageWithFallback(input = {}, options = {}, context = null) {
  const imageUrl = String(input.imageUrl || input.image_url || '').trim();
  if (!imageUrl) {
    return {
      content: '',
      model: 'none',
      usage: createUsageZero(),
      error: 'missing_image_url'
    };
  }

  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/gpt-4.1-mini'];

  const preparedImageUrl = await convertImageUrlToDataUrl(imageUrl, context);
  const messages = buildVisionMessages({
    imageUrl: preparedImageUrl,
    question: input.question || input.query || '',
    supplementalText: input.supplementalText || input.cvText || ''
  });

  const visionMaxTokens = resolveMaxTokenLimit(options);
  const chatOptions = {
    models,
    temperature: 0.25
  };

  if (visionMaxTokens !== null) {
    chatOptions.max_tokens = visionMaxTokens;
  }

  return chatWithFallback(messages, chatOptions, context);
}

module.exports = {
  chatWithFallback,
  analyzeImageWithFallback,
  buildVisionMessages,
  extractResponseText,
  convertImageUrlToDataUrl,
  resolveMaxTokenLimit
};
