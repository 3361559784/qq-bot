/**
 * 测试爬虫微服务 API 调用
 * 运行: node test-scraper-api.js
 */

const https = require('https');

const SCRAPER_ENDPOINT = "https://aris-scraper.blueglacier-a914b85e.koreacentral.azurecontainerapps.io";
const testUrl = "https://kb.chaoxing.com/pc/course/286506260/326816896?clazzId=112566595&courseId=242163026&cpi=369869652";

async function fetchJSON(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const req = https.request({
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    resolve(data);
                }
            });
        });
        
        req.on('error', reject);
        
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

async function testScraper() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  爬虫微服务 API 测试');
    console.log('═══════════════════════════════════════════════════\n');
    
    // 1. 健康检查
    console.log('🔍 步骤 1: 健康检查');
    try {
        const health = await fetchJSON(`${SCRAPER_ENDPOINT}/health`);
        console.log('✅ 服务状态:', health);
    } catch (err) {
        console.error('❌ 健康检查失败:', err.message);
        return;
    }
    
    // 2. 调用爬虫
    console.log('\n🔍 步骤 2: 调用爬虫服务');
    console.log('目标 URL:', testUrl);
    console.log('正在抓取...(预计30-60秒)\n');
    
    const startTime = Date.now();
    
    try {
        const result = await fetchJSON(`${SCRAPER_ENDPOINT}/scrape`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: testUrl })
        });
        
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
        
        console.log('\n═══════════════════════════════════════════════════');
        console.log('  爬取结果');
        console.log('═══════════════════════════════════════════════════\n');
        
        console.log('✅ 成功:', result.success);
        console.log('⏱️  耗时:', elapsedTime, '秒');
        
        if (result.success) {
            console.log('\n📊 元数据:');
            console.log('  - 课程数量:', result.metadata.courseCount);
            console.log('  - 时间戳:', result.metadata.timestamp);
            console.log('  - 数据源:', result.metadata.source);
            
            console.log('\n📚 结构化数据示例 (前3门课):');
            result.data.courses.slice(0, 3).forEach((course, idx) => {
                console.log(`\n  ${idx + 1}. ${course.courseName}`);
                console.log(`     时间: ${course.day} ${course.timeStart}-${course.timeEnd}`);
                console.log(`     地点: ${course.location || '未知'}`);
                console.log(`     日期: ${course.date}`);
            });
            
            console.log('\n📝 人类可读摘要:');
            console.log(result.data.summary.split('\n').slice(0, 10).join('\n'));
            
            console.log('\n📷 截图: Base64 长度', result.screenshot ? result.screenshot.length : 0, '字符');
            
            console.log('\n✅ 数据格式符合 MVP 标准!');
        } else {
            console.log('\n❌ 失败原因:', result.error);
        }
        
    } catch (err) {
        console.error('\n❌ 爬取失败:', err.message);
        console.error(err.stack);
    }
    
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  测试完成');
    console.log('═══════════════════════════════════════════════════');
}

// 运行测试
testScraper().catch(err => {
    console.error('\n❌ 测试失败:', err);
    process.exit(1);
});
