// 测试 GPT-4o 视觉 OCR + 课表结构化
const fs = require('fs');
const path = require('path');

async function test() {
  const { extractTextFromImage, parseScheduleFromOcrText } = require('../services/ocrSchedule');
  
  const imagePath = path.join(__dirname, '..', '8d2f4380-a186-4489-9f0c-b5d0861f17e2.png');
  
  if (!fs.existsSync(imagePath)) {
    console.error('找不到测试图片:', imagePath);
    return;
  }
  
  // 读取图片为 base64
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;
  
  console.log('=== 图片 OCR 测试 ===');
  console.log(`图片大小: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
  console.log('');
  
  console.log('1. 调用 GPT-4o 视觉提取文字...');
  const text = await extractTextFromImage(base64Image);
  console.log('提取的文字:');
  console.log('---');
  console.log(text);
  console.log('---');
  console.log('');
  
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('需要 GITHUB_TOKEN 环境变量');
    return;
  }
  
  console.log('2. 使用 LLM 解析为结构化课表...');
  const { schedule, confidence } = await parseScheduleFromOcrText(text, token);
  
  console.log(`解析到 ${schedule.length} 门课程, 置信度: ${(confidence * 100).toFixed(1)}%`);
  console.log('');
  
  schedule.forEach((c, i) => {
    console.log(`${i+1}. 周${c.weekday} ${c.startTime || '-'}-${c.endTime || '-'} ${c.courseName} @ ${c.location || '-'}`);
  });
}

test().catch(e => {
  console.error('测试失败:', e.message);
  console.error(e.stack);
});
