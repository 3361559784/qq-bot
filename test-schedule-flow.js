/**
 * 测试完整课表数据流: URL → 爬虫 → Cosmos → 响应
 * 运行: node test-schedule-flow.js
 */

const { CosmosClient } = require("@azure/cosmos");

// 从 local.settings.json 读取配置
const fs = require('fs');
const localSettings = JSON.parse(fs.readFileSync('local.settings.json', 'utf8'));
process.env.GITHUB_TOKEN = localSettings.Values.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
process.env.COSMOS_DB_STRING = localSettings.Values.COSMOS_DB_STRING || process.env.COSMOS_DB_STRING;
process.env.SCRAPER_ENDPOINT = localSettings.Values.SCRAPER_ENDPOINT || process.env.SCRAPER_ENDPOINT;

// 模拟 Azure Functions context
const mockContext = {
    log: (...args) => console.log('[TEST]', ...args),
    error: (...args) => console.error('[TEST ERROR]', ...args)
};

// 模拟测试数据
const testChaoxingUrl = "https://kb.chaoxing.com/pc/course/286506260/326816896?clazzId=112566595&courseId=242163026&cpi=369869652";

async function testScheduleFlow() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  课表数据流测试 (Chaoxing Schedule → Cosmos)');
    console.log('═══════════════════════════════════════════════════\n');
    
    // 1. 导入处理函数
    const { handleScheduleRequest, cosmosContainer, token } = require('./src/functions/schoolBot.js');
    
    if (!cosmosContainer) {
        console.error('❌ Cosmos DB 未配置,请设置 COSMOS_DB_STRING 环境变量');
        return;
    }
    
    if (!token) {
        console.error('❌ GitHub Token 未配置,请设置 GITHUB_TOKEN 环境变量');
        return;
    }
    
    console.log('✅ Cosmos DB 已连接');
    console.log('✅ GitHub Token 已配置\n');
    
    // 2. 调用处理函数
    console.log('📡 测试学习通课表 URL:', testChaoxingUrl);
    
    const result = await handleScheduleRequest({
        fileLinks: [],
        imageUrls: [],
        msg: testChaoxingUrl,  // 传入学习通 URL
        senderId: 'test_user_123',
        dbKey: 'test_user_123',
        cosmosContainer,
        context: mockContext,
        token
    });
    
    // 3. 显示结果
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  测试结果');
    console.log('═══════════════════════════════════════════════════\n');
    
    if (result) {
        console.log('HTTP Status:', result.status);
        
        if (result.body) {
            const body = JSON.parse(result.body);
            console.log('\n📄 返回消息:');
            console.log(body.reply);
        }
        
        // 4. 验证数据库存储
        try {
            const { resource } = await cosmosContainer.item('test_user_123', 'test_user_123').read();
            if (resource && resource.schedules) {
                console.log('\n✅ Cosmos DB 数据已保存');
                console.log(`📊 课程数量: ${resource.schedules.length}`);
                console.log('\n📚 前3门课程:');
                resource.schedules.slice(0, 3).forEach((course, idx) => {
                    console.log(`  ${idx + 1}. ${course.summary} - ${course.location}`);
                    console.log(`     时间: ${course.start?.dateTime || course.start?.date}`);
                });
            } else {
                console.log('\n⚠️  未在 Cosmos DB 中找到课表数据');
            }
        } catch (err) {
            console.log('\n⚠️  读取 Cosmos DB 数据失败:', err.message);
        }
        
    } else {
        console.log('❌ 未返回结果');
    }
    
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  测试完成');
    console.log('═══════════════════════════════════════════════════');
}

// 运行测试
testScheduleFlow().catch(err => {
    console.error('\n❌ 测试失败:', err);
    console.error(err.stack);
    process.exit(1);
});
