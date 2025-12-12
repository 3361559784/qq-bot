const { app } = require('@azure/functions');
const { CosmosClient } = require("@azure/cosmos");

// ==========================================
// 配置
// ==========================================
const NAPCAT_API_URL = process.env["NAPCAT_API_URL"] || 'http://4.230.25.38:6009';
const NAPCAT_TOKEN = process.env["NAPCAT_TOKEN"] || '';
const cosmosString = process.env["COSMOS_DB_STRING"];

let cosmosContainer = null;
if (cosmosString) {
    const client = new CosmosClient(cosmosString);
    const db = client.database("aris-bot-db");
    cosmosContainer = db.container("chatHistory");
}

// ==========================================
// NapCat主动消息发送
// ==========================================
async function sendPrivateMsg(userId, message, context) {
    try {
        const url = `${NAPCAT_API_URL}/send_private_msg`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${NAPCAT_TOKEN}`
            },
            body: JSON.stringify({
                user_id: userId,
                message: message
            })
        });
        
        if (!response.ok) {
            context.log(`[NapCat] 发送失败: HTTP ${response.status}`);
            return false;
        }
        
        const result = await response.json();
        context.log(`[NapCat] ✅ 消息已发送给 ${userId}`);
        return true;
        
    } catch (err) {
        context.log(`[NapCat] ❌ 发送异常: ${err.message}`);
        return false;
    }
}

// ==========================================
// 获取所有绑定课表的用户
// ==========================================
async function getAllUsersWithSchedule(context) {
    if (!cosmosContainer) {
        context.log('[DailyReminder] Cosmos容器未初始化');
        return [];
    }
    
    try {
        const query = {
            query: "SELECT * FROM c WHERE c.type = 'schedule_profile' AND ARRAY_LENGTH(c.weekly_schedule) > 0"
        };
        
        const { resources } = await cosmosContainer.items.query(query).fetchAll();
        context.log(`[DailyReminder] 找到 ${resources.length} 个用户档案`);
        return resources;
        
    } catch (err) {
        context.log(`[DailyReminder] 查询失败: ${err.message}`);
        return [];
    }
}

// ==========================================
// 获取北京时间周几 (1=周一, 7=周日)
// ==========================================
function getBeijingWeekday() {
    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const beijingTime = new Date(utcTime + (8 * 3600000));
    
    // JavaScript的getDay(): 0=周日, 1=周一...6=周六
    // 转换为: 1=周一, 7=周日
    const day = beijingTime.getDay();
    return day === 0 ? 7 : day;
}

// ==========================================
// 格式化课程提醒消息
// ==========================================
function formatClassReminder(courses) {
    if (courses.length === 0) {
        return '(轻松) 今天没有安排课程哦！可以好好休息！✨';
    }
    
    // 按开始时间排序
    courses.sort((a, b) => {
        const timeA = parseInt(a.timeStart.replace(':', ''));
        const timeB = parseInt(b.timeStart.replace(':', ''));
        return timeA - timeB;
    });
    
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
// Timer Trigger 主函数
// ==========================================
/*
app.timer('dailyClassReminder', {
    // Cron表达式: 秒 分 时 日 月 周
    // "0 0 23 * * *" = 每天 UTC 23:00 (北京时间 07:00)
    schedule: '0 0 23 * * *',
    handler: async (myTimer, context) => {
        context.log('╔════════════════════════════════════════╗');
        context.log('║  Aris 每日课表提醒服务启动           ║');
        context.log('╚════════════════════════════════════════╝');
        
        const beijingTime = new Date(Date.now() + 8 * 3600000);
        context.log(`[DailyReminder] 当前北京时间: ${beijingTime.toISOString()}`);
        
        // 1. 获取今天是周几
        const todayWeekday = getBeijingWeekday();
        const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        context.log(`[DailyReminder] 今天是: ${weekdayNames[todayWeekday]} (${todayWeekday})`);
        
        // 2. 获取所有有课表的用户
        const users = await getAllUsersWithSchedule(context);
        
        if (users.length === 0) {
            context.log('[DailyReminder] 没有找到用户课表档案,结束运行');
            return;
        }
        
        // 3. 遍历用户,发送今日课表提醒
        let sentCount = 0;
        let skipCount = 0;
        
        for (const user of users) {
            try {
                // 筛选今天的课程
                const todayClasses = user.weekly_schedule.filter(c => c.day === todayWeekday);
                
                context.log(`[DailyReminder] 用户 ${user.userId}: ${todayClasses.length} 节课`);
                
                // 即使没课也发提醒(让用户知道Aris在关心他)
                const message = formatClassReminder(todayClasses);
                const success = await sendPrivateMsg(user.userId, message, context);
                
                if (success) {
                    sentCount++;
                } else {
                    skipCount++;
                }
                
                // 防止频繁发送触发限流
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (err) {
                context.log(`[DailyReminder] 处理用户 ${user.userId} 失败: ${err.message}`);
                skipCount++;
            }
        }
        
        context.log('╔════════════════════════════════════════╗');
        context.log(`║  提醒服务完成                         ║`);
        context.log(`║  ✅ 成功: ${sentCount.toString().padStart(3)} 条`);
        context.log(`║  ⏭️  跳过: ${skipCount.toString().padStart(3)} 条`);
        context.log('╚════════════════════════════════════════╝');
    }
});
*/
