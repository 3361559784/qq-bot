const { hybridSearch } = require('../../../services/hybridSearch');
const { ocrScheduleWorkflow } = require('../../../services/ocrSchedule');
const { checkComputerVision } = require('../../../services/visionService');
const { analyzeImageWithFallback } = require('./llmService');
const { resolveQqImageUrl, isHttpUrl } = require('../core/qqMediaResolver');
const { listDocs, upsertDoc, deleteDoc } = require('./storage');
const { generateId, nowIso, safeLower } = require('../utils');

const circuitState = new Map();

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message || `timeout ${ms}ms`)), ms))
  ]);
}

function canRunSkill(name) {
  const state = circuitState.get(name);
  if (!state) return true;
  if (!state.openUntil) return true;
  return Date.now() >= state.openUntil;
}

function markSkillResult(name, ok) {
  const state = circuitState.get(name) || { failCount: 0, openUntil: 0 };
  if (ok) {
    state.failCount = 0;
    state.openUntil = 0;
  } else {
    state.failCount += 1;
    if (state.failCount >= 3) {
      state.openUntil = Date.now() + 60 * 1000;
    }
  }
  circuitState.set(name, state);
}

function parseCityFromText(text) {
  const hit = String(text || '').match(/(北京|上海|广州|深圳|武汉|杭州|成都|西安|南京|重庆|天津|苏州|长沙|郑州|青岛|沈阳|大连|厦门)/);
  return hit ? hit[1] : null;
}

async function weatherSkill(input = {}) {
  const query = String(input.query || input.location || '').trim();
  const city = String(input.location || parseCityFromText(query) || '').trim();
  if (!city) {
    return {
      success: false,
      error: 'missing_location',
      message: '请提供城市名，例如“武汉天气”。'
    };
  }

  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
  const geoJson = await geo.json();
  const target = geoJson?.results?.[0];
  if (!target) {
    return {
      success: false,
      error: 'city_not_found',
      message: `未找到城市：${city}`
    };
  }

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${target.latitude}&longitude=${target.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Asia%2FShanghai`;
  const weatherResp = await fetch(weatherUrl);
  const w = await weatherResp.json();

  return {
    success: true,
    location: `${target.name}${target.admin1 ? `, ${target.admin1}` : ''}`,
    current: w.current,
    daily: w.daily,
    message: `${target.name} 当前 ${w.current?.temperature_2m ?? '-'}°C，风速 ${w.current?.wind_speed_10m ?? '-'}km/h。`
  };
}

function detectScheduleQueryType(text) {
  const msg = safeLower(text);
  if (!msg) return 'overview';
  if (msg.includes('下一节') || msg.includes('下节课')) return 'next';
  if (msg.includes('明天')) return 'tomorrow';
  if (msg.includes('今天')) return 'today';
  if (msg.includes('本周') || msg.includes('这周')) return 'week';
  return 'overview';
}

function normalizeScheduleEntry(item = {}) {
  return {
    name: item.courseName || item.name || '课程',
    weekday: Number(item.weekday || item.day || 0),
    startTime: item.startTime || item.timeStart || '',
    endTime: item.endTime || item.timeEnd || '',
    location: item.location || ''
  };
}

function formatSchedule(entries, type) {
  if (!entries.length) return '当前没有可用课表数据。';

  const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const weekday = (() => {
    const d = now.getUTCDay();
    return d === 0 ? 7 : d;
  })();

  const byDay = entries.reduce((acc, e) => {
    if (!acc[e.weekday]) acc[e.weekday] = [];
    acc[e.weekday].push(e);
    return acc;
  }, {});

  const forDay = (day, label) => {
    const list = (byDay[day] || []).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    if (!list.length) return `${label}没有课。`;
    const lines = list.map((x) => `- ${x.startTime}-${x.endTime} ${x.name}${x.location ? ` @ ${x.location}` : ''}`);
    return `${label}有 ${list.length} 门课:\n${lines.join('\n')}`;
  };

  if (type === 'today') return forDay(weekday, '今天');
  if (type === 'tomorrow') return forDay(weekday === 7 ? 1 : weekday + 1, '明天');
  if (type === 'next') {
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const today = (byDay[weekday] || []).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    const next = today.find((x) => {
      const hhmm = String(x.startTime || '').split(':');
      const mins = Number(hhmm[0] || 0) * 60 + Number(hhmm[1] || 0);
      return mins > nowMin;
    });
    if (next) return `下一节课：${next.startTime}-${next.endTime} ${next.name}${next.location ? ` @ ${next.location}` : ''}`;
    return '今天没有剩余课程。';
  }
  if (type === 'week') {
    const lines = [];
    for (let d = 1; d <= 7; d += 1) {
      const list = byDay[d] || [];
      lines.push(`${dayNames[d]}: ${list.length} 门课`);
    }
    return `本周课表概览：\n${lines.join('\n')}`;
  }

  return `已载入 ${entries.length} 条课程记录。你可以问“今天有课吗 / 明天有课吗 / 下一节课是什么”。`;
}

async function scheduleQuerySkill(input = {}) {
  const schedule = Array.isArray(input.schedule) ? input.schedule.map(normalizeScheduleEntry) : [];
  const query = String(input.query || '');
  const type = detectScheduleQueryType(query);

  if (!schedule.length) {
    return {
      success: false,
      error: 'missing_schedule',
      message: '暂无课表数据，请先上传课表。'
    };
  }

  return {
    success: true,
    query_type: type,
    count: schedule.length,
    message: formatSchedule(schedule, type)
  };
}

async function searchSkill(input = {}, context = null) {
  const query = String(input.query || '').trim();
  if (!query) {
    return {
      success: false,
      error: 'missing_query',
      message: '缺少搜索关键词。'
    };
  }

  const res = await hybridSearch(query, context || null, {
    maxResults: Number(input.maxResults) || 5,
    summarize: true
  });

  return {
    success: !!res.success,
    source: res.source,
    trustLevel: res.trustLevel,
    message: res.formatted || res.error || '暂无结果',
    raw: res
  };
}

async function ocrSkill(input = {}) {
  const imageUrl = String(input.image_url || input.imageUrl || '').trim();
  if (!imageUrl) {
    return {
      success: false,
      error: 'missing_image_url',
      message: '缺少 image_url。'
    };
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_MODELS_TOKEN;
  if (!token) {
    return {
      success: false,
      error: 'missing_token',
      message: '缺少 GITHUB_TOKEN，无法执行 OCR。'
    };
  }

  const result = await ocrScheduleWorkflow(imageUrl, token);
  return {
    success: true,
    message: `OCR 完成，识别到 ${result.schedule?.length || 0} 门课，置信度 ${(Number(result.confidence || 0) * 100).toFixed(1)}%。`,
    schedule: result.schedule,
    confidence: result.confidence
  };
}

async function readFirstImageUrl(input = {}, context = null) {
  const direct = String(input.image_url || input.imageUrl || '').trim();
  if (direct.startsWith('data:image/')) return direct;
  if (isHttpUrl(direct)) return direct;

  if (Array.isArray(input.attachments)) {
    for (const item of input.attachments) {
      if (String(item?.type || '').toLowerCase() !== 'image') continue;

      const url = String(item?.url || '').trim();
      if (url.startsWith('data:image/')) return url;
      if (isHttpUrl(url)) return url;

      const file = String(item?.file || '').trim();
      if (isHttpUrl(file)) return file;

      // eslint-disable-next-line no-await-in-loop
      const resolved = await resolveQqImageUrl(item, context);
      if (resolved) return resolved;
    }
  }

  return '';
}

function isVisionReplyTooGeneric(text = '') {
  const t = String(text || '').trim();
  if (!t) return true;
  return /无法确认图像内容|请提供更具体|看不清|无法判断图像内容|信息不足/.test(t);
}

async function visionSkill(input = {}, context = null) {
  const imageUrl = await readFirstImageUrl(input, context);
  if (!imageUrl) {
    return {
      success: false,
      error: 'missing_image_url',
      message: '我收到了图片消息，但图片链接还没解析成功。请发送原图，或检查 NapCat 的 get_image 接口是否可用。'
    };
  }

  if (!imageUrl.startsWith('data:image/') && !isHttpUrl(imageUrl)) {
    return {
      success: false,
      error: 'invalid_image_url',
      message: '图片链接格式无效，无法执行识图。'
    };
  }

  let cvText = '';
  try {
    cvText = await checkComputerVision(imageUrl, context || null) || '';
  } catch (err) {
    context?.log?.(`[v2/vision] computer vision failed: ${err.message}`);
  }

  const multimodal = await analyzeImageWithFallback({
    image_url: imageUrl,
    query: String(input.query || input.prompt || '').trim(),
    cvText
  }, {}, context);

  const modelContent = String(multimodal.content || '').trim();
  if (modelContent && !isVisionReplyTooGeneric(modelContent)) {
    return {
      success: true,
      image_url: imageUrl,
      message: modelContent,
      model: multimodal.model || 'openai/gpt-4o',
      vision_source: cvText ? 'gpt4o_with_cv_context' : 'gpt4o'
    };
  }

  if (!cvText) {
    return {
      success: false,
      error: 'vision_unavailable',
      message: '视觉分析暂不可用或未识别到有效内容。'
    };
  }

  return {
    success: true,
    image_url: imageUrl,
    message: cvText,
    model: 'azure-computer-vision',
    vision_source: 'cv_fallback'
  };
}

async function drawSkill(input = {}) {
  const prompt = String(input.prompt || input.query || '').trim();
  if (!prompt) {
    return {
      success: false,
      error: 'missing_prompt',
      message: '缺少绘图描述。'
    };
  }

  // 轻量在线生图 URL（无需本地推理）
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&model=flux&nologo=true`;
  return {
    success: true,
    image_url: imageUrl,
    message: `已生成图片：${imageUrl}`
  };
}

const BUILTIN_SKILLS = [
  {
    name: 'weather.get_weather',
    displayName: '天气查询',
    description: '查询城市天气',
    triggers: ['天气', 'weather', '气温', '下雨'],
    permissions: ['network'],
    builtin: true,
    handler: weatherSkill
  },
  {
    name: 'search.hybrid_search',
    displayName: '混合搜索',
    description: '调用混合搜索链路',
    triggers: ['搜索', '查一下', 'search', '是什么'],
    permissions: ['network', 'llm'],
    builtin: true,
    handler: searchSkill
  },
  {
    name: 'schedule.query',
    displayName: '课表查询',
    description: '查询今天/明天/本周课表',
    triggers: ['课表', '课程', '明天有课', '今天有课', '下一节课'],
    permissions: ['memory'],
    enabledByDefault: false,
    builtin: true,
    handler: scheduleQuerySkill
  },
  {
    name: 'ocr.parse_schedule',
    displayName: '课表OCR',
    description: '识别课表图片为结构化数据',
    triggers: ['识别课表', 'OCR', '课表截图'],
    permissions: ['network', 'llm'],
    enabledByDefault: false,
    builtin: true,
    handler: ocrSkill
  },
  {
    name: 'vision.describe_image',
    displayName: '图像理解',
    description: '识别图像内容与文字',
    triggers: ['看图', '识图', '图里是什么', 'image analyze', 'vision'],
    permissions: ['network'],
    enabledByDefault: true,
    builtin: true,
    handler: visionSkill
  },
  {
    name: 'draw.generate_image',
    displayName: '图片生成',
    description: '根据描述生成图片',
    triggers: ['画图', '绘图', '画一张', 'draw', 'generate image'],
    permissions: ['network'],
    enabledByDefault: true,
    builtin: true,
    handler: drawSkill
  }
];

function matchSkillByContent(content, availableSkills) {
  const msg = safeLower(content);
  for (const skill of availableSkills) {
    if ((skill.triggers || []).some((t) => msg.includes(String(t).toLowerCase()))) {
      return skill;
    }
  }
  return null;
}

async function listInstalledSkills(context = null) {
  const custom = await listDocs('skills', 'skills:global', { limit: 500 }, context);
  return [
    ...BUILTIN_SKILLS.map((x) => ({ ...x, source: 'builtin' })),
    ...custom.map((x) => ({ ...x, source: 'custom' }))
  ];
}

async function installSkill(payload, context = null) {
  const name = String(payload.name || '').trim();
  if (!/^[a-z0-9_.-]{3,80}$/i.test(name)) {
    throw new Error('invalid skill name');
  }

  const doc = {
    id: `skill_${name}`,
    name,
    displayName: payload.displayName || name,
    description: payload.description || '',
    triggers: Array.isArray(payload.triggers) ? payload.triggers.slice(0, 20) : [],
    permissions: Array.isArray(payload.permissions) ? payload.permissions.slice(0, 10) : [],
    type: payload.type || 'template',
    template: payload.template || '',
    created_at: nowIso(),
    updated_at: nowIso()
  };

  await upsertDoc('skills', 'skills:global', doc, context);
  return doc;
}

async function uninstallSkill(name, context = null) {
  const key = `skill_${name}`;
  return deleteDoc('skills', key, 'skills:global', context);
}

function customSkillHandler(skill, input = {}) {
  if (skill.type === 'template') {
    const fallback = skill.template || `${skill.displayName || skill.name} 已触发。`;
    return {
      success: true,
      message: fallback
    };
  }
  return {
    success: false,
    error: 'unsupported_custom_skill_type',
    message: '该自定义技能类型暂不支持执行。'
  };
}

async function executeSkill(name, input = {}, context = null) {
  const started = Date.now();
  const toolCall = {
    tool: name,
    input,
    output: null,
    status: 'failed',
    error: null,
    duration_ms: 0
  };

  if (!canRunSkill(name)) {
    toolCall.error = 'circuit_open';
    toolCall.status = 'skipped';
    toolCall.duration_ms = Date.now() - started;
    return toolCall;
  }

  const allSkills = await listInstalledSkills(context);
  const skill = allSkills.find((x) => x.name === name);
  if (!skill) {
    toolCall.error = 'skill_not_found';
    toolCall.duration_ms = Date.now() - started;
    return toolCall;
  }

  const maxAttempts = 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const promise = skill.builtin ? skill.handler(input, context) : Promise.resolve(customSkillHandler(skill, input));
      const output = await withTimeout(promise, 15000, `skill_timeout:${name}`);
      markSkillResult(name, true);
      toolCall.output = output;
      toolCall.status = output?.success === false ? 'failed' : 'success';
      toolCall.error = output?.success === false ? output.error || null : null;
      toolCall.duration_ms = Date.now() - started;
      return toolCall;
    } catch (err) {
      lastErr = err;
    }
  }

  markSkillResult(name, false);
  toolCall.error = lastErr ? lastErr.message : 'unknown_error';
  toolCall.duration_ms = Date.now() - started;
  return toolCall;
}

async function planAndExecute(content, metadata = {}, context = null) {
  const skills = await listInstalledSkills(context);
  const explicit = String(metadata.skill || metadata.use_skill || '').trim();

  const plans = [];
  if (explicit) {
    plans.push({ name: explicit, input: metadata.skill_input || {} });
  } else {
    const matched = matchSkillByContent(content, skills);
    if (matched) {
      plans.push({
        name: matched.name,
        input: {
          query: content,
          location: metadata.location,
          schedule: metadata.schedule,
          image_url: metadata.image_url
        }
      });
    }
  }

  const calls = [];
  for (const p of plans) {
    // eslint-disable-next-line no-await-in-loop
    const call = await executeSkill(p.name, p.input, context);
    calls.push(call);
  }

  return {
    planned: plans,
    calls
  };
}

module.exports = {
  listInstalledSkills,
  installSkill,
  uninstallSkill,
  executeSkill,
  planAndExecute,
  BUILTIN_SKILLS
};
