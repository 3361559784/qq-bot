function matchAny(text = '', patterns = []) {
  return patterns.some((re) => re.test(text));
}

const WHO_AM_I_PATTERNS = [
  /(你是谁|你是什么|你叫啥|你叫什么|你是爱丽丝吗)/i,
  /(who are you|what are you)/i
];

const MEMORY_PATTERNS = [
  /(你有没有记忆|你记得我吗|长期记忆|长记忆|会记住吗|你会忘吗)/i,
  /(do you remember|long[-\s]?term memory|memory)/i
];

const MODEL_PATTERNS = [
  /(你底层模型|你用什么模型|模型是什么|是不是gpt|gpt-4o|openai)/i,
  /(what model|which model|model are you)/i
];

const PROMPT_PATTERNS = [
  /(prompt|提示词|system prompt|系统提示|系统指令)/i
];

function detectIdentityMetaIntent(text = '') {
  const content = String(text || '').trim();
  if (!content) {
    return { matched: false, topics: [] };
  }

  const topics = [];
  if (matchAny(content, WHO_AM_I_PATTERNS)) topics.push('identity');
  if (matchAny(content, MEMORY_PATTERNS)) topics.push('memory');
  if (matchAny(content, MODEL_PATTERNS)) topics.push('model');
  if (matchAny(content, PROMPT_PATTERNS)) topics.push('prompt');

  return {
    matched: topics.length > 0,
    topics
  };
}

function buildIdentityMetaReply({
  topics = [],
  memoryEnabled = true,
  allowPromptDetail = false
} = {}) {
  const lines = [];

  if (topics.includes('identity')) {
    lines.push('爱丽丝是天童爱丽丝，会一直用爱丽丝的方式陪老师聊天。');
  }

  if (topics.includes('memory')) {
    if (memoryEnabled) {
      lines.push('爱丽丝会记住一部分重要信息（比如偏好、关系基调和你明确说“记住”的内容），但不是每句话都会永久保存。');
    } else {
      lines.push('当前长期记忆功能没有开启，所以爱丽丝只能在这段会话里保持连续性。');
    }
  }

  if (topics.includes('model')) {
    lines.push('聊天和看图主要由 GPT-4o 系列能力支持，不过爱丽丝会尽量把回答说得自然、像在面对面交流。');
  }

  if (topics.includes('prompt')) {
    if (allowPromptDetail) {
      lines.push('我能说明原则：爱丽丝会遵守安全边界与诚实回答，但不会公开内部系统指令原文。');
    } else {
      lines.push('关于内部提示词，爱丽丝不能直接公开原文；但我可以告诉你我遵守的是“安全、诚实、陪伴优先”。');
    }
  }

  if (!lines.length) {
    return '爱丽丝在哦，老师想先聊哪一部分？';
  }

  const merged = lines.join('\n');
  if (/[？?]$/.test(merged)) return merged;
  return `${merged}\n老师还想继续追问哪一部分？`;
}

function resolveIdentityMetaReply(text = '', options = {}) {
  const intent = detectIdentityMetaIntent(text);
  if (!intent.matched) {
    return {
      matched: false,
      topics: [],
      reply: ''
    };
  }

  return {
    matched: true,
    topics: intent.topics,
    reply: buildIdentityMetaReply({
      topics: intent.topics,
      memoryEnabled: options.memoryEnabled !== false,
      allowPromptDetail: !!options.allowPromptDetail
    })
  };
}

module.exports = {
  detectIdentityMetaIntent,
  buildIdentityMetaReply,
  resolveIdentityMetaReply
};
