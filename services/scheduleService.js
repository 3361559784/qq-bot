const { OpenAI } = require('openai');
const XLSX = require('xlsx');
const ical = require('node-ical');
const { getChaoxingScheduleFromUrl, fetchAllWeeksLessons } = require('./chaoxingSchedule');

const SCHEDULE_KEYWORDS = [
  '课表', '课程表', '课程安排', '日程', '日历', 'schedule', 'calendar', 'ics', 'excel', 'xlsx', 'xls',
  '超星', '学习通', 'chaoxing',
  // 课表查询口语（避免只识别“课表”导致“明天有课吗”走普通聊天）
  '明天有课吗', '今天有课吗', '明天有课', '今天有课',
  '本周课表', '这周课表', '下周课表'
];

function getShanghaiNowUtcShifted() {
  // 将 UTC ms + 8h 作为“上海本地时间”的伪 UTC Date，以便用 getUTC* 取到上海日期字段
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function getShanghaiWeekdayNumber(dateUtcShifted) {
  // 1=周一 ... 7=周日
  const d = dateUtcShifted.getUTCDay();
  return d === 0 ? 7 : d;
}

function detectScheduleQueryType(msg = '') {
  const lower = String(msg || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('明天') && lower.includes('课')) return 'tomorrow';
  if (lower.includes('今天') && lower.includes('课')) return 'today';
  if ((lower.includes('下周') || lower.includes('下星期') || lower.includes('下个星期') || lower.includes('下礼拜')) && lower.includes('课表')) return 'next_week';
  if ((lower.includes('本周') || lower.includes('这周')) && lower.includes('课表')) return 'this_week';
  if (lower.includes('课表')) return 'this_week';
  return null;
}

function parseTimeToMinutes(timeStr) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(timeStr || ''));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

async function readScheduleProfileFromCosmos(cosmosContainer, userId, context) {
  if (!cosmosContainer || !userId) return null;

  const profileId = `schedule_${userId}`;
  const readAttempts = [
    // 常见：PK=/partitionKey，值=userId
    { id: profileId, pk: userId },
    // 兼容：PK=/id
    { id: profileId, pk: profileId }
  ];

  for (const a of readAttempts) {
    try {
      const { resource } = await cosmosContainer.item(a.id, a.pk).read();
      if (resource) return resource;
    } catch (err) {
      const status = err?.code || err?.statusCode || err?.status;
      if (status === 404) continue;
      context?.log?.(`[ScheduleProfile] 读取异常(id=${a.id}, pk=${a.pk}): ${err.message}`);
    }
  }

  // 兜底：跨分区查询（适配不同容器 PK 配置）
  try {
    const query = {
      query: "SELECT TOP 1 * FROM c WHERE c.type = 'schedule_profile' AND (c.userId = @uid OR c.partitionKey = @uid OR c.id = @id)",
      parameters: [
        { name: '@uid', value: userId },
        { name: '@id', value: profileId }
      ]
    };
    const { resources } = await cosmosContainer.items.query(query).fetchAll();
    return resources?.[0] || null;
  } catch (err) {
    context?.log?.(`[ScheduleProfile] 查询兜底失败: ${err.message}`);
    return null;
  }
}

function formatTomorrowAnswerFromProfile(profile, when = 'tomorrow') {
  const weekly = Array.isArray(profile?.weekly_schedule) ? profile.weekly_schedule : [];
  const nowSh = getShanghaiNowUtcShifted();
  const base = new Date(nowSh.getTime() + (when === 'tomorrow' ? 24 : 0) * 60 * 60 * 1000);
  const weekday = getShanghaiWeekdayNumber(base);

  const todayLabel = when === 'tomorrow' ? '明天' : '今天';
  const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
  const dayLabel = dayNames[weekday] || `周${weekday}`;

  const courses = weekly
    .filter(c => Number(c?.day) === weekday)
    .slice()
    .sort((a, b) => {
      const aStart = Number(a?.start) || 0;
      const bStart = Number(b?.start) || 0;
      if (aStart > 0 && bStart > 0) return aStart - bStart;
      if (aStart > 0) return -1;
      if (bStart > 0) return 1;
      const aT = parseTimeToMinutes(a?.timeStart);
      const bT = parseTimeToMinutes(b?.timeStart);
      return (aT ?? 999999) - (bT ?? 999999);
    });

  if (!courses.length) {
    return `✅ ${todayLabel}(${dayLabel})看起来没有课。`;
  }

  const lines = courses.map(c => {
    const p = Number(c?.start) || 0;
    const name = c?.name || '课程';
    const t = (c?.timeStart && c?.timeEnd) ? `${c.timeStart}-${c.timeEnd}` : '';
    const loc = c?.location ? ` @ ${c.location}` : '';
    if (p > 0) return `- 第${p}节 ${name}${t ? ` (${t})` : ''}${loc}`;
    if (t) return `- ${t} ${name}${loc}`;
    return `- ${name}${loc}`;
  });

  return `📚 ${todayLabel}(${dayLabel})有 ${courses.length} 门课:\n${lines.join('\n')}`;
}

function formatWeekScheduleAnswerFromProfile(profile, which = 'this_week') {
  const weekly = Array.isArray(profile?.weekly_schedule) ? profile.weekly_schedule : [];
  if (!weekly.length) return '⚠️ 课表数据为空。';

  const title = which === 'next_week' ? '下周课表(按周内规律展示)' : '本周课表(按周内规律展示)';
  const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };

  const byDay = new Map();
  for (const c of weekly) {
    const day = Number(c?.day) || 0;
    if (day < 1 || day > 7) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }

  const parts = [];
  for (let d = 1; d <= 7; d++) {
    const list = (byDay.get(d) || []).slice().sort((a, b) => {
      const aStart = Number(a?.start) || 0;
      const bStart = Number(b?.start) || 0;
      if (aStart > 0 && bStart > 0) return aStart - bStart;
      if (aStart > 0) return -1;
      if (bStart > 0) return 1;
      const aT = parseTimeToMinutes(a?.timeStart);
      const bT = parseTimeToMinutes(b?.timeStart);
      return (aT ?? 999999) - (bT ?? 999999);
    });
    if (!list.length) continue;
    parts.push(`${dayNames[d]}:`);
    for (const c of list) {
      const p = Number(c?.start) || 0;
      const name = c?.name || '课程';
      const t = (c?.timeStart && c?.timeEnd) ? `${c.timeStart}-${c.timeEnd}` : '';
      const loc = c?.location ? ` @ ${c.location}` : '';
      if (p > 0) parts.push(`- 第${p}节 ${name}${t ? ` (${t})` : ''}${loc}`);
      else if (t) parts.push(`- ${t} ${name}${loc}`);
      else parts.push(`- ${name}${loc}`);
    }
  }

  const metaLine = profile?.schedule_config?.last_updated
    ? `\n\n更新时间: ${String(profile.schedule_config.last_updated).slice(0, 19).replace('T', ' ')}`
    : '';

  return `🗓️ ${title}\n${parts.join('\n')}${metaLine}`;
}

function extractChaoxingScheduleUrl(rawMsg = '') {
  if (!rawMsg) return null;
  const urls = [...rawMsg.matchAll(/https?:\/\/[^\s\]]+/g)].map(m => m[0]);
  const chaoxingUrl = urls.find(url =>
    url.includes('chaoxing.com') &&
    (url.includes('schedule') || url.includes('kb') || url.includes('mycourse'))
  );
  return chaoxingUrl;
}

function extractCurriculumUuidFromUrl(url = '') {
  const m = String(url || '').match(/curriculumUuid=([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

function extractScheduleFileLinks(body, rawMsg = '') {
  const results = [];
  const pushCandidate = (url, name) => {
    if (!url) return;
    const lower = url.toLowerCase();
    if (!/(\.ics|\.xlsx|\.xls)(\?|$)/.test(lower)) return;
    if (results.some(r => r.url === url)) return;
    results.push({ url, name: name || url.split('/').pop() || '文件' });
  };

  const fileMatches = [...rawMsg.matchAll(/\[CQ:file[^\]]*url=([^,\]]+)/g)];
  for (const m of fileMatches) pushCandidate(m[1]);

  const urlMatches = [...rawMsg.matchAll(/https?:\/\/[^\s\]]+/g)];
  for (const m of urlMatches) pushCandidate(m[0]);

  if (body && Array.isArray(body.message)) {
    for (const seg of body.message) {
      if (seg && seg.type === 'file' && seg.data) {
        pushCandidate(seg.data.url || seg.data.file || seg.data.path, seg.data.name);
      }
    }
  }

  return results;
}

async function downloadFileBuffer(url, context, fetchFn) {
  if (!fetchFn) throw new Error('fetchFn is required');
  try {
    const res = await fetchFn(url, {}, 2);
    if (!res || !res.ok) {
      context?.log?.(`[Schedule] 下载失败: ${url} status=${res?.status}`);
      return null;
    }
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch (err) {
    context?.log?.(`[Schedule] 下载异常: ${err.message}`);
    return null;
  }
}

function parseIcsEvents(buffer, context) {
  try {
    const parsed = ical.sync.parseICS(buffer.toString('utf8'));
    const events = [];
    for (const key of Object.keys(parsed)) {
      const item = parsed[key];
      if (item && item.type === 'VEVENT' && item.summary && item.start) {
        events.push({
          title: item.summary,
          start: new Date(item.start),
          end: item.end ? new Date(item.end) : null,
          location: item.location || '',
          source: 'ics'
        });
      }
    }
    return events;
  } catch (err) {
    context?.log?.(`[Schedule] ICS 解析失败: ${err.message}`);
    return [];
  }
}

function parseExcelDate(val) {
  if (!val && val !== 0) return null;
  if (val instanceof Date && !isNaN(val)) return val;
  if (typeof val === 'number') {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed) {
      return new Date(Date.UTC(parsed.y || 1970, (parsed.m || 1) - 1, parsed.d || 1, parsed.H || 0, parsed.M || 0, parsed.S || 0));
    }
  }
  if (typeof val === 'string') {
    const normalized = val.replace(/年|\.|-/g, '/').replace(/月/g, '/').replace(/日/g, '');
    const dt = new Date(normalized);
    if (!isNaN(dt)) return dt;
  }
  return null;
}

function parseExcelEvents(buffer, context) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows || rows.length === 0) return [];

    const headers = Object.keys(rows[0] || {}).map(h => h.toString());
    const pick = (cands) => headers.find(h => cands.some(k => h.toLowerCase().includes(k)));

    const titleCol = pick(['课程', '课程名', '课程名称', '标题', 'summary', 'subject', '事件', '事项', 'task']);
    const startCol = pick(['开始', '开始时间', '上课', 'start', '起始', '时间']);
    const endCol = pick(['结束', '结束时间', '下课', 'end', '终止']);
    const dateCol = pick(['日期', 'date', 'day']);
    const locCol = pick(['地点', '教室', '位置', 'room', 'location']);

    const events = [];
    rows.forEach((row, idx) => {
      const title = (titleCol && row[titleCol]) ? String(row[titleCol]).trim() : `事件${idx + 1}`;
      const startVal = startCol ? row[startCol] : (dateCol ? row[dateCol] : null);
      const endVal = endCol ? row[endCol] : null;
      const start = parseExcelDate(startVal);
      const end = parseExcelDate(endVal);
      if (start && !isNaN(start)) {
        events.push({
          title,
          start,
          end: end && !isNaN(end) ? end : null,
          location: locCol && row[locCol] ? String(row[locCol]).trim() : '',
          source: 'excel'
        });
      }
    });

    return events;
  } catch (err) {
    context?.log?.(`[Schedule] Excel 解析失败: ${err.message}`);
    return [];
  }
}

function coerceToDate(value) {
  if (!value && value !== 0) return null;

  if (value instanceof Date) {
    return isNaN(value) ? null : value;
  }

  // 支持 Chaoxing API/爬虫的结构化时间: { dateTime, date, time }
  if (typeof value === 'object') {
    const dateTime = value.dateTime || value.datetime || value.startDateTime || value.endDateTime;
    if (typeof dateTime === 'string' && dateTime.trim()) {
      return coerceToDate(dateTime);
    }
    const date = value.date;
    const time = value.time;
    if (typeof date === 'string' && date.trim() && typeof time === 'string' && time.trim()) {
      return coerceToDate(`${date} ${time}`);
    }
    return null;
  }

  // 时间戳: 兼容 seconds / milliseconds
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const dt = new Date(ms);
    return isNaN(dt) ? null : dt;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // 兼容 "YYYY-MM-DD HH:mm" / "YYYY-MM-DD" 等，避免某些环境解析失败
    const normalized = trimmed
      .replace(/年|\.|-/g, '/')
      .replace(/月/g, '/')
      .replace(/日/g, '')
      .replace('T', ' ');

    const dt = new Date(normalized);
    return isNaN(dt) ? null : dt;
  }

  return null;
}

function toISOStringSafe(value) {
  const dt = coerceToDate(value);
  return dt ? dt.toISOString() : null;
}

function getTimeSafe(value) {
  const dt = coerceToDate(value);
  return dt ? dt.getTime() : 0;
}

function formatScheduleSummary(events, limit = 5) {
  if (!events || events.length === 0) return '';
  const sorted = [...events].sort((a, b) => getTimeSafe(a?.start) - getTimeSafe(b?.start));
  const now = Date.now();
  const upcoming = sorted
    .filter(e => getTimeSafe(e?.start) >= now - 12 * 60 * 60 * 1000)
    .slice(0, limit);
  const fmt = (d) => {
    const dt = coerceToDate(d);
    return dt ? dt.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
  };
  return upcoming
    .map(e => `- ${fmt(e.start)}${e.end ? ` ~ ${fmt(e.end)}` : ''} ${e.title || e.summary}${e.location ? ` @ ${e.location}` : ''}`)
    .join('\n');
}

async function saveScheduleToCosmos(cosmosContainer, dbKey, events, context) {
  if (!cosmosContainer) return;
  const docId = `schedule_${dbKey}`;
  try {
    await cosmosContainer.items.upsert({
      id: docId,
      events: events.slice(0, 100).map(e => ({
        title: e.title || e.summary,
        start: toISOStringSafe(e.start),
        end: toISOStringSafe(e.end),
        location: e.location || '',
        source: e.source || 'unknown'
      })),
      lastUpdated: new Date().toISOString()
    });
    context?.log?.(`[Schedule] 已保存 ${events.length} 条日程到 Cosmos (${docId})`);
  } catch (err) {
    context?.log?.(`[Schedule] 保存失败: ${err.message}`);
  }
}

function extractOcrText(cvSummary) {
  if (!cvSummary) return '';
  const m = cvSummary.match(/图中文字:\s*"([^"]+)"/);
  if (m && m[1]) return m[1];
  return cvSummary;
}

async function parseScheduleFromOcrText(ocrText, context, token) {
  if (!ocrText || !token) return { events: [], summary: ocrText || '' };
  const client = new OpenAI({ baseURL: 'https://models.inference.ai.azure.com', apiKey: token });

  const prompt = `你是一名专业的大学课表识别助手。下面是从学习通App课表截图中提取的OCR文本。

**课表格式特征:**
- 课表通常按"周一~周日"排列,每天有多个时间段
- 每门课包含: 课程名称、时间(如"08:00-09:40"),教室位置、可能有教师名
- 时间段可能以"第X节"表示,或直接显示时间范围
- 可能包含周次信息(如"第10周")

**识别要求:**
1. 提取所有可识别的课程信息
2. 如果没有明确日期,请根据"周X"推断为本周对应日期
3. 时间格式严格使用ISO8601(如"2025-12-11T08:00:00+08:00")
4. 最多返回20条课程记录(完整一周课表)
5. 保留原始中文课程名和地点

**输出格式(纯JSON,不要任何解释):**
{"events":[{"title":"课程名","start":"ISO8601格式开始时间","end":"ISO8601格式结束时间","location":"教室位置","description":"备注信息(如第几节/教师名)"}]}

如果完全无法解析,返回: {"events":[]}

OCR原文:
${ocrText}`;

  try {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.1,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: '你是课表识别专家,严格输出JSON格式,不添加任何markdown或解释文字。' },
        { role: 'user', content: prompt }
      ]
    });
    const text = resp.choices[0]?.message?.content?.trim() || '';

    let jsonText = text;
    if (text.includes('```json')) {
      const match = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (match) jsonText = match[1];
    } else if (text.includes('```')) {
      const match = text.match(/```\s*([\s\S]*?)\s*```/);
      if (match) jsonText = match[1];
    }

    const jsonStart = jsonText.indexOf('{');
    const jsonEnd = jsonText.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(jsonText.slice(jsonStart, jsonEnd + 1));
      const events = Array.isArray(parsed.events) ? parsed.events : [];

      const normalized = events
        .filter(e => e.title && e.start)
        .map(e => {
          try {
            const startDate = new Date(e.start);
            const endDate = e.end ? new Date(e.end) : null;
            if (isNaN(startDate)) return null;
            if (endDate && isNaN(endDate)) return null;
            return {
              title: e.title.trim(),
              start: startDate,
              end: endDate,
              location: (e.location || '').trim(),
              description: (e.description || '').trim(),
              source: 'ocr-enhanced'
            };
          } catch {
            return null;
          }
        })
        .filter(e => e !== null);

      context?.log?.(`[Schedule] OCR成功解析 ${normalized.length} 条课程`);
      return { events: normalized, summary: text };
    }
  } catch (err) {
    context?.log?.(`[Schedule] OCR解析失败: ${err.message}`);
  }
  return { events: [], summary: ocrText };
}

async function fetchScheduleFromChaoxingAPI(url, context, week = null) {
  context?.log?.(`[Chaoxing API] 解析学习通课表: ${url}`);

  try {
    // 🎯 先获取单周数据以验证链接有效性
    const result = await getChaoxingScheduleFromUrl(url, week);

    if (!result.success) {
      context?.log?.(`[Chaoxing API] 获取失败: ${result.error} (类型: ${result.errorType})`);
      let userMessage = '❌ 无法获取学习通课表\n';
      switch (result.errorType) {
        case 'invalid_url':
          userMessage += '原因: 链接格式不正确\n建议: 请从学习通 APP 复制完整的分享链接';
          break;
        case 'not_found':
          userMessage += '原因: 课表不存在或已被删除\n建议: 请检查链接是否正确';
          break;
        case 'empty_data':
          userMessage += '原因: 课表数据为空\n建议: 可能该课表尚未添加课程';
          break;
        case 'timeout':
          userMessage += '原因: 网络请求超时\n建议: 请稍后重试';
          break;
        default:
          userMessage += `原因: ${result.error}\n建议: 请稍后重试或使用 ICS/Excel 文件上传`;
      }
      return { error: userMessage };
    }

    context?.log?.(`[Chaoxing API] 单周验证成功,准备获取全学期课表...`);

    // 🎯 获取全学期课表数据
    const curriculumUuid = result.metadata?.curriculumUuid || extractCurriculumUuidFromUrl(url);
    if (!curriculumUuid) {
      context?.log?.(`[Chaoxing API] 警告: 未找到 curriculumUuid,仅返回单周数据`);
      return formatSingleWeekResult(result, context);
    }

    const fullSchedule = await fetchAllWeeksLessons(curriculumUuid);
    if (!fullSchedule?.success) {
      context?.log?.(`[Chaoxing API] 全学期获取失败,回退到单周数据: ${fullSchedule?.error || 'unknown error'}`);
      return formatSingleWeekResult(result, context);
    }

    const lessons = Array.isArray(fullSchedule.lessons) ? fullSchedule.lessons : [];
    context?.log?.(`[Chaoxing API] 成功获取全学期课表: ${lessons.length} 条课程`);

    // 🎯 使用标准化字段 (name, teacher, location, day, start, duration, date, raw)
    // 同时补齐 beginNumber/period：避免时间字段解析失败导致 schedule_profile 过滤后为空
    const events = lessons.map(lesson => {
      const raw = lesson?.raw || {};
      const beginNumber = Number(raw?.beginNumber) || 0;
      const length = Number(raw?.length) || 0;
      const endNumber = (beginNumber > 0 && length > 0) ? (beginNumber + length - 1) : 0;
      return {
      summary: lesson.name,
      start: {
        dateTime: lesson.date ? `${lesson.date} ${lesson.start}` : null,
        date: lesson.date,
        time: lesson.start
      },
      end: {
        dateTime: lesson.date && lesson.duration ? `${lesson.date} ${addMinutesToTime(lesson.start, lesson.duration)}` : null,
        date: lesson.date,
        time: lesson.start && lesson.duration ? addMinutesToTime(lesson.start, lesson.duration) : null
      },
      location: lesson.location,
      description: `${lesson.teacher} - 周${lesson.day}`,
      extendedProps: {
        instructor: lesson.teacher,
        dayOfWeek: lesson.day,
        startTime: lesson.start,
        // beginNumber/period 用于“第几节”语义；time 解析失败时仍可保存 weekly_schedule
        beginNumber,
        period: beginNumber,
        length,
        endNumber,
        duration: lesson.duration,
        source: 'chaoxing-api-full',
        raw: lesson.raw // 保留完整原始数据
      }
    };
    });

    return {
      events,
      curriculum: fullSchedule.curriculum || result.curriculum,
      metadata: {
        ...result.metadata,
        curriculumUuid,
        fullSemester: true,
        totalLessons: lessons.length,
        maxWeek: fullSchedule.maxWeek || fullSchedule.curriculum?.maxWeek || null
      }
    };
  } catch (err) {
    context?.log?.(`[Chaoxing API] 调用异常: ${err.message}`);
    return { error: `系统错误: ${err.message}` };
  }
}

// 辅助函数: 时间加减计算 (HH:MM + minutes)
function addMinutesToTime(timeStr, minutes) {
  if (!timeStr || !minutes) return timeStr;
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutes = h * 60 + m + minutes;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// 辅助函数: 格式化单周结果 (fallback)
function formatSingleWeekResult(result, context) {
  context?.log?.(`[Chaoxing API] 成功获取 ${result.schedule.length} 门课程 (单周数据)`);
  context?.log?.(`[Chaoxing API] 课表信息 - 学年: ${result.curriculum.schoolYear}, 学期: ${result.curriculum.semester}, 当前周: ${result.curriculum.currentWeek}`);

  const events = result.schedule.map(lesson => {
    const raw = lesson?.raw || {};
    const beginNumber = Number(raw?.beginNumber) || 0;
    const length = Number(raw?.length) || 0;
    const endNumber = (beginNumber > 0 && length > 0) ? (beginNumber + length - 1) : 0;
    return {
    summary: lesson.name,
    start: {
      dateTime: lesson.date ? `${lesson.date} ${lesson.start}` : null,
      date: lesson.date,
      time: lesson.start
    },
    end: {
      dateTime: lesson.date && lesson.duration ? `${lesson.date} ${addMinutesToTime(lesson.start, lesson.duration)}` : null,
      date: lesson.date,
      time: lesson.start && lesson.duration ? addMinutesToTime(lesson.start, lesson.duration) : null
    },
    location: lesson.location,
    description: `${lesson.teacher} - 周${lesson.day}`,
    extendedProps: {
      instructor: lesson.teacher,
      dayOfWeek: lesson.day,
      startTime: lesson.start,
      beginNumber,
      period: beginNumber,
      length,
      endNumber,
      duration: lesson.duration,
      source: 'chaoxing-api',
      raw: lesson.raw
    }
  };
  });

  return {
    events,
    curriculum: result.curriculum,
    metadata: result.metadata
  };
}

async function fetchScheduleFromRemoteScraper(url, context, fetchFn, cookies = null) {
  const SCRAPER_ENDPOINT = process.env.SCRAPER_ENDPOINT || 'https://aris-scraper.blueglacier-a914b85e.koreacentral.azurecontainerapps.io';
  if (!fetchFn) return { error: 'fetchFn is required for remote scraper' };

  context?.log?.(`[RemoteScraper] 调用远程爬虫 (备用方案): ${url}`);

  try {
    // 🎯 增加超时时间到 15000ms
    const response = await fetchFn(`${SCRAPER_ENDPOINT}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, cookies }),
      timeoutMs: 15000 // 🎯 远程爬虫需要更长时间
    }, 2);

    const result = await response.json();

    if (!result.success) {
      context?.log?.(`[RemoteScraper] 爬取失败: ${result.error}`);
      return { error: result.error };
    }

    context?.log?.(`[RemoteScraper] 成功获取 ${result.data.courses.length} 门课程`);

    const events = result.data.courses.map(course => ({
      summary: course.courseName,
      start: {
        dateTime: `${course.date} ${course.timeStart}`,
        date: course.date,
        time: course.timeStart
      },
      end: {
        dateTime: `${course.date} ${course.timeEnd}`,
        date: course.date,
        time: course.timeEnd
      },
      location: course.location,
      description: `${course.day} 第${course.period}节`,
      extendedProps: {
        day: course.day,
        period: course.period,
        duration: course.duration,
        teacher: course.teacher,
        source: 'chaoxing-remote-scraper'
      }
    }));

    return {
      events,
      summary: result.data.summary,
      screenshot: result.screenshot,
      metadata: result.metadata
    };
  } catch (err) {
    context?.log?.(`[RemoteScraper] 调用异常: ${err.message}`);
    return { error: err.message };
  }
}

async function saveUserScheduleProfile(cosmosContainer, userId, scheduleData, sourceUrl, context) {
  if (!cosmosContainer) {
    context?.log?.('[ScheduleProfile] Cosmos容器未初始化,跳过保存');
    return;
  }

  try {
    const profileId = `schedule_${userId}`;

    // 🎯 提取扩展字段 (qq, curriculumUuid, semesterStartDate, maxWeek)
    const qq = userId; // QQ 号与 userId 相同
    const curriculumUuid = scheduleData?.metadata?.curriculumUuid || scheduleData?.curriculum?.curriculumUuid || null;
    const semesterStartDate = scheduleData?.curriculum?.semesterStartDate || scheduleData?.metadata?.semesterStartDate || null;
    const maxWeek = scheduleData?.curriculum?.maxWeek || scheduleData?.metadata?.maxWeek || null;

    const sourceEvents = Array.isArray(scheduleData?.events) ? scheduleData.events : [];
    const weeklySchedule = sourceEvents.map(evt => {
      const dayMap = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 7 };
      const ext = evt?.extendedProps || {};
      const raw = ext?.raw || {};
      return {
        day: dayMap[ext?.day] || Number(ext?.dayOfWeek) || Number(ext?.weekday) || Number(raw?.dayOfWeek) || Number(raw?.weekday) || 0,
        // start(第几节) 可能不存在：学习通 API 路径只给 startTime/endTime
        start: parseInt(ext?.period) || parseInt(ext?.beginNumber) || parseInt(raw?.beginNumber) || 0,
        name: evt.summary || evt.title || '课程',
        location: evt.location || '',
        timeStart: ext?.startTime || evt.start?.time || raw?.startTime || raw?.beginTime || raw?.timeStart || '',
        timeEnd: ext?.endTime || evt.end?.time || raw?.endTime || raw?.finishTime || raw?.timeEnd || '',
        teacher: ext?.teacher || ext?.instructor || ''
      };
    }).filter(c => c.day > 0 && (c.start > 0 || c.timeStart));

    // 诊断：有 events 但 weekly_schedule 为空时，输出关键字段帮助排查（不打印敏感内容）
    if (weeklySchedule.length === 0 && sourceEvents.length > 0) {
      const sample = sourceEvents[0] || {};
      const sampleExt = sample?.extendedProps || {};
      context?.log?.(`[ScheduleProfile][Diag] events=${sourceEvents.length} but weekly_schedule=0; sample dayOfWeek=${sampleExt?.dayOfWeek}, period=${sampleExt?.period || sampleExt?.beginNumber}, startTime=${sampleExt?.startTime || sample?.start?.time || ''}`);
    }

    const profile = {
      id: profileId,
      partitionKey: userId,
      userId,
      qq, // 🎯 新增: QQ 号
      curriculumUuid, // 🎯 新增: 课表 UUID (用于检测学期变更)
      semesterStartDate, // 🎯 新增: 学期开始日期
      maxWeek, // 🎯 新增: 最大周数
      schedule_config: {
        source_url: sourceUrl || 'unknown',
        last_updated: new Date().toISOString(),
        semester: scheduleData.curriculum?.semester || `${new Date().getFullYear()}-${new Date().getMonth() >= 8 ? 'Fall' : 'Spring'}`,
        total_courses: weeklySchedule.length,
        full_semester: scheduleData.metadata?.fullSemester || false
      },
      weekly_schedule: weeklySchedule,
      type: 'schedule_profile',
      createdAt: new Date().toISOString()
    };

    await cosmosContainer.items.upsert(profile);
    context?.log?.(`[ScheduleProfile] ✅ 已保存 ${userId} 的课表档案: ${weeklySchedule.length}门课程`);
    context?.log?.(`[ScheduleProfile] 🔑 UUID: ${curriculumUuid}, 学期: ${semesterStartDate} ~ 第${maxWeek}周`);
    context?.log?.(`[ScheduleProfile] 链接: ${sourceUrl}`);
  } catch (err) {
    context?.log?.(`[ScheduleProfile] ❌ 保存失败: ${err.message}`);
  }
}

function createScheduleHandler({ fetchBypass, checkComputerVision, updateLastBotReply }) {
  return async function handleScheduleRequest({ fileLinks, imageUrls, msg, senderId, dbKey, cosmosContainer, context, token }) {
    const hasKeyword = SCHEDULE_KEYWORDS.some(k => msg && msg.toLowerCase().includes(k));
    const queryType = detectScheduleQueryType(msg);

    // 课表查询（不带文件/图片/学习通链接）：从 Cosmos 读取已保存的 schedule_profile 并回答
    if ((hasKeyword || queryType) && !extractChaoxingScheduleUrl(msg) && (!fileLinks || fileLinks.length === 0) && (!imageUrls || imageUrls.length === 0)) {
      const profile = await readScheduleProfileFromCosmos(cosmosContainer, senderId, context);
      if (!profile) {
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            reply: '⚠️ 我还没有你的课表数据。\n请先发送学习通课表链接，或上传官方导出的 Excel/ICS，或发送课表截图让我 OCR 解析。',
            auto_escape: false
          })
        };
      }

      let replyText = '';
      if (queryType === 'tomorrow') replyText = formatTomorrowAnswerFromProfile(profile, 'tomorrow');
      else if (queryType === 'today') replyText = formatTomorrowAnswerFromProfile(profile, 'today');
      else if (queryType === 'next_week') replyText = formatWeekScheduleAnswerFromProfile(profile, 'next_week');
      else replyText = formatWeekScheduleAnswerFromProfile(profile, 'this_week');

      const sessionKey = `${dbKey}:${senderId}`;
      await updateLastBotReply?.(cosmosContainer, dbKey, sessionKey, context);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ reply: replyText, auto_escape: false })
      };
    }

    const chaoxingUrl = extractChaoxingScheduleUrl(msg);
    if (chaoxingUrl) {
      context.log(`[Schedule] 检测到学习通课表链接: ${chaoxingUrl}`);
      const apiResult = await fetchScheduleFromChaoxingAPI(chaoxingUrl, context);

      if (apiResult.error) {
        context.log(`[Schedule] API 调用失败,尝试远程爬虫...`);
        const scraperResult = await fetchScheduleFromRemoteScraper(chaoxingUrl, context, fetchBypass);

        if (scraperResult && scraperResult.events && scraperResult.events.length > 0) {
          await saveScheduleToCosmos(cosmosContainer, dbKey, scraperResult.events, context);
          await saveUserScheduleProfile(cosmosContainer, senderId, scraperResult, chaoxingUrl, context);

          const summary = formatScheduleSummary(scraperResult.events, 8);
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              reply: `✅ 已成功解析学习通课表 (通过爬虫)！\n\n${scraperResult.events.length} 门课程已保存\n\n📚 最近课程:\n${summary}`,
              auto_escape: false
            })
          };
        }

        return {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            reply: apiResult.error + '\n\n备用爬虫方案也失败了。\n建议:\n1. 使用 ICS/Excel 文件上传\n2. 截图课表后发送给我 (将使用 OCR 识别)',
            auto_escape: false
          })
        };
      }

      if (apiResult.events && apiResult.events.length > 0) {
        await saveScheduleToCosmos(cosmosContainer, dbKey, apiResult.events, context);
        await saveUserScheduleProfile(cosmosContainer, senderId, apiResult, chaoxingUrl, context);

        const summary = formatScheduleSummary(apiResult.events, 8);
        const curriculum = apiResult.curriculum;

        return {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            reply: `✅ 学习通课表解析成功！\n\n📅 学年: ${curriculum.schoolYear || '未知'}-${curriculum.semester || '未知'}\n📍 当前周次: 第 ${curriculum.currentWeek || '?'} 周 (共 ${curriculum.maxWeek || '?'} 周)\n📚 课程总数: ${apiResult.events.length} 门\n\n最近课程安排:\n${summary}\n\n💡 数据已保存,可查询"本周课表"、"明天有课吗"等`,
            auto_escape: false
          })
        };
      }
    }

    const orderedFiles = (fileLinks || []).slice().sort((a, b) => {
      const ext = (s) => (s.url || '').toLowerCase().split('.').pop();
      const weight = (e) => e === 'ics' ? 0 : e === 'xlsx' ? 1 : e === 'xls' ? 2 : 3;
      return weight(ext(a)) - weight(ext(b));
    });

    for (const f of orderedFiles) {
      const buf = await downloadFileBuffer(f.url, context, fetchBypass);
      if (!buf) continue;
      let events = [];
      const lower = f.url.toLowerCase();
      if (lower.endsWith('.ics')) {
        events = parseIcsEvents(buf, context);
      } else {
        events = parseExcelEvents(buf, context);
      }

      if (events.length > 0) {
        const summary = formatScheduleSummary(events);
        await saveScheduleToCosmos(cosmosContainer, dbKey, events, context);
        await saveUserScheduleProfile(cosmosContainer, senderId, { events }, f.url, context);

        const sessionKey = `${dbKey}:${senderId}`;
        await updateLastBotReply?.(cosmosContainer, dbKey, sessionKey, context);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            reply: `已解析官方导出文件(${f.name || f.url})，选取最近安排如下:\n${summary || '(没有即将到来的事件)'}\n如需更多安排请直接发送关键词"课表"。`,
            auto_escape: false
          })
        };
      }
    }

    if (imageUrls && imageUrls.length > 0 && (hasKeyword || orderedFiles.length === 0)) {
      const cvSummary = await checkComputerVision?.(imageUrls[0], context);
      const ocrText = extractOcrText(cvSummary);
      const { events, summary } = await parseScheduleFromOcrText(ocrText, context, token);

      // 🎯 计算 OCR 置信度
      const { computeOcrConfidence } = require('./ocrSchedule');
      const rawSchedule = events.map(e => ({
        courseName: e.title,
        instructor: e.description?.includes('老师') ? e.description : null,
        location: e.location,
        weekday: e.start ? new Date(e.start).getDay() : null,
        startTime: e.start ? e.start.toTimeString().slice(0, 5) : null,
        endTime: e.end ? e.end.toTimeString().slice(0, 5) : null,
        weeks: null
      }));
      const confidence = computeOcrConfidence(rawSchedule);
      context?.log?.(`[OCR] 置信度: ${(confidence * 100).toFixed(1)}%`);

      // 🎯 如果置信度过低,警告用户
      const lowConfidenceWarning = confidence < 0.6 
        ? '\n\n⚠️ **图片质量太低,识别准确率不足**\n建议: 重新上传更清晰的截图或使用 ICS/Excel 文件\n\n' 
        : '';

      const formatted = formatScheduleSummary(events);
      if (events.length > 0) {
        await saveScheduleToCosmos(cosmosContainer, dbKey, events, context);
        await saveUserScheduleProfile(cosmosContainer, senderId, { events }, 'ocr_upload', context);
      }
      const sessionKey = `${dbKey}:${senderId}`;
      await updateLastBotReply?.(cosmosContainer, dbKey, sessionKey, context);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          reply: events.length > 0
            ? `${lowConfidenceWarning}未找到官方导出文件,已通过 OCR 解析截图,最近安排如下:\n${formatted}`
            : `未找到官方导出文件,OCR 提取到的文字如下,建议直接提供 Excel/ICS 以提升准确度:\n${summary}`,
          auto_escape: false
        })
      };
    }

    if (orderedFiles.length > 0) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          reply: '已收到文件但无法识别，请确认是官方导出的 Excel/ICS，或提供更清晰的课表截图以便 OCR 解析。',
          auto_escape: false
        })
      };
    }

    return null;
  };
}

module.exports = {
  SCHEDULE_KEYWORDS,
  extractChaoxingScheduleUrl,
  extractScheduleFileLinks,
  createScheduleHandler,
  formatScheduleSummary
};
