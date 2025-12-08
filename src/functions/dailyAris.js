const { app } = require('@azure/functions');
const { OpenAI } = require("openai");

// 每日早安任务 (Daily Greeting - AI 生成版)
// 触发时间: 每天北京时间早上 8:00 (UTC 0:00)
// 注意: Azure Functions 的 NCRONTAB 默认是 UTC 时间
// 0 0 0 * * * = UTC 0:00 = 北京时间 8:00

app.timer('dailyAris', {
    schedule: '0 0 0 * * *', 
    handler: async (myTimer, context) => {
        context.log('[早安任务] 定时器触发');
        
        // TODO: 填入你的 NapCat HTTP API 地址
        const NAPCAT_API_URL = process.env.NAPCAT_API_URL || "http://YOUR_NAPCAT_IP:3000";
        
        // TODO: 填入你想发送早安的群号列表
        const TARGET_GROUPS = [123456789]; 

        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        if (NAPCAT_API_URL.includes("YOUR_NAPCAT_IP")) {
            context.log("[错误] 请先配置 NAPCAT_API_URL 环境变量！");
            return;
        }

        // === A. 动态早安内容生成 ===
        let greetingMsg = "邦邦咔邦！Sensei，早上好！(✨ω✨)"; // Fallback
        
        try {
            // 1. 获取当前时间和星期
            const now = new Date();
            const bjTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
            const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            const dayOfWeek = weekDays[bjTime.getDay()];
            const dateStr = `${bjTime.getMonth()+1}月${bjTime.getDate()}日`;

            // 2. 获取天气信息 (简化版，只查北京)
            let weatherHint = "";
            try {
                const geoRes = await fetch("https://geocoding-api.open-meteo.com/v1/search?name=北京&count=1&language=zh&format=json");
                const geoData = await geoRes.json();
                if (geoData.results && geoData.results[0]) {
                    const { latitude, longitude } = geoData.results[0];
                    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&timezone=Asia/Shanghai`);
                    const weatherData = await weatherRes.json();
                    const temp = Math.round(weatherData.current_weather.temperature);
                    const weatherCode = weatherData.current_weather.weathercode;
                    
                    // 简化天气描述
                    let weatherDesc = "晴天";
                    if (weatherCode >= 61 && weatherCode <= 67) weatherDesc = "下雨";
                    else if (weatherCode >= 71 && weatherCode <= 77) weatherDesc = "下雪";
                    else if (weatherCode >= 80) weatherDesc = "雷暴";
                    
                    weatherHint = `今天${weatherDesc}，气温${temp}°C。`;
                }
            } catch (err) {
                context.log(`[天气查询] 失败: ${err.message}`);
            }

            // 3. 调用 AI 生成个性化早安
            if (GITHUB_TOKEN) {
                const client = new OpenAI({
                    baseURL: "https://models.inference.ai.azure.com",
                    apiKey: GITHUB_TOKEN
                });

                const prompt = `你是爱丽丝，今天是${dateStr}${dayOfWeek}。${weatherHint ? weatherHint : ''}
请用爱丽丝的语气生成一条简短(不超过40字)的早安消息。要求：
1. 必须提到今天是星期几
2. 如果有天气信息，自然融入
3. 用颜文字表达情感（如 (✨ω✨)、(≧∇≦)/ ）
4. 语气活泼，像RPG游戏NPC
5. 自称"爱丽丝"，不要说"我"

示例：
- "邦邦咔邦！${dayOfWeek}来啦！爱丽丝已经准备好新任务了！(｀・ω・´)ゞ"
- "${dayOfWeek}的Boss战！${weatherHint}记得带装备哦！"`;

                const response = await client.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "你是天童爱丽丝，千年科技学园的机器人勇者。" },
                        { role: "user", content: prompt }
                    ],
                    temperature: 1.2,
                    max_tokens: 100
                });

                greetingMsg = response.choices[0].message.content.trim();
                context.log(`[AI早安] 生成成功: ${greetingMsg}`);
            } else {
                // 无 Token 时使用模板生成
                const templates = [
                    `邦邦咔邦！${dayOfWeek}的任务开始了！${weatherHint}Sensei加油！(✨ω✨)`,
                    `${dayOfWeek}早上好！${weatherHint}今天也要元气满满！(≧∇≦)/`,
                    `检测到${dayOfWeek}！${weatherHint}爱丽丝已准备就绪！(｀・ω・´)ゞ`
                ];
                greetingMsg = templates[Math.floor(Math.random() * templates.length)];
            }

        } catch (err) {
            context.log(`[AI生成] 失败: ${err.message}，使用默认消息`);
        }

        // === 发送消息到各个群 ===
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
                context.log(`[早安任务] 群 ${groupId} 发送成功`);
            } catch (err) {
                context.log(`[早安任务] 群 ${groupId} 发送失败: ${err.message}`);
            }
        }
    }
});
