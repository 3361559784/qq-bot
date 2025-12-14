import { NextResponse } from 'next/server';

// 严乐的真实课表数据 - 27门课程
const DEMO_SCHEDULE = [
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 1, startTime: "08:00", endTime: "09:40", weeks: "7-16周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 1, startTime: "10:00", endTime: "11:40", weeks: "7-8周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A308", weekday: 1, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "形势与政策", instructor: "余胜任", location: "E03-A415", weekday: 1, startTime: "15:55", endTime: "17:30", weeks: "8-11周" },
  { courseName: "劳动教育", instructor: "严碧云", location: "E02-203", weekday: 1, startTime: "19:00", endTime: "20:40", weeks: "11-14周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 2, startTime: "08:00", endTime: "09:40", weeks: "7-13周" },
  { courseName: "军事理论", instructor: "高玮", location: "线上教学", weekday: 2, startTime: "10:00", endTime: "11:40", weeks: "8-13周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 2, startTime: "10:00", endTime: "11:40", weeks: "8-14周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A412", weekday: 2, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 3, startTime: "08:00", endTime: "09:40", weeks: "7周,9周,11周,13周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 3, startTime: "10:00", endTime: "11:40", weeks: "7-8周" },
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 3, startTime: "14:00", endTime: "15:40", weeks: "7周,10-15周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 3, startTime: "15:55", endTime: "17:30", weeks: "7-16周" },
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 4, startTime: "10:00", endTime: "11:40", weeks: "7周,10-15周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 4, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-17周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 4, startTime: "15:55", endTime: "17:30", weeks: "6-17周" },
  { courseName: "中华优秀传统文化", instructor: "李洁", location: "线上教学", weekday: 4, startTime: "19:00", endTime: "20:40", weeks: "6-14周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 5, startTime: "08:00", endTime: "09:40", weeks: "6-17周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 5, startTime: "10:00", endTime: "11:40", weeks: "6-7周,9-14周" },
  { courseName: "大学生心理健康教育", instructor: "刘华", location: "E02-605", weekday: 5, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-14周" },
  { courseName: "职业生涯规划与就业指导（一）", instructor: "严碧云", location: "E03-A308", weekday: 5, startTime: "19:00", endTime: "20:40", weeks: "6-7周,9-14周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A108", weekday: 6, startTime: "08:00", endTime: "09:40", weeks: "7-9周,10-17周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A514", weekday: 6, startTime: "10:00", endTime: "11:40", weeks: "7-18周" },
  { courseName: "劳动教育", instructor: "严碧云", location: "E02-203", weekday: 6, startTime: "14:00", endTime: "15:40", weeks: "7-10周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "线上教学", weekday: 6, startTime: "14:00", endTime: "15:40", weeks: "7-8周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 6, startTime: "15:55", endTime: "17:30", weeks: "8周,10周,12周,14周" },
  { courseName: "工程训练（一）", instructor: "钱程", location: "E01-104", weekday: 6, startTime: "19:00", endTime: "20:40", weeks: "6-12周" },
];

// 生成 Excel 文件（使用CSV格式，可被Excel打开）
function generateExcelCSV(): string {
  const header = '课程名称,教师,地点,星期,开始时间,结束时间,周次\n';
  const weekdayMap: Record<number, string> = {1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日'};
  
  const rows = DEMO_SCHEDULE.map(c => 
    `"${c.courseName}","${c.instructor}","${c.location}","${weekdayMap[c.weekday]}","${c.startTime}","${c.endTime}","${c.weeks}"`
  ).join('\n');
  
  return header + rows;
}

// 生成 ICS 文件
function generateICS(): string {
  const weekdayToDay: Record<number, string> = {1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA', 7: 'SU'};
  
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Campus Copilot//Demo Schedule//CN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:严乐课表 - Campus Copilot Demo
X-WR-TIMEZONE:Asia/Shanghai
`;

  // 获取本学期第一周的周一日期（假设2025-03-03是第6周周一）
  const weekOneMonday = new Date('2025-02-17'); // 第1周周一
  
  DEMO_SCHEDULE.forEach((course, index) => {
    // 解析周次
    const weeksStr = course.weeks;
    let startWeek = 7, endWeek = 18;
    const rangeMatch = weeksStr.match(/(\d+)-(\d+)周/);
    if (rangeMatch) {
      startWeek = parseInt(rangeMatch[1]);
      endWeek = parseInt(rangeMatch[2]);
    }
    
    // 计算第一次上课日期
    const firstClassDate = new Date(weekOneMonday);
    firstClassDate.setDate(firstClassDate.getDate() + (startWeek - 1) * 7 + (course.weekday - 1));
    
    const dateStr = firstClassDate.toISOString().slice(0, 10).replace(/-/g, '');
    const startTimeStr = course.startTime.replace(':', '') + '00';
    const endTimeStr = course.endTime.replace(':', '') + '00';
    
    ics += `BEGIN:VEVENT
UID:demo-${index + 1}@campuscopilot.com
DTSTART;TZID=Asia/Shanghai:${dateStr}T${startTimeStr}
DTEND;TZID=Asia/Shanghai:${dateStr}T${endTimeStr}
RRULE:FREQ=WEEKLY;BYDAY=${weekdayToDay[course.weekday]};COUNT=${endWeek - startWeek + 1}
SUMMARY:${course.courseName}
LOCATION:${course.location}
DESCRIPTION:教师: ${course.instructor}\\n周次: ${course.weeks}
END:VEVENT
`;
  });

  ics += 'END:VCALENDAR';
  return ics;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  
  if (pathname.endsWith('.xlsx') || pathname.endsWith('.csv')) {
    // 返回 CSV 格式（Excel 可打开）
    const csv = generateExcelCSV();
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="yanle-schedule.csv"',
      },
    });
  } else if (pathname.endsWith('.ics')) {
    // 返回 ICS 格式
    const ics = generateICS();
    return new NextResponse(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="yanle-schedule.ics"',
      },
    });
  } else {
    // 返回 JSON
    return NextResponse.json({
      message: 'Campus Copilot Demo Schedule API',
      files: [
        '/api/demo/schedule.xlsx - Excel/CSV格式课表',
        '/api/demo/schedule.ics - ICS日历格式课表',
      ],
      courseCount: DEMO_SCHEDULE.length,
      schedule: DEMO_SCHEDULE,
    });
  }
}
