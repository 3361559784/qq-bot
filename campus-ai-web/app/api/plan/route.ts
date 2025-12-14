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

/**
 * 基于课表生成学习计划
 */
function generateStudyPlan(schedule: CourseItem[], preferences?: string): string {
  const now = getShanghaiTime();
  const currentWeekday = getWeekday(now);
  
  const weekdays = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  
  // 按天分组
  const grouped: Record<number, CourseItem[]> = {};
  schedule.forEach(c => {
    if (!grouped[c.weekday]) grouped[c.weekday] = [];
    grouped[c.weekday].push(c);
  });

  // 分析课程分布，找出空闲时间
  const lines: string[] = ['📚 **本周学习计划**\n'];
  
  // 提取所有课程名称用于复习建议
  const courseNames = [...new Set(schedule.map(c => c.courseName))];
  
  for (let d = 1; d <= 7; d++) {
    const dayName = weekdays[d];
    const courses = (grouped[d] || []).sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    
    if (d < currentWeekday) continue; // 跳过已过去的日子
    
    lines.push(`\n**${dayName}${d === currentWeekday ? '（今天）' : ''}**`);
    
    if (courses.length === 0) {
      lines.push(`- 全天空闲，建议自习或复习`);
      if (courseNames.length > 0) {
        const randomCourse = courseNames[d % courseNames.length];
        lines.push(`- 推荐复习：《${randomCourse}》`);
      }
      continue;
    }
    
    // 早上空闲时间
    const firstCourse = courses[0];
    const firstStart = timeToMinutes(firstCourse.startTime);
    if (firstStart > 8 * 60) {
      lines.push(`- 08:00-${firstCourse.startTime} 早自习/预习`);
    }
    
    // 课程安排
    courses.forEach((c, i) => {
      const loc = c.location ? `@${c.location}` : '';
      lines.push(`- ${c.startTime}-${c.endTime} 上课：《${c.courseName}》${loc}`);
      
      // 课间休息或自习
      if (i < courses.length - 1) {
        const next = courses[i + 1];
        const gap = timeToMinutes(next.startTime) - timeToMinutes(c.endTime);
        if (gap >= 60) {
          lines.push(`- ${c.endTime}-${next.startTime} 自习/复习《${c.courseName}》笔记`);
        }
      }
    });
    
    // 下午/晚上空闲时间
    const lastCourse = courses[courses.length - 1];
    const lastEnd = timeToMinutes(lastCourse.endTime);
    if (lastEnd < 18 * 60) {
      lines.push(`- ${lastCourse.endTime}-18:00 自习时间`);
    }
    if (lastEnd < 21 * 60) {
      lines.push(`- 19:00-21:00 晚自习/作业时间`);
    }
  }
  
  // 周末建议
  if (currentWeekday <= 5) {
    lines.push('\n**周末建议**');
    lines.push(`- 复习本周课程：${courseNames.slice(0, 3).map(n => `《${n}》`).join('、')}`);
    lines.push('- 整理笔记，完成作业');
    lines.push('- 适当休息，保持良好状态');
  }
  
  lines.push('\n✨ 坚持就是胜利，加油！');
  
  return lines.join('\n');
}

/**
 * POST /api/plan - Plan模式生成学习计划
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, schedule, preferences, userIntent, userId } = body;

    // 如果有课表，使用本地生成
    if (schedule && Array.isArray(schedule) && schedule.length > 0) {
      const plan = generateStudyPlan(schedule, preferences);

      console.log('✅ 学习计划生成成功');
      console.log('课程数量:', schedule.length);
      console.log('计划预览:', plan.substring(0, 200) + '...');

      return NextResponse.json({ reply: plan });
    }

    // 没有课表，提示用户导入
    return NextResponse.json({ 
      reply: '还没有导入课表哦，请先导入课表再生成学习计划～',
      needSchedule: true 
    });

  } catch (error) {
    console.error('[Plan API] Error:', error);
    return NextResponse.json({ error: '生成计划失败' }, { status: 500 });
  }
}
