// Cosmos DB查询测试 - 检查schedule_profile数据
const { CosmosClient } = require("@azure/cosmos");

async function testCosmosQuery() {
    console.log("📊 开始查询Cosmos DB中的schedule_profile数据...\n");
    
    const cosmosString = process.env.COSMOS_DB_STRING;
    if (!cosmosString) {
        console.error("❌ 错误: COSMOS_DB_STRING 环境变量未设置");
        return;
    }

    try {
        const client = new CosmosClient(cosmosString);
        const db = client.database("aris-bot-db");
        const container = db.container("chatHistory");

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
