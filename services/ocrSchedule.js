const { OpenAI } = require('openai');

// GitHub Models GPT-4o 视觉 OCR（不再依赖 Azure Computer Vision）
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_MODELS_TOKEN;

// OCR 请求超时时间（60秒，GPT-4o 视觉处理较慢）
const OCR_TIMEOUT_MS = 60000;

/**
 * 带超时的 Promise 包装
 */
function withTimeout(promise, ms, errorMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(errorMsg || `请求超时 (${ms/1000}秒)`)), ms)
    )
  ]);
}

/**
 * 从图片 URL 或 Base64 提取文本 (使用 GPT-4o 视觉能力)
 * @param {string} urlOrBase64 - 图片 URL 或 data:image/xxx;base64,... 格式
 * @returns {Promise<string>} 提取的文本内容
 */
async function extractTextFromImage(urlOrBase64) {
  if (!GITHUB_TOKEN) {
    throw new Error('需要 GITHUB_TOKEN 环境变量来调用 GPT-4o 视觉');
  }

  const openai = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: GITHUB_TOKEN
  });

  // 构建图片内容
  let imageContent;
  if (urlOrBase64.startsWith('data:image/')) {
    // Base64 格式
    imageContent = { type: "image_url", image_url: { url: urlOrBase64 } };
  } else {
    // URL 格式
    imageContent = { type: "image_url", image_url: { url: urlOrBase64 } };
  }

  const response = await withTimeout(
    openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请提取这张图片中的所有文字内容。只返回文字，不要添加任何解释或格式化。保持原始布局和换行。"
            },
            imageContent
          ]
        }
      ],
      max_tokens: 4000,
      temperature: 0.1
    }),
    OCR_TIMEOUT_MS,
    '图片识别超时，请稍后重试或使用较小的图片'
  );

  const text = response.choices[0]?.message?.content?.trim() || '';
  return text;
}

/**
 * 计算 OCR 识别置信度 (基于字段完整性)
 * @param {Array} schedule - 课表数组
 * @returns {number} 置信度分数 (0.0 ~ 1.0)
 */
function computeOcrConfidence(schedule) {
  if (!schedule || schedule.length === 0) return 0.0;

  const requiredFields = ['courseName', 'instructor', 'location', 'weekday', 'startTime', 'endTime', 'weeks'];
  let totalScore = 0;

  for (const course of schedule) {
    let filledCount = 0;
    for (const field of requiredFields) {
      const value = course[field];
      // 检查字段是否有效填充 (非 null, 非空字符串)
      if (value !== null && value !== undefined && value !== '') {
        filledCount++;
      }
    }
    // 🎯 每门课程的分数 = 填充字段数 / 总字段数
    // 例如: 7/7 = 1.0 (100%), 5/7 = 0.71 (71%), 3/7 = 0.43 (43%)
    totalScore += filledCount / requiredFields.length;
  }

  // 平均置信度 = 总分 / 课程数
  const confidence = totalScore / schedule.length;
  return Math.min(confidence, 1.0); // 限制最大值为 1.0
}

/**
 * 使用 LLM 将 OCR 文本解析为结构化课表 JSON
 * @param {string} text - OCR 提取的文本
 * @param {string} token - GitHub Token
 * @returns {Promise<{schedule: Array, confidence: number}>} 结构化的课表事件数组 + 置信度
 */
async function parseScheduleFromOcrText(text, token) {
  if (!token) {
    throw new Error('需要 GITHUB_TOKEN 环境变量来调用 LLM');
  }

  const openai = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: token
  });

  const prompt = `你是一个课表解析专家。请从以下 OCR 提取的文本中解析出课程信息,并返回结构化 JSON 数组。

OCR 文本:
${text}

请返回以下格式的 JSON 数组 (只返回 JSON,不要其他文字):
[
  {
    "courseName": "课程名称",
    "instructor": "教师姓名",
    "location": "上课地点",
    "weekday": "星期几 (1-7)",
    "startTime": "开始时间 (HH:MM)",
    "endTime": "结束时间 (HH:MM)",
    "weeks": "周次范围 (例如: 1-16周)"
  }
]

如果无法识别某个字段,请使用 null。`;

  const { getOcrParseModel } = require('./modelRouter');
  const OCR_PARSE_MODEL = getOcrParseModel();

  const response = await withTimeout(
    openai.chat.completions.create({
      model: OCR_PARSE_MODEL,
      messages: [
        { role: "system", content: "你是一个精确的课表解析助手,只返回 JSON 格式的数据。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 2000
    }),
    30000, // 30秒超时，解析步骤通常较快
    '课表解析超时，请稍后重试'
  );

  const content = response.choices[0].message.content.trim();
  
  // 提取 JSON (移除可能的 markdown 代码块标记)
  const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('LLM 未返回有效的 JSON 格式');
  }

  const jsonText = jsonMatch[1] || jsonMatch[0];
  const schedule = JSON.parse(jsonText);

  // 🎯 计算置信度
  const confidence = computeOcrConfidence(schedule);

  return { schedule, confidence };
}

/**
 * OCR 课表完整流程: 图片 URL -> 结构化 JSON
 * @param {string} imageUrl - 课表截图 URL
 * @param {string} token - GitHub Token
 * @returns {Promise<{schedule: Array, confidence: number, text: string}>} 结构化的课表事件数组 + 置信度 + OCR 原始文本
 */
async function ocrScheduleWorkflow(imageUrl, token) {
  console.log('[OCR] 步骤 1: 从图片提取文本...');
  const text = await extractTextFromImage(imageUrl);
  console.log(`[OCR] 提取到 ${text.length} 字符`);

  console.log('[OCR] 步骤 2: 使用 LLM 解析文本为 JSON...');
  const { schedule, confidence } = await parseScheduleFromOcrText(text, token);
  console.log(`[OCR] 解析到 ${schedule.length} 条课程, 置信度: ${(confidence * 100).toFixed(1)}%`);

  return { schedule, confidence, text };
}

module.exports = { 
  extractTextFromImage, 
  parseScheduleFromOcrText,
  ocrScheduleWorkflow,
  computeOcrConfidence // 🎯 导出置信度计算函数
};
