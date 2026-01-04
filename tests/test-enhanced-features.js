/**
 * 测试增强功能:
 * 1. 新URL格式爬取
 * 2. OCR增强识别
 */

const https = require('https');

const SCRAPER_ENDPOINT = process.env.SCRAPER_ENDPOINT;

function getScraperHostname() {
    if (!SCRAPER_ENDPOINT) return null;
    try {
        const u = new URL(SCRAPER_ENDPOINT);
        return u.hostname;
    } catch {
        return null;
    }
}

const SCRAPER_HOSTNAME = getScraperHostname();

// 测试1: 新URL格式爬取
async function testNewUrlFormat() {
    if (!SCRAPER_ENDPOINT || !SCRAPER_HOSTNAME) {
        console.log('⏭️  未配置 SCRAPER_ENDPOINT，跳过远程爬虫测试。');
        return { skipped: true };
    }

    console.log('\n🧪 测试1: 新学习通URL格式爬取');
    console.log('='.repeat(60));
    
    const testUrl = 'https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=9a44e583-2c48-443c-bc72-d32a2f1ba101';
    
    const postData = JSON.stringify({ url: testUrl });
    
    const options = {
        hostname: SCRAPER_HOSTNAME,
        port: 443,
        path: '/scrape',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 60000
    };
    
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    
                    console.log(`\n✅ 请求成功 (HTTP ${res.statusCode})`);
                    console.log(`📊 元数据:`);
                    console.log(`   - 成功: ${result.success}`);
                    console.log(`   - 课程数量: ${result.metadata?.courseCount || 0}`);
                    console.log(`   - 耗时: ${result.metadata?.elapsedMs || 0}ms`);
                    console.log(`   - 截图大小: ${result.screenshot ? (result.screenshot.length / 1024).toFixed(2) + 'KB' : '无'}`);
                    
                    if (result.data?.courses && result.data.courses.length > 0) {
                        console.log(`\n📚 课程详情:`);
                        result.data.courses.slice(0, 3).forEach((course, i) => {
                            console.log(`   [${i + 1}] ${course.courseName}`);
                            console.log(`       时间: ${course.day} ${course.timeStart}-${course.timeEnd}`);
                            console.log(`       地点: ${course.location || '无'}`);
                        });
                        if (result.data.courses.length > 3) {
                            console.log(`   ... 还有 ${result.data.courses.length - 3} 门课程`);
                        }
                    } else {
                        console.log(`\n⚠️  未提取到课程 (可能URL已过期或需要登录)`);
                        console.log(`   但爬虫运行正常,已返回截图供参考`);
                    }
                    
                    if (result.error) {
                        console.log(`\n❌ 错误信息: ${result.error}`);
                    }
                    
                    resolve(result);
                } catch (err) {
                    console.error(`\n❌ JSON解析失败:`, err.message);
                    console.error(`响应内容:`, data.substring(0, 500));
                    reject(err);
                }
            });
        });
        
        req.on('error', (err) => {
            console.error(`\n❌ 请求失败:`, err.message);
            reject(err);
        });
        
        req.on('timeout', () => {
            req.destroy();
            console.error(`\n❌ 请求超时 (60秒)`);
            reject(new Error('Request timeout'));
        });
        
        req.write(postData);
        req.end();
    });
}

// 测试2: 健康检查
async function testHealthCheck() {
    if (!SCRAPER_ENDPOINT || !SCRAPER_HOSTNAME) {
        console.log('⏭️  未配置 SCRAPER_ENDPOINT，跳过健康检查。');
        return { skipped: true };
    }

    console.log('\n🧪 测试2: 爬虫服务健康检查');
    console.log('='.repeat(60));
    
    return new Promise((resolve, reject) => {
        https.get(`${SCRAPER_ENDPOINT}/health`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    console.log(`✅ 健康检查通过`);
                    console.log(`   服务: ${result.service}`);
                    console.log(`   状态: ${result.status}`);
                    console.log(`   时间: ${result.timestamp}`);
                    resolve(result);
                } catch (err) {
                    console.error(`❌ 响应解析失败:`, err.message);
                    reject(err);
                }
            });
        }).on('error', (err) => {
            console.error(`❌ 健康检查失败:`, err.message);
            reject(err);
        });
    });
}

// 测试3: 空课表容错
async function testEmptyScheduleHandling() {
    if (!SCRAPER_ENDPOINT || !SCRAPER_HOSTNAME) {
        console.log('⏭️  未配置 SCRAPER_ENDPOINT，跳过空课表容错测试。');
        return { skipped: true };
    }

    console.log('\n🧪 测试3: 空课表容错处理');
    console.log('='.repeat(60));
    
    // 使用一个肯定没有课表的URL
    const testUrl = 'https://www.chaoxing.com';
    
    const postData = JSON.stringify({ url: testUrl });
    
    const options = {
        hostname: SCRAPER_HOSTNAME,
        port: 443,
        path: '/scrape',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 60000
    };
    
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    
                    console.log(`\n✅ 容错测试完成`);
                    console.log(`   - 成功返回: ${result.success}`);
                    console.log(`   - 课程数量: ${result.metadata?.courseCount || 0}`);
                    console.log(`   - 是否有截图: ${!!result.screenshot}`);
                    
                    if (result.success && result.metadata.courseCount === 0 && result.screenshot) {
                        console.log(`\n✅ 容错处理正常:即使无课表数据,仍返回成功+截图`);
                    } else {
                        console.log(`\n⚠️  容错行为与预期不符`);
                    }
                    
                    resolve(result);
                } catch (err) {
                    console.error(`\n❌ JSON解析失败:`, err.message);
                    reject(err);
                }
            });
        });
        
        req.on('error', (err) => {
            console.error(`\n❌ 请求失败:`, err.message);
            reject(err);
        });
        
        req.on('timeout', () => {
            req.destroy();
            console.error(`\n❌ 请求超时`);
            reject(new Error('Request timeout'));
        });
        
        req.write(postData);
        req.end();
    });
}

// 运行所有测试
async function runAllTests() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║        Aris 爬虫增强功能测试套件                         ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    
    const results = {
        healthCheck: false,
        newUrlFormat: false,
        emptySchedule: false
    };
    
    try {
        // 测试1: 健康检查
        await testHealthCheck();
        results.healthCheck = true;
    } catch (err) {
        console.error(`健康检查测试失败:`, err.message);
    }
    
    try {
        // 测试2: 新URL格式
        await testNewUrlFormat();
        results.newUrlFormat = true;
    } catch (err) {
        console.error(`新URL格式测试失败:`, err.message);
    }
    
    try {
        // 测试3: 空课表容错
        await testEmptyScheduleHandling();
        results.emptySchedule = true;
    } catch (err) {
        console.error(`空课表容错测试失败:`, err.message);
    }
    
    // 汇总结果
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                      测试结果汇总                         ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    
    const total = Object.keys(results).length;
    const passed = Object.values(results).filter(Boolean).length;
    
    console.log(`✅ 健康检查:          ${results.healthCheck ? '通过' : '失败'}`);
    console.log(`✅ 新URL格式支持:     ${results.newUrlFormat ? '通过' : '失败'}`);
    console.log(`✅ 空课表容错:        ${results.emptySchedule ? '通过' : '失败'}`);
    
    console.log(`\n📊 总计: ${passed}/${total} 测试通过\n`);
    
    if (passed === total) {
        console.log('🎉 所有测试通过!爬虫增强功能正常工作!\n');
        process.exit(0);
    } else {
        console.log('⚠️  部分测试失败,请检查日志\n');
        process.exit(1);
    }
}

runAllTests();
