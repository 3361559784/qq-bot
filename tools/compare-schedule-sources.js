/**
 * 对比课表数据源：PDF vs 学习通API
 * 用于验证 OCR/PDF 解析 与 学习通爬虫 的一致性
 */

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

// 学习通 API 配置
const CHAOXING_UUID = '9a44e583-2c48-443c-bc72-d32a2f1ba101';
const CHAOXING_API_BASE = 'https://kb.chaoxing.com/res/apis/curriculum';

// ========== 1. 从 PDF 解析课表 ==========
async function parseScheduleFromPDF(pdfPath) {
  console.log('\n📄 解析 PDF 课表...');
  const dataBuffer = fs.readFileSync(pdfPath);
  const uint8Array = new Uint8Array(dataBuffer);
  const parser = new PDFParse(uint8Array);
  const data = await parser.getText();
  
  console.log(`   原始文本长度: ${data.text.length} 字符`);
  
  // 解析课表文本
  const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);
  const courses = [];
  
  // 常见的时间段正则
  const timeRegex = /(\d{1,2}:\d{2})\s*[-–—~]\s*(\d{1,2}:\d{2})/;
  const weekdayMap = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 7,
                       '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6, '星期日': 7 };
  
  let currentWeekday = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 检测星期
    for (const [key, val] of Object.entries(weekdayMap)) {
      if (line.includes(key)) {
        currentWeekday = val;
        break;
      }
    }
    
    // 检测时间段
    const timeMatch = line.match(timeRegex);
    if (timeMatch && currentWeekday) {
      // 尝试从同行或下一行提取课程名
      let courseName = line.replace(timeRegex, '').trim();
      if (!courseName && i + 1 < lines.length) {
        courseName = lines[i + 1].trim();
      }
      
      // 清理课程名
      courseName = courseName.replace(/^[\s\d:.-]+/, '').trim();
      
      if (courseName && courseName.length > 1) {
        courses.push({
          weekday: currentWeekday,
          startTime: timeMatch[1],
          endTime: timeMatch[2],
          courseName: courseName,
          source: 'pdf'
        });
      }
    }
  }
  
  // 如果上面没解析到，尝试表格式解析
  if (courses.length === 0) {
    console.log('   尝试表格式解析...');
    // 打印原始文本供调试
    console.log('\n   === PDF 原始文本 (前2000字符) ===');
    console.log(data.text.substring(0, 2000));
    console.log('   === END ===\n');
  }
  
  console.log(`   ✅ 从 PDF 解析到 ${courses.length} 条课程`);
  return { courses, rawText: data.text };
}

// ========== 2. 从学习通 API 获取课表 ==========
async function fetchScheduleFromChaoxing(uuid) {
  console.log('\n🌐 从学习通 API 获取课表...');
  
  const url = `${CHAOXING_API_BASE}/getAllLessons?curriculumUuid=${uuid}`;
  console.log(`   请求: ${url}`);
  
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    
    const json = await res.json();
    
    if (!json.data || !Array.isArray(json.data)) {
      console.log('   ⚠️ API 返回数据格式异常');
      console.log('   响应:', JSON.stringify(json).substring(0, 500));
      return { courses: [], raw: json };
    }
    
    const courses = json.data.map(item => ({
      weekday: Number(item.dayOfWeek) || 0,
      startTime: item.beginTime || '',
      endTime: item.endTime || '',
      courseName: item.name || item.lessonName || '',
      location: item.address || item.location || '',
      weeks: item.weeksDesc || '',
      teacher: item.teacherName || '',
      source: 'chaoxing'
    }));
    
    console.log(`   ✅ 从学习通获取到 ${courses.length} 条课程`);
    return { courses, raw: json };
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`);
    return { courses: [], error: err.message };
  }
}

// ========== 3. 对比课表 ==========
function compareSchedules(pdfCourses, chaoxingCourses, excludeKeywords = ['体育']) {
  console.log('\n📊 对比课表...');
  console.log(`   PDF 课程数: ${pdfCourses.length}`);
  console.log(`   学习通课程数: ${chaoxingCourses.length}`);
  
  // 过滤体育课
  const filterCourse = (c) => !excludeKeywords.some(k => c.courseName.includes(k));
  const pdfFiltered = pdfCourses.filter(filterCourse);
  const chaoxingFiltered = chaoxingCourses.filter(filterCourse);
  
  console.log(`   排除"${excludeKeywords.join('/')}"后: PDF=${pdfFiltered.length}, 学习通=${chaoxingFiltered.length}`);
  
  // 构建课程名集合
  const pdfNames = new Set(pdfFiltered.map(c => c.courseName.replace(/\s+/g, '')));
  const chaoxingNames = new Set(chaoxingFiltered.map(c => c.courseName.replace(/\s+/g, '')));
  
  // 找出差异
  const onlyInPDF = [...pdfNames].filter(n => !chaoxingNames.has(n));
  const onlyInChaoxing = [...chaoxingNames].filter(n => !pdfNames.has(n));
  const common = [...pdfNames].filter(n => chaoxingNames.has(n));
  
  console.log('\n   === 课程对比结果 ===');
  console.log(`   ✅ 共同课程 (${common.length}):`, common.join(', '));
  console.log(`   📄 仅在 PDF 中 (${onlyInPDF.length}):`, onlyInPDF.join(', ') || '无');
  console.log(`   🌐 仅在学习通中 (${onlyInChaoxing.length}):`, onlyInChaoxing.join(', ') || '无');
  
  // 详细时间对比
  console.log('\n   === 详细时间对比 ===');
  for (const name of common) {
    const pdfC = pdfFiltered.find(c => c.courseName.replace(/\s+/g, '') === name);
    const cxC = chaoxingFiltered.find(c => c.courseName.replace(/\s+/g, '') === name);
    const match = pdfC.weekday === cxC.weekday && pdfC.startTime === cxC.startTime;
    console.log(`   ${match ? '✅' : '❌'} ${name}: PDF(周${pdfC.weekday} ${pdfC.startTime}) vs 学习通(周${cxC.weekday} ${cxC.startTime})`);
  }
  
  return {
    common,
    onlyInPDF,
    onlyInChaoxing,
    pdfFiltered,
    chaoxingFiltered
  };
}

// ========== 主流程 ==========
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         📚 课表数据源对比工具 - PDF vs 学习通 API             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  
  const pdfPath = path.join(__dirname, '..', '严乐(2025-2026-1)课表.pdf');
  
  // 1. 解析 PDF
  const pdfResult = await parseScheduleFromPDF(pdfPath);
  
  // 2. 获取学习通数据
  const chaoxingResult = await fetchScheduleFromChaoxing(CHAOXING_UUID);
  
  // 3. 对比
  if (pdfResult.courses.length > 0 && chaoxingResult.courses.length > 0) {
    compareSchedules(pdfResult.courses, chaoxingResult.courses);
  } else {
    console.log('\n⚠️ 数据不足，无法对比');
    
    if (pdfResult.courses.length === 0) {
      console.log('\n📄 PDF 解析失败，原始文本:');
      console.log(pdfResult.rawText);
    }
    
    if (chaoxingResult.courses.length === 0) {
      console.log('\n🌐 学习通数据为空');
    }
  }
  
  // 保存详细结果
  const resultPath = path.join(__dirname, 'compare-result.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    pdf: pdfResult,
    chaoxing: chaoxingResult
  }, null, 2));
  console.log(`\n📄 详细结果已保存到: ${resultPath}`);
}

main().catch(console.error);
