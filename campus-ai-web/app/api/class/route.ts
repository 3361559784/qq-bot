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

// 获取上海时间
function getShanghaiTime(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

// 获取星期几 (1=周一, 7=周日)
function getWeekday(date: Date): number {
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
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

/**
 * 根据课表回答问题
 */
function answerClassQuestion(question: string, schedule: CourseItem[]): string {
  const now = getShanghaiTime();
  const currentWeekday = getWeekday(now);
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  
  const lowerQ = question.toLowerCase();

  // 今天的课程
  const todayCourses = schedule
    .filter(c => c.weekday === currentWeekday)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  // 明天的课程
  const tomorrowWeekday = currentWeekday === 7 ? 1 : currentWeekday + 1;
  const tomorrowCourses = schedule
    .filter(c => c.weekday === tomorrowWeekday)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  // "下一节课是什么"
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

  // "本周/这周课表"
  if (lowerQ.includes('本周') || lowerQ.includes('这周') || lowerQ.includes('周课表')) {
    const weekdays = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const grouped: Record<number, CourseItem[]> = {};
    
    schedule.forEach(c => {
      if (!grouped[c.weekday]) grouped[c.weekday] = [];
      grouped[c.weekday].push(c);
    });

    const lines: string[] = [];
    for (let d = 1; d <= 7; d++) {
      const courses = grouped[d];
      if (courses && courses.length > 0) {
        lines.push(`【${weekdays[d]}】`);
        courses
          .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))
          .forEach(c => {
            const loc = c.location ? ` @ ${c.location}` : '';
            lines.push(`  ${c.startTime}-${c.endTime} ${c.courseName}${loc}`);
          });
      }
    }

    return lines.length > 0 
      ? `本周课表：\n${lines.join('\n')}`
      : '本周没有课程安排。';
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
