// Cosmos DB查询测试 - 检查schedule_profile数据
const { CosmosClient } = require("@azure/cosmos");
const fs = require('fs');
const path = require('path');

function getCosmosConnString() {
    let cosmosString = process.env.COSMOS_DB_STRING;
    if (cosmosString) return cosmosString;

    try {
        const settingsPath = path.join(__dirname, '..', 'local.settings.json');
        if (fs.existsSync(settingsPath)) {
            const raw = fs.readFileSync(settingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            cosmosString = parsed?.Values?.COSMOS_DB_STRING;
        }
    } catch {
        // ignore
    }
    return cosmosString;
}

async function testCosmosQuery() {
    console.log("📊 开始查询Cosmos DB中的schedule_profile数据...\n");
    
    const cosmosString = getCosmosConnString();
    if (!cosmosString) {
        console.error("❌ 错误: COSMOS_DB_STRING 未配置（环境变量或 local.settings.json Values.COSMOS_DB_STRING）");
        return;
    }

    try {
        const client = new CosmosClient(cosmosString);
        const dbId = process.env.COSMOS_DATABASE_ID || 'BotDB';
        const containerId = process.env.COSMOS_CONTAINER_ID || 'Conversations';
        const db = client.database(dbId);
        const container = db.container(containerId);

        // 查询所有schedule_profile类型的文档
        const query = {
            query: "SELECT * FROM c WHERE c.type = 'schedule_profile'"
        };

        const { resources } = await container.items.query(query).fetchAll();
        
        console.log(`✅ 找到 ${resources.length} 个课表配置文件\n`);
        
        if (resources.length === 0) {
            console.log("⚠️  还没有保存的课表数据");
            console.log("💡 请先向QQ机器人发送超星课表链接或上传课表截图");
        } else {
            resources.forEach((profile, index) => {
                console.log(`\n========== 课表配置 #${index + 1} ==========`);
                console.log(`用户ID: ${profile.partitionKey}`);
                console.log(`学期: ${profile.schedule_config.semester}`);
                console.log(`总课程数: ${profile.schedule_config.total_courses}`);
                console.log(`数据源: ${profile.schedule_config.source_url}`);
                console.log(`最后更新: ${profile.schedule_config.last_updated}`);
                console.log(`\n每周课表:`);
                
                const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
                profile.weekly_schedule.forEach(course => {
                    console.log(`  ${weekdayNames[course.day]} 第${course.start}节: ${course.name}`);
                    console.log(`    时间: ${course.timeStart}-${course.timeEnd}`);
                    console.log(`    地点: ${course.location}`);
                    if (course.teacher) {
                        console.log(`    教师: ${course.teacher}`);
                    }
                });
            });
        }

    } catch (error) {
        console.error("❌ 查询失败:", error.message);
    }
}

// 运行测试
testCosmosQuery().catch(console.error);
