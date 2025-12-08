const { app } = require('@azure/functions');

// 每日早安任务 (Daily Greeting)
// 触发时间: 每天北京时间早上 8:00 (UTC 0:00)
// 注意: Azure Functions 的 NCRONTAB 默认是 UTC 时间
// 0 0 0 * * * = UTC 0:00 = 北京时间 8:00

app.timer('dailyAris', {
    schedule: '0 0 0 * * *', 
    handler: async (myTimer, context) => {
        context.log('Timer function processed request.');
        
        // TODO: 填入你的 NapCat HTTP API 地址
        // 例如: http://1.2.3.4:3000/send_group_msg
        const NAPCAT_API_URL = process.env.NAPCAT_API_URL || "http://YOUR_NAPCAT_IP:3000";
        
        // TODO: 填入你想发送早安的群号列表
        const TARGET_GROUPS = [123456789]; 

        const greetingMsg = "邦邦咔邦！Sensei，早上好！(✨ω✨) 新的一天开始了，今天的任务也要加油哦！";

        if (NAPCAT_API_URL.includes("YOUR_NAPCAT_IP")) {
            context.log("请先配置 NAPCAT_API_URL 环境变量或修改代码！");
            return;
        }

        for (const groupId of TARGET_GROUPS) {
            try {
                const res = await fetch(`${NAPCAT_API_URL}/send_group_msg`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        group_id: groupId,
                        message: greetingMsg
                    })
                });
                const data = await res.json();
                context.log(`[早安任务] 群 ${groupId} 发送结果: ${JSON.stringify(data)}`);
            } catch (err) {
                context.log(`[早安任务] 群 ${groupId} 发送失败: ${err.message}`);
            }
        }
    }
});
