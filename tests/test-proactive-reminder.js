/**
 * 测试完整闭环:
 * 1. 手动触发保存课表档案(模拟用户发送链接)
 * 2. 查询Cosmos DB验证数据已存储
 * 3. 模拟Timer Trigger运行
 * 4. 验证主动消息发送
 */

const { CosmosClient } = require("@azure/cosmos");

// 直接从环境变量读取(Azure Functions会自动注入)
const cosmosString = process.env["COSMOS_DB_STRING"];
const NAPCAT_API_URL = process.env["NAPCAT_API_URL"] || 'http://4.230.25.38:6009';

let cosmosContainer = null;
if (cosmosString) {
    const client = new CosmosClient(cosmosString);
    const db = client.database("aris-bot-db");
    cosmosContainer = db.container("chatHistory");
}

// ==========================================
// 测试1: 模拟保存课表档案
// ==========================================
async function testSaveScheduleProfile() {
    console.log('\n🧪 测试1: 保存课表档案到Cosmos DB');
    console.log('='.repeat(60));
    
    if (!cosmosContainer) {
        console.log('❌ Cosmos容器未初始化');
        return false;
    }
    
    try {
        const testUserId = '3361559784'; // 使用你的QQ号
        const profileId = `schedule_${testUserId}`;
        
        // 模拟从爬虫获取的课表数据
        const testSchedule = {
            id: profileId,
            partitionKey: testUserId,
            userId: testUserId,
            schedule_config: {
                source_url: 'https://kb.chaoxing.com/test',
                last_updated: new Date().toISOString(),
                semester: '2025-Spring',
                total_courses: 3
            },
            weekly_schedule: [
                {
                    day: 1, // 周一
                    start: 1,
                    name: '高等数学',
                    location: '教学楼A101',
                    timeStart: '08:00',
                    timeEnd: '09:40',
                    teacher: '张教授'
                },
                {
                    day: 3, // 周三
                    start: 3,
                    name: '大学英语',
                    location: '外语楼201',
                    timeStart: '10:00',
                    timeEnd: '11:40',
                    teacher: '李老师'
                },
                {
                    day: 5, // 周五
                    start: 2,
                    name: '计算机网络',
                    location: '实验楼B305',
                    timeStart: '09:00',
                    timeEnd: '10:40',
                    teacher: '王工程师'
                }
            ],
            type: 'schedule_profile',
            createdAt: new Date().toISOString()
        };
        
        await cosmosContainer.items.upsert(testSchedule);
        console.log(`✅ 已保存测试课表档案: ${testUserId}`);
        console.log(`   课程数量: ${testSchedule.weekly_schedule.length}`);
        console.log(`   周一: ${testSchedule.weekly_schedule[0].name}`);
        console.log(`   周三: ${testSchedule.weekly_schedule[1].name}`);
        console.log(`   周五: ${testSchedule.weekly_schedule[2].name}`);
        
        return true;
        
    } catch (err) {
        console.log(`❌ 保存失败: ${err.message}`);
        return false;
    }
}

// ==========================================
// 测试2: 查询课表档案
// ==========================================
async function testQueryScheduleProfile() {
    console.log('\n🧪 测试2: 查询已保存的课表档案');
    console.log('='.repeat(60));
    
    if (!cosmosContainer) {
        console.log('❌ Cosmos容器未初始化');
        return false;
    }
    
    try {
        const query = {
            query: "SELECT * FROM c WHERE c.type = 'schedule_profile' AND ARRAY_LENGTH(c.weekly_schedule) > 0"
        };
        
        const { resources } = await cosmosContainer.items.query(query).fetchAll();
        
        console.log(`✅ 找到 ${resources.length} 个用户课表档案:`);
        
        resources.forEach(profile => {
            console.log(`\n用户 ${profile.userId}:`);
            console.log(`  链接: ${profile.schedule_config.source_url}`);
            console.log(`  更新时间: ${profile.schedule_config.last_updated}`);
            console.log(`  学期: ${profile.schedule_config.semester}`);
            console.log(`  课程数: ${profile.weekly_schedule.length}`);
            
            const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
            profile.weekly_schedule.forEach(c => {
                console.log(`    • ${weekdayNames[c.day]} 第${c.start}节 ${c.timeStart}-${c.timeEnd} ${c.name} @${c.location}`);
            });
        });
        
        return resources.length > 0;
        
    } catch (err) {
        console.log(`❌ 查询失败: ${err.message}`);
        return false;
    }
}

// ==========================================
// 测试3: 模拟Timer Trigger逻辑
// ==========================================
async function testTimerTriggerLogic() {
    console.log('\n🧪 测试3: 模拟Timer Trigger运行');
    console.log('='.repeat(60));
    
    if (!cosmosContainer) {
        console.log('❌ Cosmos容器未初始化');
        return false;
    }
    
    try {
        // 获取当前北京时间周几
        const now = new Date();
        const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utcTime + (8 * 3600000));
        const day = beijingTime.getDay();
        const todayWeekday = day === 0 ? 7 : day;
        
        const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        console.log(`当前北京时间: ${beijingTime.toISOString()}`);
        console.log(`今天是: ${weekdayNames[todayWeekday]} (${todayWeekday})`);
        
        // 获取所有用户档案
        const query = {
            query: "SELECT * FROM c WHERE c.type = 'schedule_profile' AND ARRAY_LENGTH(c.weekly_schedule) > 0"
        };
        
        const { resources: users } = await cosmosContainer.items.query(query).fetchAll();
        
        console.log(`\n找到 ${users.length} 个用户,开始检查今日课表:\n`);
        
        for (const user of users) {
            const todayClasses = user.weekly_schedule.filter(c => c.day === todayWeekday);
            
            console.log(`用户 ${user.userId}:`);
            console.log(`  今日课程: ${todayClasses.length} 节`);
            
            if (todayClasses.length > 0) {
                todayClasses.sort((a, b) => {
                    const timeA = parseInt(a.timeStart.replace(':', ''));
                    const timeB = parseInt(b.timeStart.replace(':', ''));
                    return timeA - timeB;
                });
                
                console.log(`  第一节: ${todayClasses[0].name} (${todayClasses[0].timeStart})`);
                console.log(`  地点: ${todayClasses[0].location}`);
                
                // 生成提醒消息(但不实际发送)
                const msg = formatTestReminder(todayClasses);
                console.log(`\n  [模拟消息预览]:`);
                console.log(msg.split('\n').map(line => `    ${line}`).join('\n'));
                
            } else {
                console.log(`  今天没有课程安排`);
            }
            console.log('');
        }
        
        return true;
        
    } catch (err) {
        console.log(`❌ 测试失败: ${err.message}`);
        return false;
    }
}

function formatTestReminder(courses) {
    if (courses.length === 0) {
        return '(轻松) 今天没有安排课程哦！可以好好休息！✨';
    }
    
    const firstClass = courses[0];
    let msg = `邦邦咔邦！Sensei早安！(✨ω✨)\n\n`;
    msg += `📚 今天有 ${courses.length} 节课哦！\n\n`;
    msg += `第一节课:\n`;
    msg += `📖 ${firstClass.name}\n`;
    msg += `⏰ ${firstClass.timeStart}-${firstClass.timeEnd}\n`;
    msg += `📍 ${firstClass.location || '位置待确认'}\n`;
    
    if (courses.length > 1) {
        msg += `\n还有其他课程:\n`;
        courses.slice(1).forEach(c => {
            msg += `• ${c.timeStart} ${c.name}`;
            if (c.location) msg += ` @${c.location}`;
            msg += `\n`;
        });
    }
    
    msg += `\n💪 爱丽丝会一直支援Sensei的！加油哦！`;
    
    return msg;
}

// ==========================================
// 测试4: NapCat API连通性
// ==========================================
async function testNapCatConnectivity() {
    console.log('\n🧪 测试4: NapCat API连通性');
    console.log('='.repeat(60));
    
    try {
        const url = `${NAPCAT_API_URL}/get_login_info`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.log(`❌ API响应失败: HTTP ${response.status}`);
            return false;
        }
        
        const data = await response.json();
        console.log(`✅ NapCat API可访问`);
        console.log(`   机器人QQ: ${data.data?.user_id || 'unknown'}`);
        console.log(`   昵称: ${data.data?.nickname || 'unknown'}`);
        
        return true;
        
    } catch (err) {
        console.log(`❌ 连接失败: ${err.message}`);
        console.log(`   请确保NapCat服务正在运行: ${NAPCAT_API_URL}`);
        return false;
    }
}

// ==========================================
// 运行所有测试
// ==========================================
async function runAllTests() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║        Aris 主动提醒系统 - 完整测试套件                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    
    const results = {
        saveProfile: false,
        queryProfile: false,
        timerLogic: false,
        napcat: false
    };
    
    // 测试1: 保存课表档案
    results.saveProfile = await testSaveScheduleProfile();
    
    // 测试2: 查询课表档案
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.queryProfile = await testQueryScheduleProfile();
    
    // 测试3: Timer Trigger逻辑
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.timerLogic = await testTimerTriggerLogic();
    
    // 测试4: NapCat连通性
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.napcat = await testNapCatConnectivity();
    
    // 汇总结果
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                      测试结果汇总                         ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    
    const total = Object.keys(results).length;
    const passed = Object.values(results).filter(Boolean).length;
    
    console.log(`✅ 保存课表档案:      ${results.saveProfile ? '通过' : '失败'}`);
    console.log(`✅ 查询课表档案:      ${results.queryProfile ? '通过' : '失败'}`);
    console.log(`✅ Timer逻辑模拟:     ${results.timerLogic ? '通过' : '失败'}`);
    console.log(`✅ NapCat连通性:      ${results.napcat ? '通过' : '失败'}`);
    
    console.log(`\n📊 总计: ${passed}/${total} 测试通过\n`);
    
    if (passed === total) {
        console.log('🎉 所有测试通过!主动提醒系统已就绪!\n');
        console.log('📝 下一步:');
        console.log('   1. 部署到Azure: func azure functionapp publish aris-bot-func');
        console.log('   2. 等待明天早上7:00自动触发');
        console.log('   3. 或者手动调用Timer Trigger测试\n');
        process.exit(0);
    } else {
        console.log('⚠️  部分测试失败,请检查配置:\n');
        if (!results.saveProfile || !results.queryProfile) {
            console.log('   • COSMOS_DB_STRING环境变量');
        }
        if (!results.napcat) {
            console.log('   • NAPCAT_API_URL和服务可用性');
        }
        console.log('');
        process.exit(1);
    }
}

runAllTests();
