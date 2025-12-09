/**
 * P0功能测试脚本
 * 用于验证新集成的P0增强功能是否正常工作
 */

// 从schoolBot.js导入需要测试的函数
const { 
    aiPostProcess, 
    detectLanguage, 
    getPromptByLanguage,
    simpleVectorize,
    cosineSimilarity 
} = require('./src/functions/schoolBot.js');

console.log("=".repeat(60));
console.log("P0功能测试开始");
console.log("=".repeat(60));

// 测试1: emoji转换
console.log("\n【测试1: Emoji转换】");
const testEmoji = [
    "我爱你😊",
    "好的👍",
    "加油💪",
    "哈哈哈😂😂"
];

testEmoji.forEach(text => {
    const processed = aiPostProcess(text);
    console.log(`原文: ${text}`);
    console.log(`处理后: ${processed}`);
    console.log("-".repeat(40));
});

// 测试2: AI腔调修正
console.log("\n【测试2: AI腔调修正】");
const testAISpeak = [
    "作为一个AI助手，我认为这很好。",
    "我的训练数据包含了很多信息。",
    "我理解您的需求，我会尽力帮助您。",
    "这是一个正常的句子，没有AI腔调。"
];

testAISpeak.forEach(text => {
    const processed = aiPostProcess(text);
    console.log(`原文: ${text}`);
    console.log(`处理后: ${processed}`);
    console.log("-".repeat(40));
});

// 测试3: 语言检测
console.log("\n【测试3: 语言检测】");
const testLang = [
    "你好，今天天气怎么样？",
    "こんにちは、元気ですか？",
    "Hello, how are you today?",
    "混合text包含中文and English"
];

testLang.forEach(text => {
    const lang = detectLanguage(text);
    console.log(`文本: ${text}`);
    console.log(`检测结果: ${lang}`);
    console.log("-".repeat(40));
});

// 测试4: 向量相似度
console.log("\n【测试4: 向量相似度计算】");
const testTexts = [
    "今天天气真好",
    "今天气候不错",
    "我想吃拉面",
    "天空很蓝"
];

console.log("计算向量相似度矩阵:");
for (let i = 0; i < testTexts.length; i++) {
    for (let j = i + 1; j < testTexts.length; j++) {
        const vec1 = simpleVectorize(testTexts[i]);
        const vec2 = simpleVectorize(testTexts[j]);
        const sim = cosineSimilarity(vec1, vec2);
        console.log(`"${testTexts[i]}" <-> "${testTexts[j]}"`);
        console.log(`相似度: ${sim.toFixed(4)}`);
        console.log("-".repeat(40));
    }
}

// 测试5: Prompt模板选择
console.log("\n【测试5: Prompt模板选择】");
const langs = ['zh', 'ja', 'en'];
langs.forEach(lang => {
    const prompt = getPromptByLanguage(lang);
    if (prompt) {
        console.log(`语言: ${lang}`);
        console.log(`Prompt前100字符: ${prompt.substring(0, 100)}...`);
    } else {
        console.log(`语言: ${lang} - 无特定模板，使用默认`);
    }
    console.log("-".repeat(40));
});

console.log("\n=".repeat(60));
console.log("P0功能测试完成");
console.log("=".repeat(60));
