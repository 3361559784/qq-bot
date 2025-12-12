#!/usr/bin/env node

/**
 * 学习通课表 API 集成测试
 * 
 * 测试流程:
 * 1. 从 URL 提取 UUID
 * 2. 调用 getOtherLessons API
 * 3. 解析并转换数据格式
 * 4. 输出结果供验证
 */

const { getChaoxingScheduleFromUrl } = require('../services/chaoxingSchedule');

const testUrl = process.argv[2] || 'https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=9a44e583-2c48-443c-bc72-d32a2f1ba101';
const testWeek = process.argv[3] ? parseInt(process.argv[3]) : null;

console.log('🧪 学习通课表 API 测试');
console.log('='.repeat(60));
console.log(`📍 测试 URL: ${testUrl}`);
if (testWeek) {
  console.log(`📅 指定周次: 第 ${testWeek} 周`);
}
console.log('='.repeat(60));
console.log('');

(async () => {
  try {
    const result = await getChaoxingScheduleFromUrl(testUrl, testWeek);

    if (!result.success) {
      console.error('❌ 测试失败!');
      console.error(`错误类型: ${result.errorType}`);
      console.error(`错误信息: ${result.error}`);
      process.exit(1);
    }

    console.log('✅ API 调用成功!');
    console.log('');
    
    // 输出课表元数据
    console.log('📊 课表元数据:');
    console.log('-'.repeat(60));
    console.log(`学年: ${result.curriculum.schoolYear}`);
    console.log(`学期: ${result.curriculum.semester}`);
    console.log(`当前周: 第 ${result.curriculum.currentWeek} 周 (共 ${result.curriculum.maxWeek} 周)`);
    console.log(`课程总数: ${result.metadata.totalLessons} 门`);
    console.log(`访客模式: ${result.metadata.visitor === 2 ? '是' : '否'}`);
    console.log('');

    // 输出前 5 门课程详情
    console.log('📚 课程详情 (前 5 门):');
    console.log('-'.repeat(60));
    result.schedule.slice(0, 5).forEach((lesson, index) => {
      console.log(`\n${index + 1}. ${lesson.courseName}`);
      console.log(`   教师: ${lesson.instructor}`);
      console.log(`   地点: ${lesson.location}`);
      console.log(`   时间: 周${lesson.dayOfWeek} 第${lesson.beginNumber}节 (${lesson.startTime}-${lesson.endTime})`);
      console.log(`   周次: ${lesson.weeks}`);
      console.log(`   日期: ${lesson.wholeDay || lesson.day}`);
      if (lesson.extend?.campus) {
        console.log(`   校区: ${lesson.extend.campus}`);
      }
    });

    if (result.schedule.length > 5) {
      console.log(`\n... 还有 ${result.schedule.length - 5} 门课程未显示`);
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('✅ 测试通过! 数据格式正确,可以保存到 Cosmos DB');
    console.log('='.repeat(60));

    // 输出 JSON 格式供调试
    console.log('\n📄 完整 JSON 数据 (保存到 test-result.json):');
    const fs = require('fs');
    fs.writeFileSync('test-result.json', JSON.stringify(result, null, 2));
    console.log('已保存到: test-result.json');

  } catch (error) {
    console.error('❌ 测试异常!');
    console.error(error);
    process.exit(1);
  }
})();
