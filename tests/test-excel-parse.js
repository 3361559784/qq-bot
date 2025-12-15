// 测试 Excel 解析（节次格式如 "1-2"）
const fs = require('fs');
const XLSX = require('xlsx');

const PERIOD_TIMES = {
  1: { start: '08:00', end: '08:45' },
  2: { start: '08:55', end: '09:40' },
  3: { start: '10:00', end: '10:45' },
  4: { start: '10:55', end: '11:40' },
  5: { start: '14:00', end: '14:45' },
  6: { start: '14:55', end: '15:35' },
  7: { start: '15:55', end: '16:40' },
  8: { start: '16:50', end: '17:30' },
  9: { start: '19:00', end: '19:45' },
  10: { start: '19:55', end: '20:40' },
};

const WEEKDAY_MAP = {
  '一': 1, '周一': 1, '星期一': 1,
  '二': 2, '周二': 2, '星期二': 2,
  '三': 3, '周三': 3, '星期三': 3,
  '四': 4, '周四': 4, '星期四': 4,
  '五': 5, '周五': 5, '星期五': 5,
  '六': 6, '周六': 6, '星期六': 6,
  '日': 7, '七': 7, '周日': 7, '星期日': 7,
};

function parseTimeRange(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  
  // 节次范围 "1-2", "3-4", "5" 等
  const rangeMatch = str.match(/^(\d+)(?:[-~](\d+))?$/);
  if (rangeMatch) {
    const p1 = parseInt(rangeMatch[1]);
    const p2 = rangeMatch[2] ? parseInt(rangeMatch[2]) : p1;
    const startPeriod = PERIOD_TIMES[p1];
    const endPeriod = PERIOD_TIMES[p2];
    if (startPeriod && endPeriod) {
      return { start: startPeriod.start, end: endPeriod.end };
    }
  }
  return null;
}

function parseWeekday(dayStr) {
  if (!dayStr) return null;
  const str = String(dayStr).trim();
  if (WEEKDAY_MAP[str]) return WEEKDAY_MAP[str];
  const num = parseInt(str);
  if (num >= 1 && num <= 7) return num;
  return null;
}

async function test() {
  const xlsxBuf = fs.readFileSync('yanle-schedule.xlsx');
  const wb = XLSX.read(xlsxBuf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
  console.log('=== Excel 内容 ===');
  console.log('Headers:', rows[0]);
  console.log('');
  
  console.log('=== 节次解析测试 ===');
  ['1-2', '3-4', '5-6', '7-8', '5'].forEach(tc => {
    const result = parseTimeRange(tc);
    console.log(`parseTimeRange("${tc}"):`, result);
  });
  
  console.log('');
  console.log('=== 星期解析测试 ===');
  ['一', '二', '三', '周一', '星期五'].forEach(tc => {
    const result = parseWeekday(tc);
    console.log(`parseWeekday("${tc}"):`, result);
  });
  
  console.log('');
  console.log('=== 解析课表 ===');
  // 根据你的表格: 课程名称, 星期, 节次, 教室, 教师, 周次
  const courses = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    
    const courseName = String(row[0] || '').trim();
    const weekday = parseWeekday(row[1]);
    const timeRange = parseTimeRange(row[2]);
    const location = String(row[3] || '').trim();
    const instructor = String(row[4] || '').trim();
    const weeks = String(row[5] || '').trim();
    
    if (courseName && weekday && timeRange) {
      courses.push({
        courseName,
        weekday,
        startTime: timeRange.start,
        endTime: timeRange.end,
        location: location || null,
        instructor: instructor || null,
        weeks: weeks || null,
      });
    }
  }
  
  console.log(`成功解析 ${courses.length} 门课程:`);
  courses.forEach((c, i) => {
    console.log(`${i+1}. 周${c.weekday} ${c.startTime}-${c.endTime} ${c.courseName} @ ${c.location || '-'} (${c.weeks || '-'})`);
  });
}

test().catch(e => console.error('Test failed:', e));
