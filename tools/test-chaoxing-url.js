/**
 * 测试学习通课表 URL 解析
 * 用法: node tools/test-chaoxing-url.js <学习通课表链接>
 */

const { 
  extractCurriculumUuid, 
  getScheduleInfo,
  getChaoxingScheduleFromUrl,
  fetchAllWeeksLessons
} = require('../services/chaoxingSchedule');

const testUrl = process.argv[2] || 'https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=test-uuid-here';

console.log('🔍 测试 URL:', testUrl);
console.log('');

async function test() {
  try {
    // 1. 提取 UUID
    console.log('📝 步骤 1: 提取 UUID');
    const uuid = extractCurriculumUuid(testUrl);
    if (!uuid) {
      console.error('❌ UUID 提取失败');
      process.exit(1);
    }
    console.log(`✅ UUID: ${uuid}\n`);

    // 2. 获取课表信息
    console.log('📝 步骤 2: 获取课表基本信息');
    const info = await getScheduleInfo(uuid);
    if (!info.success) {
      console.error(`❌ 获取失败: ${info.error}`);
      process.exit(1);
    }
    console.log(`✅ maxWeek: ${info.maxWeek}`);
    console.log(`✅ 学年: ${info.curriculum?.schoolYear || 'N/A'}`);
    console.log(`✅ 学期: ${info.curriculum?.semester || 'N/A'}\n`);

    // 3. 获取单周课表
    console.log('📝 步骤 3: 获取单周课表 (验证链接有效性)');
    const singleWeek = await getChaoxingScheduleFromUrl(testUrl, 1);
    if (!singleWeek.success) {
      console.error(`❌ 获取失败: ${singleWeek.error}`);
      process.exit(1);
    }
    console.log(`✅ 第 1 周课程数: ${singleWeek.schedule.length}`);
    if (singleWeek.schedule.length > 0) {
      const sample = singleWeek.schedule[0];
      console.log('\n📋 示例课程:');
      console.log(`   - 课程名: ${sample.name}`);
      console.log(`   - 教师: ${sample.teacher}`);
      console.log(`   - 地点: ${sample.location}`);
      console.log(`   - 星期: ${sample.day}`);
      console.log(`   - 开始: ${sample.start}`);
      console.log(`   - 时长: ${sample.duration}分钟\n`);
    }

    // 4. 获取全学期课表
    console.log('📝 步骤 4: 获取全学期课表 (并发获取所有周)');
    const fullSchedule = await fetchAllWeeksLessons(uuid);
    if (!fullSchedule.success) {
      console.error(`❌ 获取失败: ${fullSchedule.error}`);
      process.exit(1);
    }
    console.log(`✅ 总周数: ${fullSchedule.maxWeek}`);
    console.log(`✅ 课程总数: ${fullSchedule.lessons.length} (已去重)\n`);

    // 验证标准化字段
    console.log('📝 步骤 5: 验证标准化字段');
    const requiredFields = ['name', 'teacher', 'location', 'day', 'start', 'duration', 'date', 'raw'];
    if (fullSchedule.lessons.length > 0) {
      const sample = fullSchedule.lessons[0];
      const missingFields = requiredFields.filter(f => !(f in sample));
      if (missingFields.length > 0) {
        console.error(`❌ 缺少字段: ${missingFields.join(', ')}`);
        process.exit(1);
      }
      console.log(`✅ 所有标准字段均存在: ${requiredFields.join(', ')}\n`);
    }

    console.log('🎉 所有测试通过!');
  } catch (err) {
    console.error('💥 测试异常:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

test();
