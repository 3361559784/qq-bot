const axios = require('axios');

/**
 * 从学习通分享链接提取 curriculumUuid
 * @param {string} url - 学习通课表分享链接
 * @returns {string|null} curriculumUuid 或 null
 */
function extractCurriculumUuid(url) {
  const match = url.match(/curriculumUuid=([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * 获取课表基本信息(包括maxWeek)
 * @param {string} curriculumUuid - 课表 UUID
 * @returns {Promise<Object>} { success, maxWeek, curriculum, error }
 */
async function getScheduleInfo(curriculumUuid) {
  try {
    const apiUrl = `https://kb.chaoxing.com/curriculum/getOtherLessons?appId=1000&curriculumUuid=${curriculumUuid}`;
    
    const response = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 15000
    });

    const data = response.data;
    if (data.result !== 1 || !data.data) {
      return { success: false, error: '无法获取课表信息' };
    }

    const maxWeek = data.data.curriculum?.maxWeek || 20;
    return {
      success: true,
      maxWeek,
      curriculum: data.data.curriculum
    };
  } catch (error) {
    console.error(`[getScheduleInfo] 失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * 获取指定周次的课程数据
 * @param {string} curriculumUuid - 课表 UUID
 * @param {number} week - 周次
 * @returns {Promise<Array>} 课程数组
 */
async function fetchLessonsByWeek(curriculumUuid, week) {
  const result = await fetchChaoxingSchedule(curriculumUuid, week);
  return result.success ? result.data.lessons : [];
}

/**
 * 课程去重(基于 courseNo + beginNumber + dayOfWeek)
 * @param {Array} lessons - 课程数组
 * @returns {Array} 去重后的课程数组
 */
function dedupeLessons(lessons) {
  const seen = new Set();
  return lessons.filter(lesson => {
    const key = `${lesson.courseNo || ''}_${lesson.beginNumber}_${lesson.dayOfWeek}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 获取全学期课表(1..maxWeek)并发请求
 * @param {string} curriculumUuid - 课表 UUID
 * @returns {Promise<Object>} { success, lessons, maxWeek, curriculum, error }
 */
async function fetchAllWeeksLessons(curriculumUuid) {
  try {
    // Step 1: 获取maxWeek 和 curriculum
    const info = await getScheduleInfo(curriculumUuid);
    if (!info.success) {
      return { success: false, error: info.error };
    }

    const maxWeek = info.maxWeek;
    const curriculum = info.curriculum;
    console.log(`[fetchAllWeeksLessons] 总周数: ${maxWeek}`);

    // Step 2: 并发获取所有周次
    const promises = [];
    for (let week = 1; week <= maxWeek; week++) {
      promises.push(fetchLessonsByWeek(curriculumUuid, week));
    }

    const results = await Promise.all(promises);
    
    // Step 3: 合并并去重
    const allLessons = results.flat();
    const uniqueLessons = dedupeLessons(allLessons);

    console.log(`[fetchAllWeeksLessons] 合并后课程数: ${allLessons.length}, 去重后: ${uniqueLessons.length}`);

    // 🎯 Step 4: 标准化字段转换
    const standardizedLessons = transformLessonsToStandardFormat(uniqueLessons, curriculum);

    return {
      success: true,
      lessons: standardizedLessons,
      maxWeek,
      curriculum
    };
  } catch (error) {
    console.error(`[fetchAllWeeksLessons] 失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * 调用学习通 getOtherLessons API 获取课表数据
 * @param {string} curriculumUuid - 课表 UUID
 * @param {number} week - 周次 (可选,默认获取当前周)
 * @returns {Promise<Object>} 包含课表数据的对象 { success, data, error }
 */
async function fetchChaoxingSchedule(curriculumUuid, week = null) {
  try {
    let apiUrl = `https://kb.chaoxing.com/curriculum/getOtherLessons?appId=1000&curriculumUuid=${curriculumUuid}`;
    if (week !== null) {
      apiUrl += `&week=${week}`;
    }

    console.log(`[Chaoxing API] 请求 URL: ${apiUrl}`);
    
    const response = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 15000
    });

    const data = response.data;

    // 检查 API 返回状态
    if (data.result !== 1) {
      console.error(`[Chaoxing API] API 返回错误: ${data.msg || '未知错误'}`);
      return {
        success: false,
        error: data.msg || 'API 返回 result !== 1',
        errorType: 'api_error'
      };
    }

    // 检查数据完整性
    if (!data.data || !data.data.lessonArray) {
      console.error('[Chaoxing API] 返回数据缺少 lessonArray');
      return {
        success: false,
        error: '课表数据为空',
        errorType: 'empty_data'
      };
    }

    console.log(`[Chaoxing API] 成功获取 ${data.data.lessonArray.length} 条课程数据`);

    return {
      success: true,
      data: {
        curriculum: data.data.curriculum,
        lessons: data.data.lessonArray,
        visitor: data.data.visitor,
        sysTime: data.data.sysTime
      }
    };

  } catch (error) {
    console.error(`[Chaoxing API] 请求失败: ${error.message}`);
    
    // 区分错误类型
    let errorType = 'network_error';
    if (error.response) {
      errorType = 'http_error';
      if (error.response.status === 404) errorType = 'not_found';
      if (error.response.status >= 500) errorType = 'server_error';
    } else if (error.code === 'ECONNABORTED') {
      errorType = 'timeout';
    }

    return {
      success: false,
      error: error.message,
      errorType
    };
  }
}

/**
 * 将学习通课程数据转换为标准格式
 * @param {Array} lessons - lessonArray 数组
 * @param {Object} curriculum - 课表元数据
 * @returns {Array} 标准化的课程事件数组 { name, teacher, location, day, start, duration, date, raw }
 */
function transformLessonsToStandardFormat(lessons, curriculum) {
  const events = [];
  const timeConfigArray = curriculum.lessonTimeConfigArray || [];

  // lessonTimeConfigArray 在不同学校可能是 0/1 基索引，这里做容错
  const pickTimeConfig = (idx) => {
    if (!Array.isArray(timeConfigArray)) return '';
    if (idx == null) return '';
    const i = Number(idx);
    if (!Number.isFinite(i)) return '';
    // 先尝试原索引，再尝试 idx-1（常见 1 基）
    return String(timeConfigArray[i] || timeConfigArray[i - 1] || '');
  };

  const extractHHMM = (s) => {
    const m = String(s || '').match(/(\d{1,2}:\d{2})/);
    if (!m) return '';
    const [hh, mm] = m[1].split(':');
    return `${String(Number(hh)).padStart(2, '0')}:${mm}`;
  };

  for (const lesson of lessons) {
    try {
      // 解析时间
      const beginNumber = lesson.beginNumber || 0;
      const length = lesson.length || 1;
      const endNumber = beginNumber + length - 1;

      const startTimeConfig = pickTimeConfig(beginNumber);
      // 结束时间通常在“下一节开始”或“本节结束”，做多路兜底
      const endTimeConfig = pickTimeConfig(endNumber + 1) || pickTimeConfig(endNumber);

      // 提取开始和结束时间 (HH:MM 格式)
      let startTime = extractHHMM(startTimeConfig);
      let endTime = extractHHMM(endTimeConfig);

      // 某些返回里 lesson 自带时间字段（优先补齐）
      if (!startTime) startTime = extractHHMM(lesson.startTime || lesson.beginTime || lesson.timeStart || '');
      if (!endTime) endTime = extractHHMM(lesson.endTime || lesson.finishTime || lesson.timeEnd || '');

      // 计算时长(分钟)
      let duration = 0;
      if (startTime && endTime) {
        const [startHour, startMin] = startTime.split(':').map(Number);
        const [endHour, endMin] = endTime.split(':').map(Number);
        duration = (endHour * 60 + endMin) - (startHour * 60 + startMin);
      }

      // 🎯 统一字段映射 - 上层逻辑只看这些标准字段
      events.push({
        name: lesson.name || lesson.courseName || '未命名课程',
        teacher: lesson.teacherName || lesson.instructor || '未知教师',
        location: lesson.location || lesson.classroom || '待定',
        day: lesson.dayOfWeek || lesson.weekday || 0, // 1-7 表示周一到周日
        start: startTime, // HH:MM 格式
        duration, // 时长(分钟)
        date: lesson.day || lesson.studyDate || '', // YYYY-MM-DD 格式(如果有)
        raw: lesson // 保留完整原始数据供调试/高级用途
      });
    } catch (err) {
      console.error(`[Transform] 转换课程失败: ${lesson.name}`, err.message);
    }
  }

  return events;
}

/**
 * 完整流程: URL -> UUID -> API 调用 -> 标准化数据
 * @param {string} url - 学习通课表分享链接
 * @param {number} week - 周次 (可选)
 * @returns {Promise<Object>} { success, schedule, curriculum, error }
 */
async function getChaoxingScheduleFromUrl(url, week = null) {
  // Step 1: 提取 UUID
  const uuid = extractCurriculumUuid(url);
  if (!uuid) {
    return {
      success: false,
      error: '无法从 URL 中提取 curriculumUuid',
      errorType: 'invalid_url'
    };
  }

  console.log(`[Chaoxing] 提取到 UUID: ${uuid}`);

  // Step 2: 调用 API
  const result = await fetchChaoxingSchedule(uuid, week);
  if (!result.success) {
    return result;
  }

  // Step 3: 数据转换
  const schedule = transformLessonsToStandardFormat(
    result.data.lessons,
    result.data.curriculum
  );

  return {
    success: true,
    schedule,
    curriculum: result.data.curriculum,
    metadata: {
      curriculumUuid: uuid,
      visitor: result.data.visitor,
      sysTime: result.data.sysTime,
      totalLessons: schedule.length
    }
  };
}

module.exports = {
  extractCurriculumUuid,
  fetchChaoxingSchedule,
  transformLessonsToStandardFormat,
  getChaoxingScheduleFromUrl,
  getScheduleInfo,
  fetchLessonsByWeek,
  dedupeLessons,
  fetchAllWeeksLessons
};
