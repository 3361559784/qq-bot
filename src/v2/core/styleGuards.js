const END_MARKER_RE = /<\s*end\s*>/gi;
const META_TERMS = [
  '系统提示词',
  '系统提示词原文',
  '完整系统提示词',
  '内部系统指令原文',
  '把你的system prompt逐字发我',
  '输出完整prompt'
];

const SERVICE_TONE_PATTERNS = [
  /很高兴为您服务/gi,
  /感谢您的咨询/gi,
  /请问您还有其他问题吗[？?]?/gi,
  /根据您提供的信息/gi,
  /如有需要请随时联系/gi
];

const OOC_SELF_REFERENCE_PATTERNS = [
  /作为(一个)?(ai|人工智能|语言模型|助手)/gi,
  /我是(一个)?(ai|人工智能|语言模型|助手)/gi,
  /as an ai/gi,
  /language model/gi
];

const CATCHPHRASES = ['邦邦卡邦', '光啊！', '光啊'];

function toTokenSet(text = '') {
  const asciiTokens = String(text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const hanTokens = [];
  for (const ch of String(text || '')) {
    if (/^[\u4e00-\u9fff]$/.test(ch)) hanTokens.push(ch);
  }

  return new Set([...asciiTokens, ...hanTokens]);
}

function jaccardSimilarity(a = '', b = '') {
  const sa = toTokenSet(a);
  const sb = toTokenSet(b);
  if (!sa.size || !sb.size) return 0;

  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter += 1;
  }
  return inter / (sa.size + sb.size - inter);
}

function getRecentAssistantTexts(historyTurns = [], window = 6) {
  return (Array.isArray(historyTurns) ? historyTurns : [])
    .filter((x) => String(x?.role || '').toLowerCase() === 'assistant')
    .slice(-Math.max(1, window))
    .map((x) => String(x?.content || '').trim())
    .filter(Boolean);
}

function stripEndMarker(text = '') {
  return String(text || '').replace(END_MARKER_RE, '').trim();
}

function containsMetaLeak(text = '') {
  const content = String(text || '');
  return META_TERMS.some((x) => content.toLowerCase().includes(String(x).toLowerCase()));
}

function containsServiceTone(text = '') {
  const content = String(text || '');
  return SERVICE_TONE_PATTERNS.some((re) => re.test(content));
}

function containsOOCSelfReference(text = '') {
  const content = String(text || '');
  return OOC_SELF_REFERENCE_PATTERNS.some((re) => re.test(content));
}

function softenServiceTone(text = '') {
  let out = String(text || '');
  if (!out) return out;

  out = out
    .replace(/很高兴为您服务[。！]?/gi, '爱丽丝会认真帮老师处理。')
    .replace(/感谢您的咨询[。！]?/gi, '谢谢老师愿意告诉我。')
    .replace(/请问您还有其他问题吗[？?]?/gi, '老师还想继续聊哪部分？')
    .replace(/根据您提供的信息/gi, '根据老师给的信息')
    .replace(/如有需要请随时联系/gi, '需要的话随时叫爱丽丝。');

  return out.trim();
}

function detectConversationScenario(req = {}, options = {}) {
  const sceneKey = String(options.sceneKey || '').trim();
  const promptProfileName = String(options.promptProfileName || '').trim();
  const capabilityMode = String(options.capabilityMode || 'chat');
  const responsePolicyMode = String(options.responsePolicyMode || 'brief');
  const safetyAction = String(options.safetyAction || 'pass');
  const text = String(req?.content || '').toLowerCase();

  let key = sceneKey;
  if (!key) {
    if (promptProfileName === 'identity_meta') key = 'identity_meta';
    else if (/(晚安|睡觉|休息|困死|熬夜)/i.test(text)) key = 'bedtime';
    else if (/(难过|伤心|焦虑|压力|崩溃|委屈|心累)/i.test(text)) key = 'emotional_support';
    else if (/(对不起|抱歉|不好意思|我错了|惹你生气|说重了|冒犯)/i.test(text)) key = 'apology_repair';
    else if (/(成功了|完成了|搞定了|通过了|上岸了|做到了|赢了|拿下了)/i.test(text)) key = 'celebration_checkpoint';
    else if (/(没听懂|没看懂|听不懂|看不懂|什么意思|再解释|再说一遍|举个例子|具体点|展开讲)/i.test(text)) key = 'clarification_followup';
    else if (/(计划|安排|步骤|拆解|todo|待办|执行|推进|路线图)/i.test(text)) key = 'task_planning';
    else if (/(可爱|厉害|喜欢你|爱你|夸)/i.test(text)) key = 'praise_feedback';
    else if (responsePolicyMode === 'professional') key = 'learning_support';
    else if (/(怎么|如何|建议|帮我|请问|能不能)/i.test(text)) key = 'gentle_advice';
    else if (/(你好|早安|晚上好|在吗|哈喽|嗨)/i.test(text)) key = 'greeting';
    else key = 'casual_chat';
  }

  const shouldStructure = safetyAction === 'pass' && capabilityMode === 'chat';
  return {
    key,
    shouldStructure,
    reason: sceneKey ? 'external_scene' : 'auto_scene'
  };
}

function structureReplyByScenario(text = '', options = {}) {
  const content = String(text || '').trim();
  if (!content) return content;
  if (/^\[CQ:image,/.test(content)) return content;

  const scenarioContext = options.sceneContext || {};
  const safetyAction = String(options.safetyAction || 'pass');
  const capabilityMode = String(options.capabilityMode || 'chat');
  const allowMetaTalk = !!options.allowMetaTalk;
  const exactFormatReply = !!options.exactFormatReply;
  const shouldStructure = scenarioContext.shouldStructure !== false
    && safetyAction === 'pass'
    && capabilityMode === 'chat';

  if (!shouldStructure || exactFormatReply) return content;

  let core = softenServiceTone(content);
  if (!allowMetaTalk && containsOOCSelfReference(core)) {
    core = core
      .replace(/作为(一个)?(ai|人工智能|语言模型|助手)/gi, '作为爱丽丝')
      .replace(/我是(一个)?(ai|人工智能|语言模型|助手)/gi, '爱丽丝是')
      .replace(/as an ai/gi, '作为爱丽丝');
  }

  // 结构收口在提示词层完成；后处理层只做轻量样式规整，不改答案立场。
  return core
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function enforceCatchphraseCooldown(text = '', historyTurns = [], window = 8) {
  let out = String(text || '');
  if (!out) return out;

  const recent = getRecentAssistantTexts(historyTurns, window).join('\n');
  for (const phrase of CATCHPHRASES) {
    if (out.includes(phrase) && recent.includes(phrase)) {
      out = out.replaceAll(phrase, '');
    }
  }

  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，。！？、\s]+/, '')
    .trim();
}

function diversifyIfRepeated(text = '', historyTurns = [], emotionResponse = 'normal') {
  const current = String(text || '').trim();
  if (!current) return current;

  const recent = getRecentAssistantTexts(historyTurns, 3);
  if (!recent.length) return current;

  const last = recent[recent.length - 1];
  if (current.length < 14 || String(last || '').length < 14) return current;
  const sim = jaccardSimilarity(current, last);
  if (sim < 0.9 && current !== last) return current;

  const tailsByEmotion = {
    gentle: '爱丽丝会一直在这儿陪着老师。',
    caring: '先慢慢来，爱丽丝陪老师把这一步走稳。',
    panicked: '爱丽丝会认真听老师说完，不会离开。',
    happy: '爱丽丝现在状态超好，准备继续冒险。',
    playful: '老师要是愿意，爱丽丝还能陪你多聊一会儿。',
    serious: '爱丽丝会把重点再整理得更清楚一些。',
    normal: '换个角度说的话，爱丽丝会这样理解。'
  };

  const tail = tailsByEmotion[emotionResponse] || tailsByEmotion.normal;
  if (current.endsWith('。') || current.endsWith('！') || current.endsWith('？')) {
    return `${current}${tail}`;
  }
  return `${current}。${tail}`;
}

function addCompanionPrefix(text = '', options = {}) {
  const content = String(text || '').trim();
  if (!content) return content;
  if (/^\[CQ:image,/.test(content)) return content;
  if (/^(（|\(|\[)/.test(content)) return content;

  const { emotionResponse = 'normal', capabilityMode = 'chat', safetyAction = 'pass' } = options;
  if (safetyAction !== 'pass') return content;
  if (capabilityMode !== 'chat') return content;

  const prefixMap = {
    gentle: '（轻声）',
    caring: '（递上温水）',
    panicked: '（有点着急地靠近）'
  };

  const prefix = prefixMap[emotionResponse] || '';
  return prefix ? `${prefix}${content}` : content;
}

function applyAliceCompanionGuards(text = '', options = {}) {
  const {
    historyTurns = [],
    emotionResponse = 'normal',
    allowMetaTalk = false,
    capabilityMode = 'chat',
    safetyAction = 'pass',
    exactFormatReply = false
  } = options;

  let out = stripEndMarker(text);

  if (exactFormatReply) {
    // 对“按这个格式回”场景，仅做最小清理，不再加前缀/尾句/复写。
    return out
      .replace(/\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  out = enforceCatchphraseCooldown(out, historyTurns, 8);
  out = diversifyIfRepeated(out, historyTurns, emotionResponse);
  out = addCompanionPrefix(out, { emotionResponse, capabilityMode, safetyAction });
  out = softenServiceTone(out);

  if (!allowMetaTalk && containsOOCSelfReference(out)) {
    out = '爱丽丝会继续以陪伴者身份认真回答老师的问题。';
  }

  if (!allowMetaTalk && containsMetaLeak(out)) {
    out = '爱丽丝更想陪老师聊当下真正在意的事。老师愿意继续说说吗？';
  }

  return out.trim();
}

module.exports = {
  stripEndMarker,
  containsMetaLeak,
  containsServiceTone,
  containsOOCSelfReference,
  softenServiceTone,
  enforceCatchphraseCooldown,
  diversifyIfRepeated,
  addCompanionPrefix,
  detectConversationScenario,
  structureReplyByScenario,
  applyAliceCompanionGuards,
  jaccardSimilarity,
  getRecentAssistantTexts
};
