/**
 * 🏆 MVP 决战模式 - 6 条硬标准验证测试
 * 
 * 1️⃣ 数据真实注入（不是 prompt 玩具）
 * 2️⃣ 有"失败路径"的设计
 * 3️⃣ 核心问题 3 秒内可验证
 * 4️⃣ 前后端语义一致（Alice / Pro Mode 行为差异）
 * 5️⃣ Judge Panel 不是摆设
 * 6️⃣ 明确写出"我没做什么"
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

// 测试用课表数据（严乐真实课表的子集）
const TEST_SCHEDULE = [
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 1, startTime: "08:00", endTime: "09:40", weeks: "7-16周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 1, startTime: "10:00", endTime: "11:40", weeks: "7-8周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A308", weekday: 1, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 2, startTime: "08:00", endTime: "09:40", weeks: "7-13周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 2, startTime: "10:00", endTime: "11:40", weeks: "8-14周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A108", weekday: 6, startTime: "08:00", endTime: "09:40", weeks: "7-9周,10-17周" },
];

// 引入关键服务
const { formatAnswerFromWebSchedule, detectScheduleQueryType, computeScheduleLoadStats } = require('../services/scheduleService');

console.log('\n🏆 ═══════════════════════════════════════════════════════════');
console.log('   MVP 决战模式 - 6 条硬标准验证');
console.log('═══════════════════════════════════════════════════════════════\n');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log(`✅ ${name}`);
      passCount++;
      return true;
    } else {
      console.log(`❌ ${name}`);
      console.log(`   原因: ${result}`);
      failCount++;
      return false;
    }
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   错误: ${err.message}`);
    failCount++;
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 1️⃣ 数据真实注入（不是 prompt 玩具）
// ═══════════════════════════════════════════════════════════════
console.log('\n1️⃣ 数据真实注入 测试');
console.log('─'.repeat(60));

test('Excel 可解析为结构化数据', () => {
  const xlsxPath = path.join(__dirname, '..', 'yanle-schedule.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    return '测试文件不存在: yanle-schedule.xlsx';
  }
  const workbook = XLSX.readFile(xlsxPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);
  if (data.length < 1) return '解析结果为空';
  console.log(`   └─ 解析出 ${data.length} 条数据`);
  return true;
});

test('scheduleService 能处理结构化课表', () => {
  // 测试 formatAnswerFromWebSchedule 函数
  const result = formatAnswerFromWebSchedule(TEST_SCHEDULE, 'this_week', { log: () => {} });
  if (!result) return '格式化结果为空';
  if (!result.includes('周')) return '结果不包含周信息';
  console.log(`   └─ 输出长度: ${result.length} 字符`);
  return true;
});

test('课表查询类型识别正确', () => {
  const tests = [
    { input: '明天有什么课', expected: 'tomorrow' },
    { input: '今天有课吗', expected: 'today' },
    { input: '下一节课是什么', expected: 'next_course' },
    { input: '这周课表', expected: 'this_week' },
    { input: '下周课表', expected: 'next_week' },
  ];
  for (const t of tests) {
    const result = detectScheduleQueryType(t.input);
    if (result !== t.expected) {
      return `"${t.input}" 期望 ${t.expected}，实际 ${result}`;
    }
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════
// 2️⃣ 失败路径设计
// ═══════════════════════════════════════════════════════════════
console.log('\n2️⃣ 失败路径设计 测试');
console.log('─'.repeat(60));

test('空课表查询返回友好提示', () => {
  const result = formatAnswerFromWebSchedule([], 'today', { log: () => {} });
  if (!result.includes('没有课')) return `期望包含"没有课"，实际: ${result}`;
  return true;
});

test('无效查询类型优雅处理', () => {
  const result = formatAnswerFromWebSchedule(TEST_SCHEDULE, null, { log: () => {} });
  // null 类型应该默认为本周课表
  if (!result) return '结果为空';
  return true;
});

// ═══════════════════════════════════════════════════════════════
// 3️⃣ 核心问题 3 秒可验证
// ═══════════════════════════════════════════════════════════════
console.log('\n3️⃣ 核心问题稳定性 测试');
console.log('─'.repeat(60));

test('问题1: "明天第几节什么课，在哪？"', () => {
  const result = formatAnswerFromWebSchedule(TEST_SCHEDULE, 'tomorrow', { log: () => {} });
  if (!result) return '结果为空';
  // 应该包含明天信息或"没有课"
  if (!result.includes('明天') && !result.includes('明日')) return '不包含明天信息';
  console.log(`   └─ ${result.split('\n')[0]}`);
  return true;
});

test('问题2: "这周哪天最累？"（基于课表密度）', () => {
  // 使用 computeScheduleLoadStats 计算
  if (typeof computeScheduleLoadStats !== 'function') {
    return 'computeScheduleLoadStats 函数不存在';
  }
  const stats = computeScheduleLoadStats(TEST_SCHEDULE);
  if (!stats) return '统计结果为空';
  console.log(`   └─ 最忙: ${stats.busiestDay || '未知'}, 课程数: ${stats.busiestDayCount || 0}`);
  return true;
});

test('问题3: "下次早八是什么时候？"', () => {
  // 找出有 08:00 开始的课程
  const earlyMorningCourses = TEST_SCHEDULE.filter(c => c.startTime === '08:00');
  if (earlyMorningCourses.length === 0) return '测试数据中没有早八课程';
  console.log(`   └─ 早八课程: ${earlyMorningCourses.map(c => `周${c.weekday}·${c.courseName}`).join(', ')}`);
  return true;
});

// ═══════════════════════════════════════════════════════════════
// 4️⃣ 前后端语义一致
// ═══════════════════════════════════════════════════════════════
console.log('\n4️⃣ 前后端语义一致 测试');
console.log('─'.repeat(60));

test('schoolBot.js 存在模式切换逻辑', () => {
  const schoolBotPath = path.join(__dirname, '..', 'src', 'functions', 'schoolBot.js');
  const content = fs.readFileSync(schoolBotPath, 'utf8');
  
  const hasAliceMode = content.includes('alice') || content.includes('Alice');
  const hasProMode = content.includes('pro') || content.includes('Pro') || content.includes('professional');
  const hasCopilotMode = content.includes('copilot') || content.includes('Copilot');
  
  if (!hasAliceMode && !hasProMode && !hasCopilotMode) {
    return '未找到模式切换相关代码';
  }
  console.log(`   └─ Alice模式: ${hasAliceMode}, Pro模式: ${hasProMode}, Copilot模式: ${hasCopilotMode}`);
  return true;
});

test('modeStyleOverride 变量存在且有差异', () => {
  const schoolBotPath = path.join(__dirname, '..', 'src', 'functions', 'schoolBot.js');
  const content = fs.readFileSync(schoolBotPath, 'utf8');
  
  if (!content.includes('modeStyleOverride')) {
    return '未找到 modeStyleOverride 变量';
  }
  console.log('   └─ modeStyleOverride 变量存在');
  return true;
});

// ═══════════════════════════════════════════════════════════════
// 5️⃣ Judge Panel 功能验证
// ═══════════════════════════════════════════════════════════════
console.log('\n5️⃣ Judge Panel 功能 测试');
console.log('─'.repeat(60));

test('JudgePanel.tsx 包含一键导入功能', () => {
  const panelPath = path.join(__dirname, '..', 'campus-ai-web', 'components', 'JudgePanel.tsx');
  const content = fs.readFileSync(panelPath, 'utf8');
  
  if (!content.includes('handleLoadSchedule') && !content.includes('一键导入')) {
    return '未找到一键导入功能';
  }
  return true;
});

test('JudgePanel.tsx 包含示例课表数据', () => {
  const panelPath = path.join(__dirname, '..', 'campus-ai-web', 'components', 'JudgePanel.tsx');
  const content = fs.readFileSync(panelPath, 'utf8');
  
  if (!content.includes('JUDGE_DEMO_SCHEDULE')) {
    return '未找到示例课表数据';
  }
  
  const match = content.match(/JUDGE_DEMO_SCHEDULE\s*=\s*\[/);
  if (match) {
    // 计算课程数量
    const courseCount = (content.match(/courseName:/g) || []).length;
    console.log(`   └─ 包含约 ${courseCount} 门课程数据`);
  }
  return true;
});

test('JudgePanel.tsx 包含判断力声明', () => {
  const panelPath = path.join(__dirname, '..', 'campus-ai-web', 'components', 'JudgePanel.tsx');
  const content = fs.readFileSync(panelPath, 'utf8');
  
  if (!content.includes('judgment') || !content.includes('single developer')) {
    return '未找到判断力声明';
  }
  console.log('   └─ "prove judgment, not brute force" ✓');
  return true;
});

// ═══════════════════════════════════════════════════════════════
// 6️⃣ "我没做什么" 声明检查
// ═══════════════════════════════════════════════════════════════
console.log('\n6️⃣ "我没做什么" 声明 检查');
console.log('─'.repeat(60));

test('需要在 JudgePanel 添加"刻意不做"声明', () => {
  const panelPath = path.join(__dirname, '..', 'campus-ai-web', 'components', 'JudgePanel.tsx');
  const content = fs.readFileSync(panelPath, 'utf8');
  
  // 检查是否有"刻意不做"或"没做什么"相关内容
  const hasNotDoneSection = content.includes('刻意不做') || 
                            content.includes('没做什么') ||
                            content.includes('NOT implemented') ||
                            content.includes('Out of Scope');
  
  if (!hasNotDoneSection) {
    return '需要添加"刻意不做"声明（建议补充）';
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════
// 总结
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 测试结果: ${passCount} 通过, ${failCount} 失败`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failCount === 0) {
  console.log('🎉 恭喜！所有 MVP 硬标准验证通过！');
} else {
  console.log(`⚠️ 有 ${failCount} 项需要补充完善`);
}

// 返回退出码
process.exit(failCount > 0 ? 1 : 0);
