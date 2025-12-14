/**
 * 课表导入功能完整测试
 * 基于严乐同学 2025-2026-1 学期真实课表
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ========== 严乐的真实课表数据 ==========
const YANLE_SCHEDULE = [
  // 周一
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 1, startTime: "08:00", endTime: "09:40", weeks: "7-16周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 1, startTime: "10:00", endTime: "11:40", weeks: "7-8周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A308", weekday: 1, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "形势与政策", instructor: "余胜任", location: "E03-A415", weekday: 1, startTime: "15:55", endTime: "17:30", weeks: "8-11周" },
  { courseName: "劳动教育", instructor: "严碧云", location: "E02-203", weekday: 1, startTime: "19:00", endTime: "20:40", weeks: "11-14周" },
  
  // 周二
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 2, startTime: "08:00", endTime: "09:40", weeks: "7-13周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 2, startTime: "10:00", endTime: "11:40", weeks: "8-14周(双)" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A412", weekday: 2, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A106", weekday: 2, startTime: "15:55", endTime: "17:30", weeks: "12周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-103", weekday: 2, startTime: "19:00", endTime: "20:40", weeks: "14周" },
  
  // 周三
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "GS-S504", weekday: 3, startTime: "08:00", endTime: "09:40", weeks: "14周" },
  { courseName: "高等数学（一）", instructor: "张舒", location: "E03-A514", weekday: 3, startTime: "10:00", endTime: "11:40", weeks: "6周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "校内实训", weekday: 3, startTime: "14:00", endTime: "17:30", weeks: "12周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 3, startTime: "15:55", endTime: "17:30", weeks: "7-16周" },
  
  // 周四
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 4, startTime: "08:00", endTime: "09:40", weeks: "15周" },
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 4, startTime: "10:00", endTime: "11:40", weeks: "7周,10-15周" },
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 4, startTime: "10:00", endTime: "11:40", weeks: "9-15周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 4, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-17周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 4, startTime: "15:55", endTime: "17:30", weeks: "6-17周" },
  
  // 周五
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 5, startTime: "08:00", endTime: "09:40", weeks: "6-17周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 5, startTime: "10:00", endTime: "11:40", weeks: "6-7周,9-14周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A102", weekday: 5, startTime: "10:00", endTime: "11:40", weeks: "9周" },
  { courseName: "大学生心理健康教育", instructor: "刘华", location: "E02-605", weekday: 5, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-14周" },
  
  // 周六
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A108", weekday: 6, startTime: "08:00", endTime: "09:40", weeks: "7-9周(单),10-17周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A514", weekday: 6, startTime: "10:00", endTime: "11:40", weeks: "7-18周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 6, startTime: "10:00", endTime: "11:40", weeks: "9周" },
  
  // 周日
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 7, startTime: "08:00", endTime: "09:40", weeks: "6-7周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "校内实训", weekday: 7, startTime: "08:00", endTime: "09:40", weeks: "9周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A308", weekday: 7, startTime: "08:00", endTime: "09:40", weeks: "10-16周" },
];

// 去重（合并同一门课在同一时段的不同周次）
function deduplicateSchedule(schedule) {
  const seen = new Map();
  for (const course of schedule) {
    const key = `${course.courseName}_${course.weekday}_${course.startTime}`;
    if (!seen.has(key)) {
      seen.set(key, course);
    }
  }
  return Array.from(seen.values());
}

const UNIQUE_SCHEDULE = deduplicateSchedule(YANLE_SCHEDULE);

// ========== 1. 生成 Excel 文件 ==========
function generateExcel() {
  console.log('\n📊 生成 Excel 测试文件...');
  
  const headers = ['课程名称', '星期', '开始时间', '结束时间', '教室', '教师', '周次'];
  const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  
  const rows = [headers];
  for (const course of UNIQUE_SCHEDULE) {
    rows.push([
      course.courseName,
      weekdayNames[course.weekday],
      course.startTime,
      course.endTime,
      course.location,
      course.instructor,
      course.weeks || ''
    ]);
  }
  
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, '课表');
  
  const outputPath = path.join(__dirname, 'yanle-schedule.xlsx');
  XLSX.writeFile(workbook, outputPath);
  console.log(`   ✅ 已生成: ${outputPath}`);
  console.log(`   📝 共 ${rows.length - 1} 条课程记录`);
  
  return outputPath;
}

// ========== 2. 生成 ICS 文件 ==========
function generateICS() {
  console.log('\n📅 生成 ICS 测试文件...');
  
  // 2025年9月1日是周一（开学第一周）
  const firstWeekMonday = new Date(2025, 8, 1); // 月份从0开始
  const weekdayNames = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  
  let icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Campus AI//Schedule Import Test//CN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:严乐课表
X-WR-TIMEZONE:Asia/Shanghai
`;

  let eventId = 1;
  for (const course of UNIQUE_SCHEDULE) {
    // 计算第一次上课的日期（假设从第7周开始）
    const firstWeek = 7;
    const daysToAdd = (firstWeek - 1) * 7 + (course.weekday - 1);
    const courseDate = new Date(firstWeekMonday);
    courseDate.setDate(courseDate.getDate() + daysToAdd);
    
    const [startH, startM] = course.startTime.split(':');
    const [endH, endM] = course.endTime.split(':');
    
    const dtStart = `${courseDate.getFullYear()}${String(courseDate.getMonth() + 1).padStart(2, '0')}${String(courseDate.getDate()).padStart(2, '0')}T${startH}${startM}00`;
    const dtEnd = `${courseDate.getFullYear()}${String(courseDate.getMonth() + 1).padStart(2, '0')}${String(courseDate.getDate()).padStart(2, '0')}T${endH}${endM}00`;
    
    icsContent += `BEGIN:VEVENT
UID:course-${eventId}@campus-ai
DTSTAMP:20251215T000000Z
DTSTART;TZID=Asia/Shanghai:${dtStart}
DTEND;TZID=Asia/Shanghai:${dtEnd}
SUMMARY:${course.courseName}
LOCATION:${course.location || ''}
DESCRIPTION:教师：${course.instructor || '未知'}\\n周次：${course.weeks || ''}
RRULE:FREQ=WEEKLY;BYDAY=${weekdayNames[course.weekday]};COUNT=10
END:VEVENT
`;
    eventId++;
  }
  
  icsContent += 'END:VCALENDAR';
  
  const outputPath = path.join(__dirname, 'yanle-schedule.ics');
  fs.writeFileSync(outputPath, icsContent);
  console.log(`   ✅ 已生成: ${outputPath}`);
  console.log(`   📝 共 ${eventId - 1} 个日历事件`);
  
  return outputPath;
}

// ========== 3. 测试 Excel 上传 API ==========
async function testExcelUpload(excelPath) {
  console.log('\n🧪 测试 Excel 上传 API...');
  
  const FormData = (await import('form-data')).default;
  const fetch = (await import('node-fetch')).default;
  
  const form = new FormData();
  form.append('file', fs.createReadStream(excelPath), {
    filename: 'yanle-schedule.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  
  try {
    const response = await fetch('http://localhost:3000/api/schedule/upload', {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`   ✅ Excel 上传成功！解析到 ${data.count} 条课程`);
      console.log(`   📊 来源: ${data.source}`);
      // 打印前3条
      console.log('   📝 前3条课程:');
      data.schedule.slice(0, 3).forEach((c, i) => {
        console.log(`      ${i + 1}. ${c.courseName} - 周${c.weekday} ${c.startTime}-${c.endTime} @ ${c.location}`);
      });
      return { success: true, data };
    } else {
      console.log(`   ❌ Excel 上传失败: ${data.error}`);
      return { success: false, error: data.error };
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ========== 4. 测试 ICS 上传 API ==========
async function testICSUpload(icsPath) {
  console.log('\n🧪 测试 ICS 上传 API...');
  
  const FormData = (await import('form-data')).default;
  const fetch = (await import('node-fetch')).default;
  
  const form = new FormData();
  form.append('file', fs.createReadStream(icsPath), {
    filename: 'yanle-schedule.ics',
    contentType: 'text/calendar'
  });
  
  try {
    const response = await fetch('http://localhost:3000/api/schedule/upload', {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`   ✅ ICS 上传成功！解析到 ${data.count} 条课程`);
      console.log(`   📅 来源: ${data.source}`);
      // 打印前3条
      console.log('   📝 前3条课程:');
      data.schedule.slice(0, 3).forEach((c, i) => {
        console.log(`      ${i + 1}. ${c.courseName} - 周${c.weekday} ${c.startTime}-${c.endTime} @ ${c.location}`);
      });
      return { success: true, data };
    } else {
      console.log(`   ❌ ICS 上传失败: ${data.error}`);
      return { success: false, error: data.error };
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ========== 5. 测试手动输入 API ==========
async function testManualInput() {
  console.log('\n🧪 测试手动输入 API...');
  
  const fetch = (await import('node-fetch')).default;
  
  const manualSchedule = [
    { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A514", weekday: 6, startTime: "10:00", endTime: "11:40" },
    { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 1, startTime: "08:00", endTime: "09:40" },
    { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 5, startTime: "08:00", endTime: "09:40" },
  ];
  
  try {
    const response = await fetch('http://localhost:3000/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualSchedule })
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`   ✅ 手动输入成功！保存了 ${data.schedule?.length || manualSchedule.length} 条课程`);
      return { success: true, data };
    } else {
      console.log(`   ❌ 手动输入失败: ${data.error}`);
      return { success: false, error: data.error };
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ========== 6. 测试 QQ Bot 课表查询 ==========
async function testQQBotQuery() {
  console.log('\n🧪 测试 QQ Bot 课表查询...');
  
  const fetch = (await import('node-fetch')).default;
  
  const queries = [
    "今天有什么课",
    "明天有什么课",
    "下一节课是什么",
    "周六有什么课",
    "高等数学什么时候上"
  ];
  
  const results = [];
  
  for (const query of queries) {
    try {
      const response = await fetch('http://localhost:7071/api/schoolBot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_type: "message",
          message_type: "private",
          user_id: "yanle_test_user",
          raw_message: query,
          message: query,
          sender: { nickname: "严乐" }
        })
      });
      
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { reply: text };
      }
      
      const reply = data.reply || data.message || text.substring(0, 200);
      console.log(`   📝 "${query}"`);
      console.log(`      → ${reply.substring(0, 150)}${reply.length > 150 ? '...' : ''}`);
      results.push({ query, success: true, reply });
    } catch (err) {
      console.log(`   ❌ "${query}" 失败: ${err.message}`);
      results.push({ query, success: false, error: err.message });
    }
  }
  
  return results;
}

// ========== 主测试流程 ==========
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║     🎓 严乐课表导入功能完整测试 - Microsoft Imagine Cup 2026   ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\n📅 测试时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`📚 课表数据: 2025-2026学年第1学期 严乐同学`);
  console.log(`📊 共 ${UNIQUE_SCHEDULE.length} 条去重后的课程记录\n`);
  
  const results = {
    excel: null,
    ics: null,
    manual: null,
    qqBot: null
  };
  
  // Step 1: 生成测试文件
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📁 Step 1: 生成测试文件');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const excelPath = generateExcel();
  const icsPath = generateICS();
  
  // Step 2: 测试 API
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔌 Step 2: 测试 API 端点');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  results.excel = await testExcelUpload(excelPath);
  results.ics = await testICSUpload(icsPath);
  results.manual = await testManualInput();
  
  // Step 3: 测试 QQ Bot
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 Step 3: 测试 QQ Bot 课表查询');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  results.qqBot = await testQQBotQuery();
  
  // 汇总
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                        📊 测试结果汇总                         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  
  const passed = [];
  const failed = [];
  
  if (results.excel?.success) passed.push('Excel 上传'); else failed.push('Excel 上传');
  if (results.ics?.success) passed.push('ICS 上传'); else failed.push('ICS 上传');
  if (results.manual?.success) passed.push('手动输入'); else failed.push('手动输入');
  
  const qqBotPassed = results.qqBot?.filter(r => r.success).length || 0;
  const qqBotTotal = results.qqBot?.length || 0;
  
  console.log(`\n   ✅ 通过: ${passed.length} / 3`);
  passed.forEach(p => console.log(`      • ${p}`));
  
  if (failed.length > 0) {
    console.log(`\n   ❌ 失败: ${failed.length} / 3`);
    failed.forEach(f => console.log(`      • ${f}`));
  }
  
  console.log(`\n   🤖 QQ Bot 查询: ${qqBotPassed} / ${qqBotTotal} 成功`);
  
  const allPassed = passed.length === 3 && qqBotPassed === qqBotTotal;
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (allPassed) {
    console.log('🎉 所有测试通过！准备好参加 Microsoft Imagine Cup 2026 了！💪');
  } else {
    console.log('⚠️  部分测试未通过，请检查服务是否正常运行。');
    console.log('   提示: 确保 Next.js (端口3000) 和 Azure Functions (端口7071) 都已启动');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  // 保存结果
  const resultPath = path.join(__dirname, 'test-results.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    schedule: UNIQUE_SCHEDULE,
    results
  }, null, 2));
  console.log(`\n📄 详细结果已保存到: ${resultPath}`);
}

main().catch(console.error);
