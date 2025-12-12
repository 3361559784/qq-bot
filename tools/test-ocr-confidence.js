/**
 * 测试 OCR 置信度计算逻辑
 */

const { computeOcrConfidence } = require('../services/ocrSchedule');

console.log('🧪 测试 OCR 置信度计算\n');

// 测试用例 1: 完整高质量数据
const perfectSchedule = [
  {
    courseName: '高等数学',
    instructor: '张三教授',
    location: 'A101教室',
    weekday: 1,
    startTime: '08:00',
    endTime: '09:40',
    weeks: '1-16周'
  },
  {
    courseName: '大学英语',
    instructor: '李四老师',
    location: 'B202',
    weekday: 2,
    startTime: '10:00',
    endTime: '11:40',
    weeks: '1-16'
  }
];

const conf1 = computeOcrConfidence(perfectSchedule);
console.log(`✅ 测试 1 - 完整数据 (7/7 字段): ${(conf1 * 100).toFixed(1)}%`);
console.log(`   预期: ≥ 60% | 实际: ${conf1 >= 0.6 ? '✅ 通过' : '❌ 失败'}\n`);

// 测试用例 2: 中等质量数据 (部分字段缺失)
const mediumSchedule = [
  {
    courseName: '数据结构',
    instructor: '王五',
    location: null, // 缺失
    weekday: 3,
    startTime: '14:00',
    endTime: null, // 缺失
    weeks: '1-18'
  }
];

const conf2 = computeOcrConfidence(mediumSchedule);
console.log(`📊 测试 2 - 中等数据 (5/7 字段): ${(conf2 * 100).toFixed(1)}%`);
console.log(`   预期: 60-80% | 实际: ${conf2 >= 0.6 && conf2 <= 0.8 ? '✅ 通过' : '❌ 失败'}\n`);

// 测试用例 3: 低质量数据 (大量字段缺失)
const poorSchedule = [
  {
    courseName: '课程A',
    instructor: null,
    location: null,
    weekday: 1,
    startTime: null,
    endTime: null,
    weeks: null
  },
  {
    courseName: null,
    instructor: null,
    location: 'C303',
    weekday: null,
    startTime: '14:00',
    endTime: null,
    weeks: null
  }
];

const conf3 = computeOcrConfidence(poorSchedule);
console.log(`⚠️  测试 3 - 低质量数据 (平均 2/7 字段): ${(conf3 * 100).toFixed(1)}%`);
console.log(`   预期: < 60% | 实际: ${conf3 < 0.6 ? '✅ 通过 (会触发警告)' : '❌ 失败'}\n`);

// 测试用例 4: 空数据
const emptySchedule = [];
const conf4 = computeOcrConfidence(emptySchedule);
console.log(`❌ 测试 4 - 空数据: ${(conf4 * 100).toFixed(1)}%`);
console.log(`   预期: 0% | 实际: ${conf4 === 0 ? '✅ 通过' : '❌ 失败'}\n`);

// 总结
console.log('═'.repeat(50));
const allPassed = 
  conf1 >= 0.6 && 
  conf2 >= 0.6 && conf2 <= 0.8 && 
  conf3 < 0.6 && 
  conf4 === 0;

if (allPassed) {
  console.log('🎉 所有 OCR 置信度测试通过!');
  process.exit(0);
} else {
  console.log('❌ 部分测试失败,请检查 computeOcrConfidence 实现');
  process.exit(1);
}
