// 测试星期解析
const WEEKDAY_MAP = {
  '周一': 1, '星期一': 1, 'monday': 1, 'mon': 1,
  '周二': 2, '星期二': 2, 'tuesday': 2, 'tue': 2,
  '周三': 3, '星期三': 3, 'wednesday': 3, 'wed': 3,
  '周四': 4, '星期四': 4, 'thursday': 4, 'thu': 4,
  '周五': 5, '星期五': 5, 'friday': 5, 'fri': 5,
  '周六': 6, '星期六': 6, 'saturday': 6, 'sat': 6,
  '周日': 7, '星期日': 7, '星期天': 7, 'sunday': 7, 'sun': 7,
};

function parseWeekday(dayStr) {
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

console.log('测试解析:');
['周一', '周二', '周三', '周四', '周五', '周六', '周日'].forEach(s => {
  console.log(`  '${s}' => ${parseWeekday(s)}`);
});

// 测试实际Excel数据
const XLSX = require('xlsx');
const workbook = XLSX.readFile('./tests/yanle-schedule.xlsx');
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

console.log('\nExcel 第二列（星期）解析:');
rows.slice(1, 8).forEach((row, i) => {
  const weekdayStr = row[1];
  console.log(`  第${i+2}行: '${weekdayStr}' => ${parseWeekday(weekdayStr)}`);
});
