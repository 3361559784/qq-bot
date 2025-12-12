/*
  用途：本地验证 GitHub Models (models.inference.ai.azure.com) 是否支持当前配置的模型名。

  运行：
    GITHUB_TOKEN=... node tests/test-github-models-availability.js

  注意：不会打印 token。
*/

const { OpenAI } = require('openai');

const fs = require('fs');
const path = require('path');

let token = process.env.GITHUB_TOKEN;
if (!token) {
  try {
    const settingsPath = path.join(__dirname, '..', 'local.settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      token = parsed?.Values?.GITHUB_TOKEN;
    }
  } catch {
    // ignore
  }
}

if (!token) {
  console.error('Missing GITHUB_TOKEN (env or local.settings.json Values.GITHUB_TOKEN).');
  console.error('Run: GITHUB_TOKEN=... node tests/test-github-models-availability.js');
  process.exit(2);
}

const BASE_URL = 'https://models.inference.ai.azure.com';

const MODELS = [
  // Perception/Intent
  'gpt-4o-mini',
  'gpt-4o',
  'Llama-3.3-70B-Instruct',
  // Response
  'Mistral-large-2407',
  'Cohere-command-r-plus'
];

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function classifyError(err) {
  const status = err?.status || err?.response?.status;
  const msg = String(err?.message || err || '');
  const lower = msg.toLowerCase();
  if (status === 404 || lower.includes('unknown model') || (lower.includes('model') && lower.includes('not found')) || (lower.includes('does not exist') && lower.includes('model'))) {
    return 'UNSUPPORTED_MODEL';
  }
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  return 'OTHER';
}

async function main() {
  const client = new OpenAI({ baseURL: BASE_URL, apiKey: token });
  const models = uniq(MODELS);

  console.log(`Testing ${models.length} models against ${BASE_URL}`);

  const results = [];
  for (const model of models) {
    try {
      const resp = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }]
      });
      const ok = Boolean(resp?.choices?.[0]?.message?.content);
      results.push({ model, ok: ok ? 'OK' : 'EMPTY' });
      console.log(`[OK] ${model}`);
    } catch (err) {
      const kind = classifyError(err);
      const status = err?.status || err?.response?.status;
      console.log(`[FAIL:${kind}] ${model} status=${status || 'N/A'} msg=${String(err?.message || err).slice(0, 120)}`);
      results.push({ model, ok: `FAIL:${kind}` });
    }
  }

  const okCount = results.filter(r => r.ok === 'OK').length;
  console.log(`Done. OK=${okCount}/${results.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
