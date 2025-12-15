export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';

interface CourseItem {
  courseName: string;
  instructor: string | null;
  location: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  weeks: string | null;
}

// 开学日期（第1周周一）
const SEMESTER_START = new Date('2025-09-01');

// 获取上海时间
function getShanghaiTime(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

// 获取星期几 (1=周一, 7=周日)
function getWeekday(date: Date): number {
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
}

// 计算当前是第几周
function getCurrentWeek(): number {
  const now = getShanghaiTime();
  const weekday = now.getUTCDay();
  // 找到本周一
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysToSubtract = weekday === 0 ? 6 : weekday - 1;
  const thisMonday = new Date(todayStart.getTime() - daysToSubtract * 24 * 60 * 60 * 1000);
  
  // 计算距离开学周一的天数
  const semesterStart = new Date(Date.UTC(SEMESTER_START.getFullYear(), SEMESTER_START.getMonth(), SEMESTER_START.getDate()));
  const daysDiff = Math.floor((thisMonday.getTime() - semesterStart.getTime()) / (24 * 60 * 60 * 1000));
  
  return Math.floor(daysDiff / 7) + 1;
}

// 解析 weeks 字段，判断课程是否在指定周有效
// 支持格式: "7-16周", "7周,9周,11周,13周", "6-7周,9-17周", "7周,10-15周"
function isCourseInWeek(weeks: string | null, targetWeek: number): boolean {
  if (!weeks) return true; // 没有周次信息，默认所有周都有
  
  // 移除"周"字
  const cleaned = weeks.replace(/周/g, '');
  const parts = cleaned.split(',');
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      // 范围格式: "7-16"
      const [start, end] = trimmed.split('-').map(Number);
      if (targetWeek >= start && targetWeek <= end) {
        return true;
      }
    } else {
      // 单周格式: "7"
      const week = parseInt(trimmed);
      if (week === targetWeek) {
        return true;
      }
    }
  }
  
  return false;
}

// 时间字符串转分钟数
function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

// 格式化时间显示
function formatTimeRange(start: string, end: string): string {
  return `${start} - ${end}`;
}

function formatWeeklyOverview(schedule: CourseItem[], isNextWeek: boolean = true): string {
  const weekdays = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  
  // 计算目标周次
  const currentWeek = getCurrentWeek();
  const targetWeek = isNextWeek ? currentWeek + 1 : currentWeek;
  const weekLabel = isNextWeek ? '下周' : '本周';

  // 过滤该周有效的课程
  const validCourses = schedule.filter(c => isCourseInWeek(c.weeks, targetWeek));
  
  if (validCourses.length === 0) {
    return `📅 **第${targetWeek}周${weekLabel.slice(1)}**暂无课程安排，可以好好休息哦！`;
  }

  const grouped: Record<number, CourseItem[]> = {};
  for (const c of validCourses) {
    if (!grouped[c.weekday]) grouped[c.weekday] = [];
    grouped[c.weekday].push(c);
  }

  // 按表格形式输出
  const rows: string[] = [];
  rows.push('| 星期 | 时间 | 课程 | 地点 |');
  rows.push('|:----:|:----:|:----:|:----:|');

  let totalCourses = 0;
  for (let d = 1; d <= 7; d++) {
    const courses = (grouped[d] || []).sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    if (courses.length === 0) continue;

    for (let i = 0; i < courses.length; i++) {
      const c = courses[i];
      const dayLabel = i === 0 ? weekdays[d] : '';
      const loc = c.location || '-';
      rows.push(`| ${dayLabel} | ${c.startTime}-${c.endTime} | ${c.courseName} | ${loc} |`);
      totalCourses++;
    }
  }

  if (totalCourses === 0) {
    return `📅 **第${targetWeek}周${weekLabel.slice(1)}**暂无课程安排，可以好好休息哦！`;
  }

  return `📅 **第${targetWeek}周（${weekLabel}）课表** (共${totalCourses}节)\n\n${rows.join('\n')}\n\n✨ 合理安排时间，加油！`;
}

/**
 * 根据课表回答问题
 */
function answerClassQuestion(question: string, schedule: CourseItem[]): string {
  const now = getShanghaiTime();
  const currentWeekday = getWeekday(now);
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const currentWeek = getCurrentWeek();
  
  const lowerQ = question.toLowerCase();

  // 今天的课程（过滤本周有效的）
  const todayCourses = schedule
    .filter(c => c.weekday === currentWeekday && isCourseInWeek(c.weeks, currentWeek))
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  // 明天的课程（如果今天是周日，明天是下一周的周一）
  const tomorrowWeekday = currentWeekday === 7 ? 1 : currentWeekday + 1;
  const tomorrowWeek = currentWeekday === 7 ? currentWeek + 1 : currentWeek;
  const tomorrowCourses = schedule
    .filter(c => c.weekday === tomorrowWeekday && isCourseInWeek(c.weeks, tomorrowWeek))
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  // 🔥 优先级1："下一节课是什么"（最高优先级）
  if (lowerQ.includes('下一节') || lowerQ.includes('下节课') || lowerQ.includes('接下来')) {
    // 找今天剩余的课
    const nextCourse = todayCourses.find(c => timeToMinutes(c.startTime) > currentMinutes);
    
    if (nextCourse) {
      const location = nextCourse.location ? `，地点在 ${nextCourse.location}` : '';
      return `下一节课是《${nextCourse.courseName}》${location}，时间是 ${formatTimeRange(nextCourse.startTime, nextCourse.endTime)}。✨`;
    }
    
    // 今天没课了，看明天
    if (tomorrowCourses.length > 0) {
      const first = tomorrowCourses[0];
      const location = first.location ? `，地点在 ${first.location}` : '';
      return `今天没有课了～明天第一节是《${first.courseName}》${location}，时间是 ${formatTimeRange(first.startTime, first.endTime)}。✨`;
    }
    
    return '今天和明天都没有课哦，好好休息吧！✨';
  }

  // "今天有什么课" / "今天有课吗"
  if (lowerQ.includes('今天')) {
    if (todayCourses.length === 0) {
      return '今天没有课，可以休息或自习哦！✨';
    }
    
    const lines = todayCourses.map(c => {
      const loc = c.location ? ` @ ${c.location}` : '';
      return `- ${c.startTime}-${c.endTime} 《${c.courseName}》${loc}`;
    });
    
    return `今天的课程安排：\n${lines.join('\n')}`;
  }

  // "明天有什么课" / "明天有课吗"
  if (lowerQ.includes('明天')) {
    if (tomorrowCourses.length === 0) {
      return '明天没有课，可以好好休息或安排学习计划！✨';
    }
    
    const lines = tomorrowCourses.map(c => {
      const loc = c.location ? ` @ ${c.location}` : '';
      return `- ${c.startTime}-${c.endTime} 《${c.courseName}》${loc}`;
    });
    
    return `明天的课程安排：\n${lines.join('\n')}`;
  }

  // "下周/下个星期/下星期"
  if (
    lowerQ.includes('下周') ||
    lowerQ.includes('下个星期') ||
    lowerQ.includes('下星期')
  ) {
    return formatWeeklyOverview(schedule, true); // 下周
  }

  // "本周/这周/周课表/课表"
  if (
    lowerQ.includes('本周') ||
    lowerQ.includes('这周') ||
    lowerQ.includes('周课表') ||
    lowerQ.includes('课表')
  ) {
    return formatWeeklyOverview(schedule, false); // 本周
  }

  // 默认：显示今天剩余课程
  const remaining = todayCourses.filter(c => timeToMinutes(c.endTime) > currentMinutes);
  if (remaining.length > 0) {
    const lines = remaining.map(c => {
      const loc = c.location ? ` @ ${c.location}` : '';
      return `- ${c.startTime}-${c.endTime} 《${c.courseName}》${loc}`;
    });
    return `今天还有 ${remaining.length} 节课：\n${lines.join('\n')}`;
  }

  return '今天的课已经上完啦！有什么其他想了解的吗？';
}

/**
 * POST /api/class - Class模式问答
 */
export async function POST(req: NextRequest) {
  try {
    const { question, schedule } = await req.json();

    if (!question || typeof question !== 'string') {
      return NextResponse.json({ error: '请输入问题' }, { status: 400 });
    }

    if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
      return NextResponse.json({ 
        reply: '还没有导入课表哦，请先导入课表再问课程相关问题～',
        needSchedule: true 
      });
    }

    const reply = answerClassQuestion(question, schedule);

    return NextResponse.json({ reply });

  } catch (error) {
    console.error('[Class API] Error:', error);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
