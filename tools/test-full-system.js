/**
 * 🧪 完整系统测试脚本
 * 测试 Chaoxing 课表导入的所有路径: A(API) → B(Scraper) → C(OCR)
 */

const { 
  extractCurriculumUuid, 
  getScheduleInfo, 
  fetchAllWeeksLessons,
  getChaoxingScheduleFromUrl 
} = require('../services/chaoxingSchedule');

const { computeOcrConfidence } = require('../services/ocrSchedule');

// 测试用 URL (需要替换为真实的学习通课表链接)
const TEST_URL = process.argv[2] || 'https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=YOUR_UUID_HERE';

console.log('🚀 开始完整系统测试\n');

async function runTests() {
  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };

  // ========== TEST 1: UUID 提取 ==========
  console.log('📝 TEST 1: UUID 提取');
  try {
    const uuid = extractCurriculumUuid(TEST_URL);
    if (!uuid) {
      throw new Error('UUID 提取失败');
    }
    console.log(`✅ UUID 提取成功: ${uuid}\n`);
    results.passed++;
    results.tests.push({ name: 'UUID 提取', status: 'PASS', uuid });
  } catch (err) {
    console.error(`❌ UUID 提取失败: ${err.message}\n`);
    results.failed++;
    results.tests.push({ name: 'UUID 提取', status: 'FAIL', error: err.message });
    return results; // UUID 提取失败,后续测试无法进行
  }

  const uuid = extractCurriculumUuid(TEST_URL);

  // ========== TEST 2: 获取课表基本信息 (maxWeek) ==========
  console.log('📝 TEST 2: 获取课表基本信息 (maxWeek)');
  try {
    const info = await getScheduleInfo(uuid);
    if (!info.success) {
      throw new Error(info.error);
    }
    console.log(`✅ maxWeek: ${info.maxWeek}`);
    console.log(`✅ 学年: ${info.curriculum?.schoolYear || 'N/A'}`);
    console.log(`✅ 学期: ${info.curriculum?.semester || 'N/A'}\n`);
    results.passed++;
    results.tests.push({ 
      name: '获取课表信息', 
      status: 'PASS', 
      maxWeek: info.maxWeek,
      curriculum: info.curriculum 
    });
  } catch (err) {
    console.error(`❌ 获取课表信息失败: ${err.message}\n`);
    results.failed++;
    results.tests.push({ name: '获取课表信息', status: 'FAIL', error: err.message });
  }

  // ========== TEST 3: 全学期课表获取 ==========
  console.log('📝 TEST 3: 全学期课表获取 (fetchAllWeeksLessons)');
  try {
    console.log('⏳ 正在并发获取所有周次的课程...');
    const result = await fetchAllWeeksLessons(uuid);
    
    if (!result.success) {
      throw new Error(result.error);
    }

    console.log(`✅ 总周数: ${result.maxWeek}`);
    console.log(`✅ 课程总数: ${result.lessons.length}`);
    
    // 验证数据结构
    if (result.lessons.length > 0) {
      const sample = result.lessons[0];
      console.log('\n📋 示例课程数据:');
      console.log(`   - 课程名: ${sample.name}`);
      console.log(`   - 教师: ${sample.teacher}`);
      console.log(`   - 地点: ${sample.location}`);
      console.log(`   - 星期: ${sample.day}`);
      console.log(`   - 开始时间: ${sample.start}`);
      console.log(`   - 时长: ${sample.duration}分钟`);
      console.log(`   - 日期: ${sample.date || 'N/A'}\n`);
    }

    results.passed++;
    results.tests.push({ 
      name: '全学期课表获取', 
      status: 'PASS', 
      totalLessons: result.lessons.length,
      maxWeek: result.maxWeek 
    });
  } catch (err) {
    console.error(`❌ 全学期课表获取失败: ${err.message}\n`);
    results.failed++;
    results.tests.push({ name: '全学期课表获取', status: 'FAIL', error: err.message });
  }

  // ========== TEST 4: 标准化字段验证 ==========
  console.log('📝 TEST 4: 标准化字段验证');
  try {
    const result = await getChaoxingScheduleFromUrl(TEST_URL);
    
    if (!result.success) {
      throw new Error(result.error);
    }

    // 验证标准字段存在
    const requiredFields = ['name', 'teacher', 'location', 'day', 'start', 'duration', 'date', 'raw'];
    const firstLesson = result.schedule[0];
    
    const missingFields = requiredFields.filter(field => !(field in firstLesson));
    
    if (missingFields.length > 0) {
      throw new Error(`缺少标准字段: ${missingFields.join(', ')}`);
    }

    console.log('✅ 所有标准字段均存在: name, teacher, location, day, start, duration, date, raw\n');
    results.passed++;
    results.tests.push({ name: '标准化字段验证', status: 'PASS' });
  } catch (err) {
    console.error(`❌ 标准化字段验证失败: ${err.message}\n`);
    results.failed++;
    results.tests.push({ name: '标准化字段验证', status: 'FAIL', error: err.message });
  }

  // ========== TEST 5: OCR 置信度计算 ==========
  console.log('📝 TEST 5: OCR 置信度计算');
  try {
    // 模拟完整课表数据
    const fullSchedule = [
      { courseName: '高等数学', instructor: '张三', location: 'A101', weekday: 1, startTime: '08:00', endTime: '09:40', weeks: '1-16' },
      { courseName: '大学英语', instructor: '李四', location: 'B202', weekday: 2, startTime: '10:00', endTime: '11:40', weeks: '1-16' }
    ];
    const confidence1 = computeOcrConfidence(fullSchedule);
    console.log(`✅ 完整数据置信度: ${(confidence1 * 100).toFixed(1)}% (预期 ≥ 60%)`);

    // 模拟低质量数据
    const poorSchedule = [
      { courseName: '课程A', instructor: null, location: null, weekday: 1, startTime: null, endTime: null, weeks: null },
      { courseName: null, instructor: null, location: 'C303', weekday: null, startTime: '14:00', endTime: null, weeks: null }
    ];
    const confidence2 = computeOcrConfidence(poorSchedule);
    console.log(`✅ 低质量数据置信度: ${(confidence2 * 100).toFixed(1)}% (预期 < 60%)\n`);

    if (confidence1 >= 0.6 && confidence2 < 0.6) {
      results.passed++;
      results.tests.push({ name: 'OCR 置信度计算', status: 'PASS' });
    } else {
      throw new Error('置信度计算逻辑异常');
    }
  } catch (err) {
    console.error(`❌ OCR 置信度计算失败: ${err.message}\n`);
    results.failed++;
    results.tests.push({ name: 'OCR 置信度计算', status: 'FAIL', error: err.message });
  }

  // ========== TEST 6: 数据去重验证 ==========
  console.log('📝 TEST 6: 课程去重逻辑验证');
  try {
    const { dedupeLessons } = require('../services/chaoxingSchedule');
    
    // 模拟重复课程
    const duplicates = [
      { courseNo: 'CS101', beginNumber: 1, dayOfWeek: 1, name: '数据结构' },
      { courseNo: 'CS101', beginNumber: 1, dayOfWeek: 1, name: '数据结构' }, // 重复
      { courseNo: 'MATH201', beginNumber: 3, dayOfWeek: 2, name: '线性代数' }
    ];

    const deduped = dedupeLessons(duplicates);
    
    if (deduped.length === 2) {
      console.log(`✅ 去重成功: 3 条 → ${deduped.length} 条\n`);
      results.passed++;
      results.tests.push({ name: '课程去重验证', status: 'PASS' });
    } else {
      throw new Error(`去重失败: 预期 2 条,实际 ${deduped.length} 条`);
    }
  } catch (err) {
    console.error(`❌ 课程去重验证失败: ${err.message}\n`);
    results.failed++;
    results.tests.push({ name: '课程去重验证', status: 'FAIL', error: err.message });
  }

  // ========== 测试总结 ==========
  console.log('═'.repeat(60));
  console.log('📊 测试总结');
  console.log('═'.repeat(60));
  console.log(`✅ 通过: ${results.passed}`);
  console.log(`❌ 失败: ${results.failed}`);
  console.log(`📈 通过率: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);
  console.log('\n详细结果:');
  results.tests.forEach((test, idx) => {
    const icon = test.status === 'PASS' ? '✅' : '❌';
    console.log(`${idx + 1}. ${icon} ${test.name}`);
    if (test.error) {
      console.log(`   错误: ${test.error}`);
    }
  });
  console.log('═'.repeat(60));

  return results;
}

// 执行测试
runTests().catch(err => {
  console.error('💥 测试执行异常:', err);
  process.exit(1);
});
