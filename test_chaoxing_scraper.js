/**
 * 学习通爬虫独立测试脚本
 * 用法: node test_chaoxing_scraper.js
 */

const { scrapeChaoxingSchedule, cleanScrapedText } = require('./src/functions/chaoxingScraper');

// 模拟 Azure Functions context
const mockContext = {
    log: (...args) => console.log('[LOG]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
};

// 测试 URL
const TEST_URL = process.env.CHAOXING_URL || 'https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=9a44e583-2c48-443c-bc72-d32a2f1ba101';

async function main() {
    console.log('========================================');
    console.log('学习通课表爬虫测试');
    console.log('========================================');
    console.log('目标 URL:', TEST_URL);
    console.log('');

    try {
        // 执行爬取
        const result = await scrapeChaoxingSchedule(TEST_URL, mockContext);

        console.log('\n========================================');
        console.log('爬取结果:');
        console.log('========================================');
        console.log('成功:', result.success);
        console.log('截图路径:', result.screenshotPath);
        console.log('文本长度:', result.text ? result.text.length : 0);
        console.log('错误信息:', result.error || '无');
        
        if (result.success) {
            const cleanedText = cleanScrapedText(result.text);
            console.log('\n========================================');
            console.log('提取的文本内容 (前 500 字符):');
            console.log('========================================');
            console.log(cleanedText.substring(0, 500));
            console.log('\n...(后续省略)');
            
            // 保存完整文本到文件
            const fs = require('fs');
            const path = require('path');
            const outputPath = path.join(__dirname, 'scraped_schedule.txt');
            fs.writeFileSync(outputPath, cleanedText, 'utf8');
            console.log(`\n完整文本已保存到: ${outputPath}`);
        }

        console.log('\n✅ 测试完成');
        process.exit(result.success ? 0 : 1);

    } catch (error) {
        console.error('\n❌ 测试失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
