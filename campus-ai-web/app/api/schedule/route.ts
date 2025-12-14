export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';

// 课表数据类型
interface CourseItem {
  courseName: string;
  instructor: string | null;
  location: string | null;
  weekday: number; // 1-7
  startTime: string; // "08:00"
  endTime: string;   // "09:40"
  weeks: string | null; // "1-16周"
}

// 学习通API响应类型
interface ChaoxingLesson {
  name?: string;        // 课程名称字段
  courseName?: string;  // 备选字段
  teacherName?: string;
  teacher?: string;
  location?: string;
  dayOfWeek: number;
  beginNumber: number;
  length: number;
  weekIndices?: number[];
  weeks?: string;
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

/**
 * 从学习通URL提取课表UUID
 */
function extractCurriculumUuid(url: string): string | null {
  const match = url.match(/curriculumUuid=([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * 爬取学习通课表
 */
async function fetchChaoxingSchedule(curriculumUuid: string): Promise<CourseItem[]> {
  const apiUrl = `https://kb.chaoxing.com/curriculum/getOtherLessons?appId=1000&curriculumUuid=${curriculumUuid}`;
  
  const response = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'application/json',
    },
  });

  const data = await response.json();
  
  if (data.result !== 1 || !data.data?.lessonArray) {
    throw new Error(data.msg || '无法获取课表数据');
  }

  const lessons: ChaoxingLesson[] = data.data.lessonArray;
  
  // 转换为标准格式
  const courses: CourseItem[] = lessons.map(lesson => {
    const beginPeriod = lesson.beginNumber || 1;
    const endPeriod = beginPeriod + (lesson.length || 1) - 1;
    
    const startTime = PERIOD_TIMES[beginPeriod]?.start || "08:00";
    const endTime = PERIOD_TIMES[endPeriod]?.end || "09:40";
    
    // 课程名: 优先用 name, 其次 courseName
    const courseName = lesson.name || lesson.courseName || "未知课程";
    // 教师: 优先用 teacherName, 其次 teacher
    const instructor = lesson.teacherName || lesson.teacher || null;
    
    return {
      courseName,
      instructor,
      location: lesson.location || null,
      weekday: lesson.dayOfWeek || 1,
      startTime,
      endTime,
      weeks: lesson.weeks || (lesson.weekIndices?.length 
        ? `${Math.min(...lesson.weekIndices)}-${Math.max(...lesson.weekIndices)}周` 
        : null),
    };
  });

  // 去重（按课程名+星期+时间）
  const seen = new Set<string>();
  return courses.filter(c => {
    const key = `${c.courseName}_${c.weekday}_${c.startTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * POST /api/schedule - 导入课表
 * Body: { url: string } 或 { imageUrl: string } 或 { manualSchedule: CourseItem[] } 或 { schedule: CourseItem[] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { url, imageUrl, schedule, manualSchedule } = body;
    
    // 同时支持 schedule 和 manualSchedule 字段名
    const inputSchedule = manualSchedule || schedule;

    let courses: CourseItem[] = [];
    let source = 'unknown';

    let curriculumUuid: string | null = null;

    // 方式1: 学习通链接爬取
    if (url && typeof url === 'string') {
      const uuid = extractCurriculumUuid(url);
      if (!uuid) {
        return NextResponse.json({ error: '无效的学习通链接' }, { status: 400 });
      }
      
      curriculumUuid = uuid; // 保存 uuid 供返回
      courses = await fetchChaoxingSchedule(uuid);
      source = 'chaoxing';
      console.log(`[Schedule API] 从学习通获取 ${courses.length} 条课程, uuid=${uuid}`);
    }
    // 方式2: OCR图片识别（调用后端）
    else if (imageUrl && typeof imageUrl === 'string') {
      const isDev = process.env.NODE_ENV !== 'production';
      const backendUrl = isDev
        ? 'http://127.0.0.1:7071/api/ocrCourse'
        : (process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL?.replace('/schoolBot', '/ocrCourse') || 
           'https://school-bot-gwb4a9gkdwcyhde5.koreacentral-01.azurewebsites.net/api/ocrCourse');

      const ocrResponse = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl }),
      });

      const ocrData = await ocrResponse.json();
      
      if (!ocrResponse.ok || !ocrData.schedule) {
        throw new Error(ocrData.error || 'OCR解析失败');
      }

      courses = ocrData.schedule;
      source = 'ocr';
      console.log(`[Schedule API] OCR解析 ${courses.length} 条课程, 置信度: ${ocrData.confidence}`);
    }
    // 方式3: 手动输入 (支持 manualSchedule 或 schedule 字段名)
    else if (inputSchedule && Array.isArray(inputSchedule)) {
      courses = inputSchedule;
      source = 'manual';
      console.log(`[Schedule API] 手动输入 ${courses.length} 条课程`);
    }
    else {
      return NextResponse.json({ error: '请提供 url, imageUrl 或 manualSchedule' }, { status: 400 });
    }

    // 返回解析结果
    return NextResponse.json({
      success: true,
      source,
      count: courses.length,
      schedule: courses,
      curriculumUuid, // 🆕 供前端保存用于跨周动态查询
    });

  } catch (error: unknown) {
    console.error('[Schedule API] Error:', error);
    const errorMessage = error instanceof Error ? error.message : '课表导入失败';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * GET /api/schedule - 获取当前课表（从localStorage读取后由前端传入）
 */
export async function GET() {
  return NextResponse.json({
    message: '课表数据存储在客户端localStorage中，请使用POST导入新课表',
  });
}
