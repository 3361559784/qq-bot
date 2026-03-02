const { OpenAI } = require('openai');
const { getResponseModelCfgs } = require('../../../services/modelRouter');

let cachedClient = null;

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

function pickModelChain() {
  const cfgs = getResponseModelCfgs();
  return cfgs && cfgs.length ? cfgs.map((x) => x.name) : ['openai/gpt-4o-mini'];
}

async function chatWithFallback(messages, options = {}, context = null) {
  const client = getClient();
  if (!client) {
    return {
      content: '',
      model: 'none',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      error: 'missing_token'
    };
  }

  const models = options.models && options.models.length ? options.models : pickModelChain();
  const temperature = Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.4;
  const maxTokens = Number.isFinite(Number(options.max_tokens)) ? Number(options.max_tokens) : 900;

  let lastError = null;
  for (const model of models) {
    try {
      const resp = await client.chat.completions.create({
        model,
        temperature,
        max_tokens: maxTokens,
        messages
      });
      const content = resp.choices?.[0]?.message?.content || '';
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
      context?.log?.(`[v2/llm] model ${model} failed: ${err.message}`);
    }
  }

  return {
    content: '',
    model: 'failed',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    error: lastError ? lastError.message : 'unknown_error'
  };
}

module.exports = {
  chatWithFallback
};
