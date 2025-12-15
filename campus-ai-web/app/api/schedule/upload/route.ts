export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

// 课表数据类型
interface CourseItem {
  courseName: string;
  instructor: string | null;
  location: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  weeks: string | null;
}

// 节次对应时间
const PERIOD_TIMES: Record<number, { start: string; end: string }> = {
  1: { start: "08:00", end: "08:45" },
  2: { start: "08:55", end: "09:40" },
  3: { start: "10:00", end: "10:45" },
  4: { start: "10:55", end: "11:40" },
  5: { start: "14:00", end: "14:45" },
  6: { start: "14:55", end: "15:35" },
  7: { start: "15:55", end: "16:40" },
  8: { start: "16:50", end: "17:30" },
  9: { start: "19:00", end: "19:45" },
  10: { start: "19:55", end: "20:40" },
};

// 星期映射（含简写）
const WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '周一': 1, '星期一': 1, 'monday': 1, 'mon': 1,
  '二': 2, '周二': 2, '星期二': 2, 'tuesday': 2, 'tue': 2,
  '三': 3, '周三': 3, '星期三': 3, 'wednesday': 3, 'wed': 3,
  '四': 4, '周四': 4, '星期四': 4, 'thursday': 4, 'thu': 4,
  '五': 5, '周五': 5, '星期五': 5, 'friday': 5, 'fri': 5,
  '六': 6, '周六': 6, '星期六': 6, 'saturday': 6, 'sat': 6,
  '日': 7, '七': 7, '周日': 7, '星期日': 7, '星期天': 7, 'sunday': 7, 'sun': 7,
};

/**
 * 解析时间字符串，支持多种格式
 * 返回 { start, end } 或 null
 */
function parseTimeRange(timeStr: string): { start: string; end: string } | null {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  
  // HH:MM 或 H:MM
  const match1 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (match1) {
    const t = `${match1[1].padStart(2, '0')}:${match1[2]}`;
    return { start: t, end: t };
  }
  
  // HHMM
  const match2 = str.match(/^(\d{2})(\d{2})$/);
  if (match2) {
    const t = `${match2[1]}:${match2[2]}`;
    return { start: t, end: t };
  }
  
  // 第X节
  const match3 = str.match(/第(\d+)节/);
  if (match3) {
    const period = parseInt(match3[1]);
    const p = PERIOD_TIMES[period];
    if (p) return { start: p.start, end: p.end };
  }
  
  // 节次范围 "1-2", "3-4", "5" 等（常见格式）
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

/**
 * 解析星期
 */
function parseWeekday(dayStr: string): number | null {
  if (!dayStr) return null;
  const str = String(dayStr).trim();
  const strLower = str.toLowerCase();
  
  // 直接匹配（中文不需要转小写）
  if (WEEKDAY_MAP[str]) return WEEKDAY_MAP[str];
  if (WEEKDAY_MAP[strLower]) return WEEKDAY_MAP[strLower];
  
  // 包含检测
  for (const [key, value] of Object.entries(WEEKDAY_MAP)) {
    if (str.includes(key) || strLower.includes(key)) return value;
  }
  
  // 数字检测 (1-7)
  const num = parseInt(str);
  if (num >= 1 && num <= 7) return num;
  
  return null;
}

/**
 * 解析 Excel 文件
 */
function parseExcel(buffer: ArrayBuffer): CourseItem[] {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  
  if (rows.length < 2) {
    throw new Error('Excel文件为空或格式不正确');
  }
  
  // 尝试检测表头
  const firstRow = rows[0] as unknown[];
  const headers = firstRow.map(h => String(h || '').toLowerCase());
  
  console.log('[Excel Parse] 表头:', headers);
  
  // 列索引映射
  const colMap = {
    name: -1,
    weekday: -1,
    startTime: -1,
    endTime: -1,
    location: -1,
    instructor: -1,
    weeks: -1,
  };
  
  // 自动检测列 - 注意：先检测更具体的关键词
  const nameKeys = ['课程名称', '课程名', '课程', 'course', '科目', 'subject'];
  const weekdayKeys = ['星期几', '星期', 'weekday', 'day']; // 移除 '周' 避免与周次冲突
  const startTimeKeys = ['开始时间', '开始', '上课', 'start', '节次'];
  const endTimeKeys = ['结束时间', '结束', '下课', 'end'];
  const locationKeys = ['上课地点', '地点', '教室', 'location', 'room'];
  const instructorKeys = ['任课教师', '教师', '老师', 'teacher', 'instructor'];
  const weeksKeys = ['上课周次', '周次', 'weeks'];
  
  headers.forEach((h, i) => {
    if (colMap.name === -1 && nameKeys.some(k => h.includes(k))) colMap.name = i;
    else if (colMap.weekday === -1 && weekdayKeys.some(k => h.includes(k))) colMap.weekday = i;
    else if (colMap.startTime === -1 && startTimeKeys.some(k => h.includes(k))) colMap.startTime = i;
    else if (colMap.endTime === -1 && endTimeKeys.some(k => h.includes(k))) colMap.endTime = i;
    else if (colMap.location === -1 && locationKeys.some(k => h.includes(k))) colMap.location = i;
    else if (colMap.instructor === -1 && instructorKeys.some(k => h.includes(k))) colMap.instructor = i;
    else if (colMap.weeks === -1 && weeksKeys.some(k => h.includes(k))) colMap.weeks = i;
  });
  
  console.log('[Excel Parse] 列映射:', colMap);
  
  // 必须有课程名和星期
  if (colMap.name === -1) {
    // 尝试使用第一列作为课程名
    colMap.name = 0;
  }
  if (colMap.weekday === -1) {
    // 尝试使用第二列作为星期
    colMap.weekday = 1;
  }
  
  const courses: CourseItem[] = [];
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    if (!row || row.length === 0) continue;
    
    const courseName = row[colMap.name] ? String(row[colMap.name]).trim() : '';
    if (!courseName) continue;
    
    const weekday = parseWeekday(String(row[colMap.weekday] || ''));
    if (!weekday) continue;
    
    // 支持节次范围格式（如 "1-2"）
    const startStr = String(row[colMap.startTime] || '');
    const endStr = String(row[colMap.endTime] || '');
    const startRange = parseTimeRange(startStr);
    const endRange = parseTimeRange(endStr);
    
    const startTime = startRange?.start || '08:00';
    const endTime = endRange?.end || startRange?.end || '09:40';
    
    courses.push({
      courseName,
      weekday,
      startTime,
      endTime,
      location: colMap.location >= 0 && row[colMap.location] ? String(row[colMap.location]).trim() : null,
      instructor: colMap.instructor >= 0 && row[colMap.instructor] ? String(row[colMap.instructor]).trim() : null,
      weeks: colMap.weeks >= 0 && row[colMap.weeks] ? String(row[colMap.weeks]).trim() : null,
    });
  }
  
  return courses;
}

/**
 * 解析 ICS 文件
 */
function parseICS(content: string): CourseItem[] {
  const courses: CourseItem[] = [];
  const events = content.split('BEGIN:VEVENT');
  
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    
    // 提取 SUMMARY (课程名)
    const summaryMatch = event.match(/SUMMARY:(.+?)(?:\r?\n|$)/);
    const courseName = summaryMatch ? summaryMatch[1].trim() : '';
    if (!courseName) continue;
    
    // 提取 DTSTART
    const dtStartMatch = event.match(/DTSTART[^:]*:(\d{8}T\d{6})/);
    let weekday = 1;
    let startTime = '08:00';
    
    if (dtStartMatch) {
      const dtStart = dtStartMatch[1];
      // 解析日期获取星期
      const year = parseInt(dtStart.substring(0, 4));
      const month = parseInt(dtStart.substring(4, 6)) - 1;
      const day = parseInt(dtStart.substring(6, 8));
      const date = new Date(year, month, day);
      weekday = date.getDay() || 7; // 0=周日 -> 7
      
      // 解析时间
      const hour = dtStart.substring(9, 11);
      const minute = dtStart.substring(11, 13);
      startTime = `${hour}:${minute}`;
    }
    
    // 提取 DTEND
    const dtEndMatch = event.match(/DTEND[^:]*:(\d{8}T\d{6})/);
    let endTime = '09:40';
    
    if (dtEndMatch) {
      const dtEnd = dtEndMatch[1];
      const hour = dtEnd.substring(9, 11);
      const minute = dtEnd.substring(11, 13);
      endTime = `${hour}:${minute}`;
    }
    
    // 提取 LOCATION
    const locationMatch = event.match(/LOCATION:(.+?)(?:\r?\n|$)/);
    const location = locationMatch ? locationMatch[1].trim() : null;
    
    // 提取 DESCRIPTION 中的教师信息
    const descMatch = event.match(/DESCRIPTION:(.+?)(?:\r?\n|$)/);
    let instructor: string | null = null;
    if (descMatch) {
      const teacherMatch = descMatch[1].match(/(?:教师|老师|Teacher)[：:]\s*(.+?)(?:[，,;；]|$)/i);
      instructor = teacherMatch ? teacherMatch[1].trim() : null;
    }
    
    courses.push({
      courseName,
      weekday,
      startTime,
      endTime,
      location,
      instructor,
      weeks: null,
    });
  }
  
  // 去重
  const seen = new Set<string>();
  return courses.filter(c => {
    const key = `${c.courseName}_${c.weekday}_${c.startTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * POST /api/schedule/upload - 上传文件导入课表
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    
    if (!file) {
      return NextResponse.json({ error: '请上传文件' }, { status: 400 });
    }
    
    const fileName = file.name.toLowerCase();
    const buffer = await file.arrayBuffer();
    
    let courses: CourseItem[] = [];
    let source = 'unknown';
    
    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      courses = parseExcel(buffer);
      source = 'excel';
      console.log(`[Schedule Upload] Excel解析 ${courses.length} 条课程`);
    } else if (fileName.endsWith('.ics')) {
      const text = new TextDecoder().decode(buffer);
      courses = parseICS(text);
      source = 'ics';
      console.log(`[Schedule Upload] ICS解析 ${courses.length} 条课程`);
    } else {
      return NextResponse.json({ error: '不支持的文件格式，请上传 .xlsx/.xls/.ics 文件' }, { status: 400 });
    }
    
    if (courses.length === 0) {
      return NextResponse.json({ error: '未能从文件中解析出课程数据，请检查文件格式' }, { status: 400 });
    }
    
    return NextResponse.json({
      success: true,
      source,
      count: courses.length,
      schedule: courses,
    });
    
  } catch (error: unknown) {
    console.error('[Schedule Upload] Error:', error);
    const errorMessage = error instanceof Error ? error.message : '文件解析失败';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
