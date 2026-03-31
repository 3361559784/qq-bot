const DEFAULT_CAPABILITY_PLAN = Object.freeze({
  mode: 'chat',
  capabilities: ['none'],
  reason: 'default_chat',
  requires_clarification: false
});

function hasImageAttachment(req = {}) {
  return Array.isArray(req.attachments) && req.attachments.some((x) => String(x?.type || '').toLowerCase() === 'image');
}

function firstImage(req = {}) {
  if (!Array.isArray(req.attachments)) return null;
  return req.attachments.find((x) => String(x?.type || '').toLowerCase() === 'image') || null;
}

function parseLocation(text = '') {
  const hit = String(text).match(/(北京|上海|广州|深圳|武汉|杭州|成都|西安|南京|重庆|天津|苏州|长沙|郑州|青岛|沈阳|大连|厦门|福州)/);
  return hit ? hit[1] : null;
}

function isThoughtTranslate(text = '') {
  return /翻译我的想法|想法翻译|整理成一句话|润色一下想法|thought\s*translate/i.test(String(text));
}

function planCapabilities(req = {}) {
  const text = String(req.content || '').trim();
  const lower = text.toLowerCase();

  if (!text) return { ...DEFAULT_CAPABILITY_PLAN, reason: 'empty_message' };

  const image = firstImage(req);
  const withImage = !!image || hasImageAttachment(req);

  // 先判附件型能力
  if (withImage) {
    if (/课表|课程表|timetable|schedule|ocr|识别课表/i.test(lower)) {
      return {
        mode: 'capability',
        capabilities: ['ocr', 'schedule'],
        reason: 'image_schedule_signal',
        requires_clarification: false
      };
    }
    return {
      mode: 'capability',
      capabilities: ['vision'],
      reason: 'image_signal',
      requires_clarification: false
    };
  }

  // 明确工具信号才触发能力，不默认预取
  if (/画一张|画个|绘图|画图|draw\s+(an?|a)|generate\s+image|生成.*图/i.test(lower)) {
    return {
      mode: 'capability',
      capabilities: ['draw'],
      reason: 'draw_signal',
      requires_clarification: false
    };
  }

  // 天气保留为独立 capability
  if (/天气|温度|下雨|weather/i.test(lower)) {
    const hasLocation = !!parseLocation(text);
    return {
      mode: 'capability',
      capabilities: ['weather'],
      reason: 'weather_signal',
      requires_clarification: !hasLocation
    };
  }

  // 移除显式 search capability，统一走 knowledge router

  if (/课表|课程表|明天有课|今天有课|下一节课|下节课|本周课表|下周课表/i.test(lower)) {
    return {
      mode: 'capability',
      capabilities: ['schedule'],
      reason: 'schedule_signal',
      requires_clarification: false
    };
  }

  if (isThoughtTranslate(text)) {
    return {
      mode: 'chat',
      capabilities: ['none'],
      reason: 'thought_translate_chat_mode',
      requires_clarification: false
    };
  }

  return { ...DEFAULT_CAPABILITY_PLAN };
}

module.exports = {
  DEFAULT_CAPABILITY_PLAN,
  planCapabilities,
  parseLocation,
  isThoughtTranslate
};
