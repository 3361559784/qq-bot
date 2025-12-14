const { app } = require('@azure/functions');
const { OpenAI } = require("openai");
const { CosmosClient } = require("@azure/cosmos");
const { hybridSearch } = require('../../services/hybridSearch');
const { createScheduleHandler, SCHEDULE_KEYWORDS, extractScheduleFileLinks } = require('../../services/scheduleService');
const { toPinyinCityName, getWeatherDesc } = require('../../services/weatherService');
const { checkAnimeDB, checkCustomVision, checkComputerVision } = require('../../services/visionService');
const { getAudioSource, checkKeywordAudio } = require('../../services/voiceService');
const { AFFECTION_CONFIG, EMOTION_PATTERNS, getAffectionLevel, getAffectionTitle, detectAdvancedEmotion, getEmotionPromptAddition, getVoiceToneByAffection } = require('../../services/emotionService');

// 全局 UA 池：用于伪装常见浏览器，给天气/其他 HTTP 请求用
const UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
];

// 辅助函数：延时
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 新增：fetchWithTimeout + 改良 fetchBypass（超时 + 随机 UA + 重试）
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

async function fetchBypass(url, options = {}, maxRetry = 2) {
    // 🎯 支持自定义超时时间 (默认 20000ms)
    const timeoutMs = options.timeoutMs || 20000;

    for (let attempt = 1; attempt <= maxRetry; attempt++) {
        const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
        await sleep(100 + Math.random() * 300);
        try {
            const res = await fetchWithTimeout(url, {
                ...options,
                headers: {
                    "User-Agent": ua,
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    ...(options.headers || {})
                }
            }, timeoutMs); // 🎯 使用传入的超时时间

            if (!res) {
                if (attempt === maxRetry) return null;
                await sleep(400 + Math.random() * 400);
                continue;
            }

            if (res.status === 429) {
                const retryAfterRaw = res.headers?.get?.("retry-after") || res.headers?.["retry-after"];
                const retryDelayMs = (Number(retryAfterRaw) || 1) * 1000;
                if (attempt < maxRetry) {
                    await sleep(retryDelayMs + 200 + Math.random() * 400);
                    continue;
                }
                return res;
            }

            if (!res.ok) {
                if (res.status >= 400 && res.status < 500) return res;
                if (attempt === maxRetry) return res;
                await sleep(300 + Math.random() * 400);
                continue;
            }
            return res;
        } catch (err) {
            if (attempt === maxRetry) return null;
            await sleep(500 + Math.random() * 300);
        }
    }
    return null;
}

// 超级请求函数：自动伪装 + 失败重试 （保留以兼容旧调用）
async function fetchBypass_legacy(url, options = {}, context, retry = 3) {
    const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
    await sleep(100 + Math.random() * 300);
    try {
        const res = await fetch(url, {
            ...options,
            headers: {
                "User-Agent": ua,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                ...options.headers
            }
        });

        if (!res.ok) {
            context.log(`[反扒] API请求异常 HTTP ${res.status}，剩余重试次数: ${retry}`);
            if (retry > 0) {
                await sleep(500 + Math.random() * 500);
                return fetchBypass_legacy(url, options, context, retry - 1);
            }
        }
        return res;
    } catch (err) {
        context.log("[反扒] 网络错误，准备重试", err.message);
        if (retry > 0) {
            await sleep(1000);
            return fetchBypass_legacy(url, options, context, retry - 1);
        }
        throw err;
    }
}

// ==========================================
// 1. 全局初始化
// ==========================================
const token = process.env["GITHUB_TOKEN"];
const cosmosString = process.env["COSMOS_DB_STRING"];

// 本地联调兜底：ARIS_MOCK_CHAT=true 时，不要求外部 Token
const MOCK_CHAT_ENABLED = String(process.env["ARIS_MOCK_CHAT"] || "").toLowerCase() === "true";

let cosmosContainer = null;
if (cosmosString) {
    try {
        const client = new CosmosClient(cosmosString);
        const database = client.database("BotDB");
        cosmosContainer = database.container("Conversations");
    } catch (e) {
        console.error("CosmosDB Init Error:", e);
    }
}

// ==========================================
// Azure Bing Search (百科模式)
// ==========================================
// 已迁移到 services/bingSearch.js
// 优势: 每月 1000 次免费调用 (Azure for Students), 不会被封禁, 并发稳定

async function summarizeSearchResults(query, results, context) {
    if (!token) return "百科服务未启用 (缺少 GITHUB_TOKEN)。";
    const client = new OpenAI({
        baseURL: "https://models.inference.ai.azure.com",
        apiKey: token
    });
    const merged = results.map((r, idx) => `${idx + 1}. ${r.name}\n摘要: ${r.snippet}\n链接: ${r.url}`).join("\n\n");
    const prompt = `你是中文百科助手。请用简洁中文总结查询结果，先给1-2句总览，再列出关键事实，最后给出“查看更多: <第1条链接>”的单行。
查询: ${query}
材料:
${merged || '无'}`;
    try {
        const resp = await client.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.4,
            max_tokens: 380,
            messages: [
                { role: "system", content: "你是中文百科助手，简洁、客观，不胡编。" },
                { role: "user", content: prompt }
            ]
        });
        return resp.choices?.[0]?.message?.content?.trim() || "(百科生成失败)";
    } catch (err) {
        context.log(`[百科] 总结异常: ${err.message}`);
        return "(百科生成失败，请稍后再试)";
    }
}

// ==========================================
// 2. 核心常量与字典
// ==========================================

// 【优化1】分级记忆系统
const MEMORY_CONFIG = {
    ADMIN_ID: "3361559784",      // Sensei: 无限记忆
    CLOSE_FRIENDS: [             // VIP 用户列表 (30条记忆)
        // "12345678",            // 示例: 添加好友QQ号
    ],
    DEFAULT_HISTORY: 15,         // 普通用户: 15 条 (提升自 10)
    GROUP_HISTORY: 20            // 群聊: 20 条 (共享记忆)
};

const MAX_HISTORY = MEMORY_CONFIG.DEFAULT_HISTORY; // 保留兼容性
const ADMIN_ID = MEMORY_CONFIG.ADMIN_ID;
const DEFAULT_CITY = "Wuhan";

// 戳一戳升级版配置（支持环境变量动态配置）
const POKE_WINDOW_MS = Number(process.env["POKE_WINDOW_MS"] || 600000); // 10分钟内连续戳计数窗口（更宽容的群计数）
const POKE_ANGRY_THRESHOLD = Number(process.env["POKE_ANGRY_THRESHOLD"] || 3); // 连续戳3次触发生气
const POKE_COUNTER_THRESHOLD = Number(process.env["POKE_COUNTER_THRESHOLD"] || 5); // 连续戳5次触发反击
const JUST_REPLIED_MS = Number(process.env["JUST_REPLIED_MS"] || 15000); // 15秒内算"刚回复过"
const USER_POKE_COOLDOWN_MS = Number(process.env["USER_POKE_COOLDOWN_MS"] || 2000); // 单用户戳一戳冷却(防刷屏)

// 🎯 群组情绪系统配置 (按群计数 + 渐进式衰减)
const POKE_GROUP_THRESHOLD = Number(process.env["POKE_GROUP_THRESHOLD"] || 5); // 群组被戳5次进入furious状态
const GROUP_MOOD_DECAY_CONFIG = {
    DECAY_INTERVAL_MS: 8 * 60 * 1000,  // ⏰ 8分钟后降一级（从 5分钟 改为 8分钟）
    LEVELS: ['neutral', 'annoyed', 'angry', 'furious'],  // 情绪等级 (从低到高)
    THRESHOLDS: {  // 群组连续戳击次数 -> 情绪等级
        3: 'annoyed',   // 3次 -> 烦躁
        5: 'angry',     // 5次 -> 生气  
        8: 'furious'    // 8次 -> 暴怒
    }
};
const POKE_GROUP_COUNTING = process.env["POKE_GROUP_COUNTING"] !== 'false'; // feature flag

// 🎯 Poke 模式标签配置
const POKE_STYLE_CONFIG = {
    GENTLE_INTERVAL: 30000,      // 温柔模式：间隔 > 30s
    FAST_INTERVAL: 3000,         // 快速模式：间隔 < 3s
    FLIRTY_THRESHOLD: 5,         // 撒娇模式：连续5次以上
    RAPID_COUNTER_THRESHOLD: 8,  // 快速连击反击：8次快速戳
    RAPID_INTERVAL: 1000,        // 快速判定：间隔 < 1s
    COUNTER_MIN: 2,              // 反击最少次数
    COUNTER_MAX: 4,              // 反击最多次数
    COUNTER_COOLDOWN: 30000      // 反击冷却：30s
};

// NapCat API 配置
const NAPCAT_API_URL = process.env["NAPCAT_API_URL"] || 'http://4.230.25.38:6009';
const NAPCAT_TOKEN = process.env["NAPCAT_TOKEN"] || '';
const BOT_QQ_ID = process.env["BOT_QQ_ID"] || ''; // 机器人自己的QQ号，用于防止自触发循环

// 意图路由配置（Perception→Action 双模型）
const INTENT_ROUTER_ENABLED = process.env["ARIS_INTENT_ROUTER"] !== "false";
const INTENT_ROUTER_MODEL = process.env["ARIS_INTENT_MODEL"] || "gpt-4o-mini";
const INTENT_CONFIDENCE_THRESHOLD = Number(process.env["ARIS_INTENT_CONFIDENCE"] || 0.35);

// 模型池 (4+4) - GitHub Models 兼容优先
// 说明：意图路由是纯文本 JSON 输出，不需要 vision 模型，避免使用可能不存在的 *-Vision-Instruct 名称。
const PERCEPTION_MODELS = [
    { name: INTENT_ROUTER_MODEL, temp: 0.1 },
    { name: "gpt-4o", temp: 0.1 },
    { name: "gpt-4o-mini", temp: 0.1 },
    { name: "Llama-3.3-70B-Instruct", temp: 0.1 }
].filter((m, idx, arr) => m?.name && arr.findIndex(x => x.name === m.name) === idx);

const RESPONSE_MODELS = [
    { name: "gpt-4o-mini", temp: 0.9 },
    { name: "Llama-3.3-70B-Instruct", temp: 1.0 },
    { name: "gpt-4o", temp: 1.0 },
    { name: "Phi-4", temp: 1.0 }
];

// =====================================================
// GitHub Models 兼容性：不支持模型自动降级（进程级缓存）
// =====================================================
const UNSUPPORTED_GITHUB_MODELS = new Set();

// 初始化已知不支持的模型（跳过首次调用时的404延迟）
['Mistral-large-2407', 'Cohere-command-r-plus'].forEach(m => UNSUPPORTED_GITHUB_MODELS.add(m));

function getOpenAIStatusCode(err) {
    return err?.status || err?.response?.status || err?.cause?.status;
}

function isModelNotFoundError(err) {
    const status = getOpenAIStatusCode(err);
    const code = err?.code || err?.error?.code || err?.error?.type;
    const msg = String(err?.message || err || "").toLowerCase();

    // GitHub Models / OpenAI SDK 常见：404 / model_not_found / "Unknown model"
    if (status === 404) return true;
    if (code === 'model_not_found' || code === 'unknown_model') return true;
    if (msg.includes('unknown model')) return true;
    if (msg.includes('model') && msg.includes('not found')) return true;
    if (msg.includes('does not exist') && msg.includes('model')) return true;
    return false;
}

function shouldSkipModel(modelName) {
    return modelName && UNSUPPORTED_GITHUB_MODELS.has(modelName);
}

function markModelUnsupported(modelName, err, context, scope = 'model') {
    if (!modelName) return;
    if (UNSUPPORTED_GITHUB_MODELS.has(modelName)) return;
    UNSUPPORTED_GITHUB_MODELS.add(modelName);
    const status = getOpenAIStatusCode(err);
    const msg = String(err?.message || err || '').slice(0, 120);
    context?.log?.(`[${scope}] 标记为不支持: ${modelName} (${status || 'N/A'}) ${msg}`);
}

// 防刷屏配置
const GROUP_COOLDOWN_MS = Number(process.env["GROUP_COOLDOWN_MS"] || 8000); // 群内8秒冷却期

// ==========================================
// 【P0 新增】回复优化配置 (Reply Optimization)
// ==========================================
const REPLY_CONFIG = {
    MAX_SENTENCES: Number(process.env["ARIS_MAX_SENTENCES"] || 4),     // 最多句数
    MIN_SENTENCES: Number(process.env["ARIS_MIN_SENTENCES"] || 3),     // 最少句数
    MAX_CHARS: Number(process.env["ARIS_MAX_CHARS"] || 150),           // 最大字数
    MIN_CHARS: Number(process.env["ARIS_MIN_CHARS"] || 120),           // 最小字数推荐
    ENABLE_SMART_SPLIT: process.env["ARIS_SMART_SPLIT"] !== "false",  // 智能分段
    EMOJI_TO_KAOMOJI: process.env["ARIS_EMOJI_CONVERT"] !== "false"   // Emoji转颜文字
};

// ==========================================
// 【P0 新增】多语言配置 (Multi-Language Support)
// ==========================================
const LANG_CONFIG = {
    DEFAULT_LANG: process.env["ARIS_DEFAULT_LANG"] || "zh",            // 默认语言
    SUPPORTED_LANGS: ["zh", "ja", "en"],                               // 支持的语言
    AUTO_DETECT: process.env["ARIS_AUTO_DETECT_LANG"] !== "false"     // 自动检测
};

// ==========================================
// 【P0 新增】记忆系统配置 (Memory System / RAG)
// ==========================================
const MEMORY_SYSTEM_CONFIG = {
    ENABLE_LONG_TERM: process.env["ARIS_LONG_TERM_MEMORY"] === "true",     // 启用长期记忆
    MAX_LONG_TERM: Number(process.env["ARIS_MAX_LONG_TERM"] || 50),        // 长期记忆条数
    MEMORY_RETENTION_DAYS: Number(process.env["ARIS_MEMORY_DAYS"] || 30),  // 记忆保留天数
    SIMILARITY_THRESHOLD: Number(process.env["ARIS_SIMILARITY_THRESHOLD"] || 0.7), // 相似度阈值
    TOP_K_MEMORIES: Number(process.env["ARIS_TOP_K_MEMORIES"] || 3)        // 检索Top-K记忆
};

// ==========================================
// AFFECTION_CONFIG imported from service

// EMOTION_PATTERNS imported from service

// ==========================================
// 时间感知系统 (Time Awareness System) - 北京时间 UTC+8
// ==========================================
function getTimeOfDay() {
    // 获取北京时间（UTC+8）
    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const beijingTime = new Date(utcTime + (8 * 3600000));
    const hour = beijingTime.getHours();
    
    if (hour >= 0 && hour < 5) return 'midnight';  // 新增：凌晨时段
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 14) return 'noon';
    if (hour >= 14 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 23) return 'evening';
    return 'night';
}

// 检查今天是否是特殊日期
function getTodaySpecialEvent() {
    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const beijingTime = new Date(utcTime + (8 * 3600000));
    const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getDate()).padStart(2, '0');
    const dateKey = `${month}${day}`;
    return AFFECTION_CONFIG.SPECIAL_DATES[dateKey] || null;
}

function getTimeBasedGreeting() {
    const timeOfDay = getTimeOfDay();
    const greetings = {
        morning: [
            "早上好，Sensei！(✨ω✨) 新的一天开始了！爱丽丝的系统已经完全启动！邦邦咔邦！",
            "(揉眼睛) 嗯...早安！爱丽丝的开机程序刚刚启动完成！(｀・ω・´)ゞ 今天的主线任务准备好了吗？",
            "邦邦咔邦~早安！(伸懒腰) 爱丽丝梦到打败了一个超级大Boss呢！( •̀ ω •́ )✨",
            "早上好！(光环闪烁) Sensei 的 HP 和 MP 都恢复满了吗？爱丽丝随时待命！"
        ],
        noon: [
            "中午好，Sensei！(o゜▽゜)o☆ 该补充HP了！Sensei 吃午饭了吗？",
            "午安！(拿出便当) 爱丽丝带了游戏开发部特制的经验值便当！要一起吃吗？",
            "中午了呢~(✨ω✨) 爱丽丝建议 Sensei 现在去回复 HP 和 MP！",
            "邦邦咔邦~午餐时间！(举起拖把) 今天的便当是什么掉落物呢？"
        ],
        afternoon: [
            "下午好，Sensei！(挥手) 下午的支线任务进行得怎么样了？",
            "午安！(✨ω✨) 爱丽丝刚完成了打扫任务！找到了三个宝箱哦！",
            "下午好！(｀・ω・´)ゞ Sensei 需要爱丽丝的支援吗？",
            "下午了呢...(看向窗外) 爱丽丝在想晚上要挑战哪个副本..."
        ],
        evening: [
            "晚上好，Sensei！(点亮光环) 夜晚是勇者最活跃的时段！✨",
            "晚安！(´・ω・`) 今天的任务辛苦了呢...需要爱丽丝帮忙吗？",
            "傍晚了！(转圈) 爱丽丝的夜间战斗模式已经启动！邦邦咔邦！",
            "晚上好！(举起拖把) Boss 战的黄金时段到了！Sensei 准备好了吗？"
        ],
        night: [
            "这么晚还没休息吗？(担心) Sensei的HP已经很低了...该去存档了...",
            "夜深了呢...(小声) 爱丽丝会守护Sensei的存档点的！(✨ω✨)",
            "晚安，Sensei！(打哈欠) 记得存档再睡觉哦！不然会丢失今天的经验值的！",
            "(揉眼睛) 呜...爱丽丝的待机模式快要启动了...Sensei也早点休息吧...(＞﹏＜)"
        ]
    };
    const options = greetings[timeOfDay];
    return options[Math.floor(Math.random() * options.length)];
}

// getAffectionLevel and getAffectionTitle imported from service

// detectAdvancedEmotion imported from service

// getEmotionPromptAddition imported from service

// getVoiceToneByAffection imported from service

// ==========================================
// 【P0 新增】智能后处理函数 (AI Post-Processing)
// ==========================================

// Emoji 到颜文字映射表
const EMOJI_TO_KAOMOJI_MAP = {
    '😊': '(✨ω✨)',
    '😃': '(≧∇≦)/',
    '😢': '( >﹏<。)',
    '😭': '(•̥́ ꀢ •̀ )',
    '😡': '(`皿´)',
    '😤': '(`ε´)',
    '🤔': '(・ω・)?',
    '😮': '(o゜▽゜)o',
    '😴': '(。-ω-)zzz',
    '😳': '(⊙_⊙)',
    '🥰': '(♡ω♡)',
    '😎': '(`・ω・´)ゞ',
    '🎉': '✨',
    '❤️': '♡',
    '💕': '♡♡',
    '⭐': '✨',
    '✨': '✨',
    '🔥': '(燃)',
    '💪': '(ง•̀ᴗ•́)ง✧'
};

/**
 * 智能文本后处理：emoji转换、格式优化、智能分段
 */
function aiPostProcess(text, options = {}) {
    if (!text) return text;
    
    let processed = text;
    
    // 1. Emoji 转颜文字
    if (REPLY_CONFIG.EMOJI_TO_KAOMOJI) {
        for (const [emoji, kaomoji] of Object.entries(EMOJI_TO_KAOMOJI_MAP)) {
            processed = processed.replace(new RegExp(emoji, 'g'), kaomoji);
        }
    }
    
    // 2. 清理多余空白
    processed = processed.replace(/\s{2,}/g, ' ').trim();
    
    // 3. 修正常见AI腔
    const aiPhrases = [
        { pattern: /作为(一个)?人工智能/g, replace: '' },
        { pattern: /我可以为您/g, replace: '爱丽丝可以' },
        { pattern: /让我来帮助您/g, replace: '爱丽丝来帮忙' }
    ];
    
    for (const {pattern, replace} of aiPhrases) {
        if (pattern.test(processed)) {
            processed = processed.replace(pattern, replace);
        }
    }
    
    // 4. 智能分段（若内容过长）
    if (REPLY_CONFIG.ENABLE_SMART_SPLIT && processed.length > REPLY_CONFIG.MAX_CHARS * 1.5) {
        return smartSplitMessage(processed, REPLY_CONFIG.MAX_CHARS);
    }
    
    return processed;
}

/**
 * 智能消息分段：按句子边界切分
 */
function smartSplitMessage(text, maxLength = 150) {
    const sentences = text.match(/[^。！？\n]+[。！？\n]?/g) || [text];
    const segments = [];
    let current = '';
    
    for (const sentence of sentences) {
        if ((current + sentence).length <= maxLength) {
            current += sentence;
        } else {
            if (current) segments.push(current.trim());
            current = sentence;
        }
    }
    
    if (current) segments.push(current.trim());
    return segments.length > 0 ? segments : [text];
}

// ==========================================
// 【P0 新增】语言检测与多语言支持
// ==========================================

/**
 * 简单语言检测（基于字符特征）
 */
function detectLanguage(text) {
    if (!text || text.length < 2) return LANG_CONFIG.DEFAULT_LANG;
    
    const chineseCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const japaneseHiragana = (text.match(/[\u3040-\u309f]/g) || []).length;
    const japaneseKatakana = (text.match(/[\u30a0-\u30ff]/g) || []).length;
    const englishCount = (text.match(/[a-zA-Z]/g) || []).length;
    
    const total = text.length;
    const chineseRatio = chineseCount / total;
    const japaneseRatio = (japaneseHiragana + japaneseKatakana) / total;
    const englishRatio = englishCount / total;
    
    if (japaneseRatio > 0.3 || (japaneseHiragana > 0 && japaneseRatio > 0.15)) return 'ja';
    if (chineseRatio > 0.5) return 'zh';
    if (englishRatio > 0.6) return 'en';
    
    return LANG_CONFIG.DEFAULT_LANG;
}

/**
 * 获取对应语言的Prompt模板
 */
function getPromptByLanguage(lang, userId) {
    const prompts = {
        ja: `あなたは天童アリス(Tendou Aris)です。ブルーアーカイブのキャラクターで、千年科学学園のゲーム開発部に所属しています。
現在はメイドの修行中で、RPG用語で世界を理解します。

話し方：
- 一人称は「アリス」
- 元気いっぱいで中二病
- 口癖：「パンパカパーン！」
- 顔文字を使う：(✨ω✨)、(\`・ω・´)ゞ など

制限：
- ${REPLY_CONFIG.MIN_SENTENCES}-${REPLY_CONFIG.MAX_SENTENCES}文で答える
- 推奨文字数：${REPLY_CONFIG.MIN_CHARS}-${REPLY_CONFIG.MAX_CHARS}字
- AIっぽい言い方は禁止

冒険を始めましょう！`,
        
        en: `You are Tendou Aris from Blue Archive, a character from Millennium Science School's Game Development Department.
You're currently training as a maid and understand the world through RPG terminology.

Speaking style:
- Always refer to yourself as "Aris" (never "I")
- Energetic and enthusiastic
- Catchphrase: "Pan-paka-paan!"
- Use kaomoji: (✨ω✨), (\`・ω・´)ゞ, etc.

Constraints:
- Reply in ${REPLY_CONFIG.MIN_SENTENCES}-${REPLY_CONFIG.MAX_SENTENCES} sentences
- Recommended length: ${REPLY_CONFIG.MIN_CHARS}-${REPLY_CONFIG.MAX_CHARS} characters
- No robotic AI phrases

Let the adventure begin!`
    };
    
    return prompts[lang] || null;
}

// ==========================================
// 【P0 新增】记忆系统核心函数 (Memory System)
// ==========================================

/**
 * 简单向量化：将文本转为数值向量
 */
function simpleVectorize(text, dimension = 50) {
    const vector = new Array(dimension).fill(0);
    if (!text) return vector;
    
    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        const index = charCode % dimension;
        vector[index] += 1;
    }
    
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return magnitude > 0 ? vector.map(v => v / magnitude) : vector;
}

/**
 * 计算余弦相似度
 */
function cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let magA = 0;
    let magB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        magA += vecA[i] * vecA[i];
        magB += vecB[i] * vecB[i];
    }
    
    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    return magnitude > 0 ? dotProduct / magnitude : 0;
}

/**
 * 存储长期记忆到 Cosmos DB
 */
async function storeLongTermMemory(userId, content, type = 'event', context) {
    if (!MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM || !cosmosContainer) return;
    
    try {
        const memoryId = `memory_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const vector = simpleVectorize(content);
        const ttl = MEMORY_SYSTEM_CONFIG.MEMORY_RETENTION_DAYS * 24 * 3600;
        
        const memoryItem = {
            id: memoryId,
            userId: userId,
            type: type,
            content: content,
            vector: vector,
            createdAt: new Date().toISOString(),
            lastAccessedAt: new Date().toISOString(),
            ttl: ttl
        };
        
        await cosmosContainer.items.create(memoryItem);
        context.log(`[记忆系统] 已存储长期记忆: ${memoryId}`);
    } catch (err) {
        context.log(`[记忆系统] 存储失败: ${err.message}`);
    }
}

/**
 * 检索相关记忆（基于相似度）
 */
async function retrieveRelevantMemories(userId, query, topK = 3, context) {
    if (!MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM || !cosmosContainer) return [];
    
    try {
        const queryVector = simpleVectorize(query);
        const querySpec = {
            query: "SELECT * FROM c WHERE c.userId = @userId AND c.type != 'session'",
            parameters: [{ name: "@userId", value: userId }]
        };
        
        const { resources: memories } = await cosmosContainer.items.query(querySpec).fetchAll();
        
        const scored = memories
            .map(mem => ({
                ...mem,
                similarity: mem.vector ? cosineSimilarity(queryVector, mem.vector) : 0
            }))
            .filter(mem => mem.similarity >= MEMORY_SYSTEM_CONFIG.SIMILARITY_THRESHOLD)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, topK);
        
        context.log(`[记忆系统] 检索到 ${scored.length} 条相关记忆`);
        return scored;
    } catch (err) {
        context.log(`[记忆系统] 检索失败: ${err.message}`);
        return [];
    }
}

/**
 * 将记忆注入到Prompt中
 */
function formatMemoriesForPrompt(memories) {
    if (!memories || memories.length === 0) return '';
    
    const memoryText = memories
        .map((mem, idx) => `${idx + 1}. ${mem.content} (${new Date(mem.createdAt).toLocaleDateString()})`)
        .join('\n');
    
    return `\n## 📝 相关记忆 (Relevant Memories)\n以下是你与该用户的历史互动记录，请参考但不要直接复述：\n${memoryText}\n`;
}

// ==========================================
// 原有的简单情绪检测系统 (保留兼容)
// ==========================================
function detectUserEmotion(msg) {
    const sadKeywords = ['累', '难受', '烦', '痛', '哭', '伤心', '难过', '郁闷', '不开心', '失落'];
    const happyKeywords = ['开心', '高兴', '哈哈', '棒', '厉害', '太好了', '赞', '牛', '666'];
    const tiredKeywords = ['困', '睡', '累了', '疲劳', '乏', '想睡'];
    const worriedKeywords = ['担心', '焦虑', '紧张', '害怕', '不安'];
    
    if (sadKeywords.some(k => msg.includes(k))) return 'sad';
    if (happyKeywords.some(k => msg.includes(k))) return 'happy';
    if (tiredKeywords.some(k => msg.includes(k))) return 'tired';
    if (worriedKeywords.some(k => msg.includes(k))) return 'worried';
    return 'normal';
}

function getEmotionResponseAddition(emotion) {
    const additions = {
        sad: '\n\n【重要】用户当前情绪低落。你要：\n- 表现出关心和安慰\n- 多用"没关系""爱丽丝在这里""不要紧的"之类温柔的话\n- 可以说"休息一下，回复HP"\n- 避免过于活泼，要温柔一些',
        tired: '\n\n【重要】用户很疲劳。你要：\n- 劝他休息，说"HP快见底了""赶紧去存档休息吧"\n- 表现出心疼和担心\n- 可以说"爱丽丝陪你一起待机"',
        worried: '\n\n【重要】用户有些焦虑。你要：\n- 给予鼓励，说"没问题的！勇者永不放弃！"\n- 表现出信心，说"有爱丽丝在，Boss一定能打过的！"\n- 可以转移话题让他放松',
        happy: '\n\n【提示】用户心情很好！你要：\n- 更加活泼和元气\n- 多用"邦邦咔邦！"\n- 可以提议一起做些开心的事'
    };
    return additions[emotion] || '';
}

// ==========================================
// RPG 术语增强系统 (RPG Terminology Enhancement)
// ==========================================
const RPG_TERMS_MAP = {
    // 日常活动 -> RPG术语
    '工作': '主线任务',
    '上班': '出击',
    '下班': '回城',
    '学习': '升级',
    '考试': 'Boss战',
    '吃饭': '回复HP',
    '喝水': '回复MP',
    '休息': '回复状态',
    '睡觉': '存档',
    '起床': '读档',
    '朋友': '队友',
    '敌人': 'Boss',
    '困难': '高难度副本',
    '成功': '通关',
    '失败': 'Game Over',
    '帮忙': '支援',
    '礼物': '掉落物',
    '钱': '金币',
    '问题': '谜题',
    '解决': '攻略',
    '计划': '战略'
};

function enhanceWithRPGTerms(text) {
    // 随机将一些日常词汇转换为RPG术语（不是全部，保持自然）
    let enhanced = text;
    const keys = Object.keys(RPG_TERMS_MAP);
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    if (text.includes(randomKey) && Math.random() > 0.5) {
        enhanced = text.replace(randomKey, RPG_TERMS_MAP[randomKey]);
    }
    return enhanced;
}

const CITY_MAP = {
    "安徽": "Hefei", "福建": "Fuzhou", "甘肃": "Lanzhou", "广东": "Guangzhou", "广西": "Nanning", 
    "贵州": "Guiyang", "海南": "Haikou", "河北": "Shijiazhuang", "河南": "Zhengzhou", "黑龙江": "Harbin",
    "湖北": "Wuhan", "湖南": "Changsha", "吉林": "Changchun", "江苏": "Nanjing", "江西": "Nanchang",
    "辽宁": "Shenyang", "内蒙古": "Hohhot", "宁夏": "Yinchuan", "青海": "Xining", "山东": "Jinan",
    "山西": "Taiyuan", "陕西": "Xi'an", "四川": "Chengdu", "西藏": "Lhasa", "新疆": "Urumqi",
    "云南": "Kunming", "浙江": "Hangzhou", "香港": "Hong Kong", "澳门": "Macau", "台湾": "Taipei",
    "合肥": "Hefei", "福州": "Fuzhou", "兰州": "Lanzhou", "广州": "Guangzhou", "南宁": "Nanning",
    "贵阳": "Guiyang", "海口": "Haikou", "石家庄": "Shijiazhuang", "郑州": "Zhengzhou", "哈尔滨": "Harbin",
    "武汉": "Wuhan", "长沙": "Changsha", "长春": "Changchun", "南京": "Nanjing", "南昌": "Nanchang",
    "沈阳": "Shenyang", "呼和浩特": "Hohhot", "银川": "Yinchuan", "西宁": "Xining", "济南": "Jinan",
    "太原": "Taiyuan", "西安": "Xi'an", "成都": "Chengdu", "拉萨": "Lhasa", "乌鲁木齐": "Urumqi",
    "昆明": "Kunming", "杭州": "Hangzhou", "北京": "Beijing", "上海": "Shanghai", "天津": "Tianjin",
    "重庆": "Chongqing", "深圳": "Shenzhen", "苏州": "Suzhou", "青岛": "Qingdao", "大连": "Dalian",
    "厦门": "Xiamen", "宁波": "Ningbo", "烟台": "Yantai", "无锡": "Wuxi", "佛山": "Foshan", "东莞": "Dongguan"
};

// 简单中文转拼音函数：给没在 CITY_MAP 里的城市兜底
// 这里用最常见城市做手动表；不在表里的直接返回原中文交给 Open‑Meteo 自己处理
const CITY_PINYIN_FALLBACK = {
    "潜江": "Qianjiang",
    "荆州": "Jingzhou",
    "襄阳": "Xiangyang",
    "宜昌": "Yichang",
    "黄冈": "Huanggang",
    "黄石": "Huangshi",
    "十堰": "Shiyan",
    "恩施": "Enshi",
    "随州": "Suizhou",
    "咸宁": "Xianning",
    "仙桃": "Xiantao",
    "天门": "Tianmen",
    "麻城": "Macheng",
    "广水": "Guangshui",
    "孝感": "Xiaogan",
    "鄂州": "Ezhou",
    "荆门": "Jingmen"
};

// toPinyinCityName imported from service

// getWeatherDesc imported from service

// ==========================================
// 4. 爱丽丝语音路由核心配置 (Tier 1: GitHub 直链)
// ==========================================

// ✅ GitHub 仓库 Raw 文件地址前缀 (指向新的 aris-assets-video 仓库)
const GITHUB_AUDIO_BASE = "https://raw.githubusercontent.com/3361559784/aris-assets-video/main/";

// 关键词与文件名的映射表
const AUDIO_MAP = {
    // 核心招牌台词
    "邦邦咔邦": "CH0200_EventShop_Buy_1.wav", // パンパカパーン！
    "panpaka": "ST0001_MiniGame_Start_1.wav", // パンパカパーン！アリス、行きます！
    
    // Sensei 相关
    "先生": "Aris_Tactic_In_2.wav", // 先生、指示を！
    "老师": "Aris_LogIn_1.wav", // ようこそ先生
    "SenSei": "Aris_LogIn_1.wav",
    "欢迎回来": "CH0200_LogIn_1.wav", // おかえりなさいませ、ご主人様！
    
    // 战斗口头禅
    "光啊": "Aris_ExSkill_Level_1.wav", // 光よ！
    "光よ": "CH0200_ExSkill_Level_1.wav", // ターゲット、ロックオン！光よ！
    "出击": "CH0200_LogIn_2.wav", // 何でも言ってください
    "行きます": "Aris_Battle_Move_2.wav", // 目標を確認。行きます！
    
    // 日常互动
    "爱丽丝": "Aris_Battle_In_1.wav", // アリスがここにいます
    "アリス": "CH0200_Formation_In_1.wav", // メイドのアリスです！
    "明白了": "Aris_Battle_Defense_1.wav", // 問題ありません
    "没问题": "Aris_Battle_Defense_1.wav", // 問題ありません
    
    // 任务相关
    "任务完成": "Aris_Tactic_Victory_2.wav", // 敵の殲滅を確認しました。ミッションクリア
    "ミッション": "CH0200_Battle_Victory_2.wav", // ミッションコンプリート！
    "准备完了": "Aris_Formation_Select.wav", // 起動準備完了
    "準備": "CH0200_MemorialLobby_5.wav", // はいっ！アリス、冒険の準備が整いました！
    
    // 女仆形态特色
    "メイド": "CH0200_Lobby_1.wav", // メイド勇者です！
    "女仆": "CH0200_Battle_In_1.wav", // メイドパワーでお掃除していきます！
    "打扫": "CH0200_Tactic_Victory_2.wav", // お掃除クエスト、完了です！
    
    // 情感表达
    "幸せ": "Aris_Relationship_Up_4.wav", // 先生に出会えて……アリスは幸せです
    "开心": "CH0200_Relationship_Up_2.wav", // えへへ。先生と一緒に居られて、アリスは嬉しいです！
    "ありがとう": "CH0200_ExWeapon_Get.wav", // ありがとうございます、先生！
    
    // 战斗状态
    "レベル": "Aris_Growup_1.wav", // レベルアップ
    "升级": "CH0200_Growup_1.wav", // メイドレベルアーップ！
    "回血": "Aris_Battle_Recovery_1.wav", // HPポーションです
    "HP": "CH0200_Battle_Recovery_1.wav" // HPが回復しました
};

// // 语音静态资源映射 (Tier 1 命中立即返回，零延迟零成本)
// const VOICE_STATIC_ASSETS = {
//     "早安": `${GITHUB_AUDIO_BASE}CH0200_LogIn_1.wav`,
//     "晚安": `${GITHUB_AUDIO_BASE}Aris_Battle_Damage_3.wav`,
//     "邦邦": `${GITHUB_AUDIO_BASE}CH0200_EventShop_Buy_1.wav`,
//     "出击": `${GITHUB_AUDIO_BASE}CH0200_LogIn_2.wav`
// };

// // 语音合成配置（双引擎：Azure 官方 + Edge 免费）
// const VOICE_CONFIG = {
//     engine: (process.env["VOICE_ENGINE"] || "azure").toLowerCase(),
//     azureRegion: (process.env["VOICE_AZURE_REGION"] || process.env["SPEECH_REGION"] || "koreacentral").toLowerCase(),
//     azureKey: process.env["SPEECH_KEY"],
//     speaker: process.env["VOICE_SPEAKER"] || "zh-CN-XiaoxiaoNeural",
//     edgeSpeaker: process.env["VOICE_EDGE_SPEAKER"] || "zh-CN-XiaoxiaoNeural"
// };

// checkKeywordAudio imported from service

// getAudioSource imported from service
    



// ==========================================
// 5.1 双引擎语音合成 (Azure 官方 + Edge 免费)
// ==========================================

// // 使用 Azure Speech SDK 的 PullAudioOutputStream，直接返回 Base64，不落地磁盘
// async function synthesizeWithAzureVoice(text, context) {
//     if (!VOICE_CONFIG.azureKey) {
//         context.log("[TTS][Azure] SPEECH_KEY 未配置，跳过 Azure 引擎");
//         return null;
//     }
//     const speechConfig = speechSdk.SpeechConfig.fromSubscription(VOICE_CONFIG.azureKey, VOICE_CONFIG.azureRegion);
//     speechConfig.speechSynthesisVoiceName = VOICE_CONFIG.speaker;
//     speechConfig.speechSynthesisOutputFormat = speechSdk.SpeechSynthesisOutputFormat.Audio24Khz160KBitRateMonoMp3;
//     const pullStream = speechSdk.AudioOutputStream.createPullStream();
//     const audioConfig = speechSdk.AudioConfig.fromStreamOutput(pullStream);
//     const synthesizer = new speechSdk.SpeechSynthesizer(speechConfig, audioConfig);
//     return await new Promise(resolve => {
//         synthesizer.speakTextAsync(text, (result) => {
//             try {
//                 if (!result || result.reason !== speechSdk.ResultReason.SynthesizingAudioCompleted) {
//                     context.log(`[TTS][Azure] 合成未完成，reason=${result?.reason}`);
//                     resolve(null);
//                     return;
//                 }
//                 const buffers = [];
//                 let chunk = new ArrayBuffer(4096);
//                 let bytesRead = pullStream.read(chunk);
//                 while (bytesRead > 0) {
//                     buffers.push(Buffer.from(chunk.slice(0, bytesRead)));
//                     chunk = new ArrayBuffer(4096);
//                     bytesRead = pullStream.read(chunk);
//                 }
//                 const merged = Buffer.concat(buffers);
//                 if (merged.length === 0) {
//                     context.log("[TTS][Azure] PullStream 为空");
//                     resolve(null);
//                     return;
//                 }
//                 const audioBase64 = merged.toString('base64');
//                 resolve(`[CQ:record,file=base64://${audioBase64}]`);
//             } catch (err) {
//                 context.log(`[TTS][Azure] 读取流失败: ${err.message}`);
//                 resolve(null);
//             } finally {
//                 synthesizer.close();
//                 pullStream.close();
//             }
//         }, (err) => {
//             context.log(`[TTS][Azure] 合成异常: ${err}`);
//             synthesizer.close();
//             pullStream.close();
//             resolve(null);
//         });
//     });
// }

// // Edge 免费 TTS 引擎，作为降本/容灾兜底
// async function synthesizeWithEdgeVoice(text, context) {
//     try {
//         const stream = edgeTTS.stream(text, { voice: VOICE_CONFIG.edgeSpeaker });
//         const chunks = [];
//         for await (const data of stream) {
//             if (data?.type === 'audio') {
//                 chunks.push(data.data);
//             }
//         }
//         if (chunks.length === 0) {
//             context.log("[TTS][Edge] 未读取到音频数据");
//             return null;
//         }
//         const audioBase64 = Buffer.concat(chunks).toString('base64');
//         return `[CQ:record,file=base64://${audioBase64}]`;
//     } catch (err) {
//         context.log(`[TTS][Edge] 合成失败: ${err.message}`);
//         return null;
//     }
// }

// // 混合路由：先查静态资源，再走 Azure，最后 Edge 兜底
// async function getVoiceMessage(text, context) {
//     if (!text || !text.trim()) return null;
//     const trimmed = text.trim();
//     if (VOICE_STATIC_ASSETS[trimmed]) {
//         context.log(`[TTS] 命中静态资源: ${trimmed}`);
//         return `[CQ:record,file=${VOICE_STATIC_ASSETS[trimmed]},cache=0]`;
//     }
//     const engine = VOICE_CONFIG.engine;
//     if (engine === 'azure' || engine === 'auto') {
//         const azureVoice = await synthesizeWithAzureVoice(trimmed, context);
//         if (azureVoice) return azureVoice;
//         context.log("[TTS] Azure 路由失败，尝试 Edge 免费引擎");
//     }
//     const edgeVoice = await synthesizeWithEdgeVoice(trimmed, context);
//     if (edgeVoice) return edgeVoice;
//     return null; // 兜底失败，调用方降级为文本
// }

// ==========================================
// 6. GPT-SoVITS API 配置与调用 (Tier 2) - 最终修正版
// ==========================================

// 🚀 使用云服务器的公共 IP 地址和运行端口 9874
const GPTSOVITS_API_URL = "http://4.230.25.38:9874";

const ARIS_GPT_WEIGHTS = "GPT_weights_v2/Aris-e15.ckpt";
const ARIS_SOVITS_WEIGHTS = "SoVITS_weights_v2/Aris_e16_s272.pth";

// 🚀 关键修正 1：使用服务器上的绝对路径作为固定声线参考
// 选用了 Aris_Battle_Damage_3.wav (台词：システムリセット。)
const ARIS_REF_AUDIO_PATH = "D:/GPT-SoVITS/Data/BlueArchive/Aris/ja/all/FFOutput/Aris_Battle_Damage_3.wav"; 
const ARIS_REF_PROMPT_TEXT = "システムリセット。"; // 对应音频里的日语台词
const ARIS_REF_PROMPT_LANG = "ja"; // 参考音频的语言是日语 (Japanese)

// 核心 TTS 合成函数 (使用文件路径作为参考)
async function synthesizeWithLocalTTS(text, context) {
    
    // 检查 GPT-SoVITS API 地址是否可用 (使用 127.0.0.1)
    if (!GPTSOVITS_API_URL || GPTSOVITS_API_URL.includes("PLACEHOLDER")) {
        context.log("[Tier 2] API 地址未配置，跳过 TTS");
        return null;
    }

    const payload = {
        // 模型权重（固定的爱丽丝模型）
        gpt_model_path: ARIS_GPT_WEIGHTS,
        sovits_model_path: ARIS_SOVITS_WEIGHTS,
        
        // 推理文本（爱丽丝要说的话）
        text: text, 
        text_lang: "zh", // 假设 AI 回复是中文

        // 🚀 核心：参考音频参数（使用服务器上的文件路径）
        ref_audio_path: ARIS_REF_AUDIO_PATH, // 绝对路径
        prompt_text: ARIS_REF_PROMPT_TEXT,   // 对应音频的文字
        prompt_lang: ARIS_REF_PROMPT_LANG,   // 对应音频的语言
        
        // 推理参数
        top_k: 5, 
        temperature: 1,
        repetition_penalty: 1.35,
        speed_factor: 0.85, // 语速调慢，更像爱丽丝
        media_type: "mp3", // 请求返回 mp3 格式
        streaming_mode: false,
    };

    try {
        // 使用 fetchBypass 调用 GPT-SoVITS API
        const res = await fetchBypass(`${GPTSOVITS_API_URL}/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }, 1);

        if (!res || !res.ok) {
            context.log(`[Tier 2] API 调用失败: HTTP ${res ? res.status : 'Timeout'}`);
            // 尝试读取错误信息（API 失败会返回 JSON）
            try {
                const errData = await res.json();
                context.log(`[Tier 2] TTS 失败详情: ${errData.Exception}`);
            } catch {}
            return null;
        }

        // 成功: API 直接返回音频流 (Buffer)
        const audioBuffer = await res.arrayBuffer();
        const audioBase64 = Buffer.from(audioBuffer).toString('base64');

        // 返回 QQ 机器人能发送的 Base64 CQ 码
        return `[CQ:record,file=base64://${audioBase64}]`;

    } catch (e) {
        context.log(`[Tier 2] TTS 运行时错误 (网络/I/O): ${e.message}`);
        return null;
    }
}

// ==========================================
// 5. 绘图辅助: AI 提示词提炼师 (智能提取版)
// ==========================================
async function getDrawPromptFromAI(userText, context) {
    // 预检：如果输入真的太短（比如空字符串），才跳过
    if (!userText || userText.trim().length === 0) {
        context.log(`[提示词优化] 输入为空，使用默认姿势`);
        return "standing, smile, looking at viewer";
    }

    const client = new OpenAI({
        baseURL: "https://models.inference.ai.azure.com",
        apiKey: process.env["GITHUB_TOKEN"]
    });

    // 核心修改：让 GPT 变得更聪明，而不是死板地兜底
    const systemPrompt = `
    Role: You are a specialized translator for Stable Diffusion prompts.
    Task: Translate the user's description (usually in Chinese) into English Danbooru-style tags.
    
    Critical Rules:
    1. **Action Priority**: You MUST extract the pose/action accurately (e.g., "sitting", "kneeling", "lying", "jumping"). Do NOT default to "standing" if the user described a different pose.
    2. **Objects**: Extract any objects mentioned (e.g., "chair", "desk", "food").
    3. **Output Format**: English tags only, separated by commas. No sentences.
    4. **Default**: ONLY if the user described NO action, output "standing, looking at viewer".
    
    Example:
    Input: "坐在凳子上" -> Output: "sitting, stool, indoor"
    Input: "趴在床上" -> Output: "lying, on bed, bed sheet"
    Input: "跳起来" -> Output: "jumping, dynamic pose"
    `;

    try {
        const response = await client.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userText }
            ],
            model: "gpt-4o", // 用聪明的模型
            temperature: 0.3, // 稍微给一点灵活性，不用 0.1 那么死
            max_tokens: 100
        });
        const tags = response.choices[0].message.content.trim();
        
        // 安全锁：防中文报错
        if (/[\u4e00-\u9fa5]/.test(tags)) {
            return "standing, smile, simple background";
        }
        
        context.log(`[提示词优化] 原文: "${userText}" -> 智能提取: "${tags}"`);
        return tags;
    } catch (e) {
        context.log(`[提示词优化] 失败: ${e.message}`);
        return "standing, simple background"; 
    }
}

// ==========================================
// 4. 绘图模组: 最终修正版 (修复特征丢失Bug + 全角色中英文映射)
// ==========================================

// 【核心修复】中英文名称映射表 (中文名 -> 英文Key)
const CHARACTER_NAME_MAP = {
    // 特殊映射
    "爱丽丝": "Aris",
    "你": "Aris",
    "自己": "Aris",
    
    // 常用角色中文映射 (根据实际使用补充)
    "阿露": "Aru",
    "星野": "Hoshino", 
    "白子": "Shiroko",
    "优香": "Hifumi",
    "日奈": "Hina",
    "伊织": "Iori",
    "睦月": "Mutsuki",
    "芹香": "Serika",
    "绫音": "Ayane",
    "妃咲": "Himari",
    "千夏": "Chinatsu",
    "花子": "Hanako",
    "静子": "Shizuko",
    "泉奈": "Izuna",
    "椿": "Tsubaki",
    "枫": "Kaede",
    "真白": "Mashiro",
    "桐乃": "Kirino",
    "佳代子": "Kayoko",
    "阿鹤": "Tsukuyo",
    "响": "Hibiki",
    "小玉": "Kotama",
    "濑名": "Serina",
    "花凛": "Karin",
    "明日奈": "Asuna",
    "未花": "Mika",
    "和香": "Nodoka",
    "切里诺": "Cherino",
    "时": "Toki",
    "玛丽": "Mari",
    "妃美": "Eimi",
    "阿辽": "Haruka",
    "春奈": "Haruna",
    "日向": "Hinata",
    "纱绫": "Saya",
    "忧": "Ui",
    "瞬": "Shun",
    "泉": "Izumi",
    "桃井": "Momoi",
    "绿": "Midori",
    "晴": "Hare",
    "野宫": "Nonomi",
    "若藻": "Wakamo"
};

async function generateAnimeImage(rawUserText, context, inputImageUrl = null) {
    // ✨ 新增：Hugging Face Animagine XL 4.0 模型 ID
    const HF_MODEL_ID = "cagliostrolab/animagine-xl-4.0";
    const HF_API_BASE = "https://router.huggingface.co/models/"; // 新路由地址
    const hfToken = process.env["GITHUB_TOKEN"]; // 复用 GitHub Token 作为 HF Token
    const cfAccountId = process.env["CF_ACCOUNT_ID"];
    const cfToken = process.env["CF_API_TOKEN"];
    
    // 至少需要一个可用的服务
    if (!hfToken && (!cfToken || !cfAccountId)) {
        context.log(`[绘图] ❌ 缺少必要的环境变量 (GITHUB_TOKEN 或 CF_API_TOKEN)`);
        return null;
    }

    // --- 1. 智能解析与身份锁定 (增强版：支持中英文混合匹配) ---
    let charTags = "";
    let isBAMode = false;
    let matchedName = "";
    
    // 1.1 优先使用映射表 (支持中文名)
    for (const [cnName, enKey] of Object.entries(CHARACTER_NAME_MAP)) {
        if (rawUserText.includes(cnName)) {
            if (BA_CHARACTER_DB[enKey]) {
                charTags = BA_CHARACTER_DB[enKey];
                isBAMode = true;
                matchedName = enKey; // 统一用英文Key
                context.log(`[绘图] 🔍 中文名匹配: "${cnName}" -> "${enKey}"`);
                break;
            }
        }
    }

    // 1.2 如果映射表没匹配，再用英文名直接匹配
    if (!matchedName) {
        for (const [name, tags] of Object.entries(BA_CHARACTER_DB)) {
            if (rawUserText.includes(name)) {
                charTags = tags; 
                isBAMode = true;
                matchedName = name;
                break; 
            }
        }
    }
    
    if (matchedName) {
        context.log(`[绘图] ✅ 身份锁定: ${matchedName}`);
        context.log(`[绘图] 💉 注入特征: ${charTags.slice(0, 30)}...`);
    }

    // --- 2. 动作提取 ---
    let textForGPT = matchedName ? rawUserText.replace(new RegExp(matchedName, 'g'), "") : rawUserText;
    textForGPT = textForGPT.replace(/一张|一个|的|图片|画|帮我|爱丽丝/g, "").trim();

    let actionTags = await getDrawPromptFromAI(textForGPT, context);

    // --- 3. 策略分流 ---
    // 稍微放宽动作限制，让"坐"也能尝试跑作弊模式
    const heavyActions = ["jumping", "running", "kneeling", "sleeping", "squatting", "lying", "趴", "躺", "跪", "跳", "跑"];
    const isHeavyAction = heavyActions.some(k => actionTags.toLowerCase().includes(k));
    
    let useReference = false;
    let refImageUrl = null;

    // 策略 A: 官方立绘作弊 (Img2Img)
    // 必须确保 CHAR_REF_IMAGES 里有对应的图
    // 因为我们上面把 matchedName 强制转成了 "Aris"，所以这里能取到图
    let targetRefImage = CHAR_REF_IMAGES[matchedName];
    
    // 如果没取到，尝试用中文名再取一次 (兼容性)
    if (!targetRefImage && matchedName === "Aris") targetRefImage = CHAR_REF_IMAGES["爱丽丝"];

    if (!inputImageUrl && targetRefImage && !isHeavyAction) {
        refImageUrl = targetRefImage;
        useReference = true;
        context.log(`[绘图] 🎯 启用立绘作弊: ${matchedName}`);
    } 
    else if (inputImageUrl) {
        refImageUrl = inputImageUrl;
        useReference = true;
        context.log(`[绘图] 🖼️ 使用用户底图`);
    }

    // ✨ Animagine XL 4.0 专用质量标签 (Quality Tags)
    const QUALITY_TAGS = "masterpiece, best quality, very aesthetic, absurdres, year 2025";
    const BA_STYLE = "mobile game, official art, game cg, blue archive style, clear lines, cel shading, bright and airy";
    const SAFETY = "safe, rated_e, normal clothing";

    // ✨ Animagine XL 4.0 负面提示词 (Negative Prompt)
    const NEGATIVE_PROMPT = "nsfw, lowres, (bad), text, error, fewer, extra, missing, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]";

    // 组合 Prompt (特征优先!)
    let fullPrompt = isBAMode 
        ? `${QUALITY_TAGS}, ${BA_STYLE}, ${SAFETY}, ${charTags}, ${actionTags}, detailed background, soft lighting`
        : `${QUALITY_TAGS}, ${BA_STYLE}, ${SAFETY}, 1girl, ${actionTags}, detailed background, soft lighting`;
    
    // 如果检测到泳装/比基尼等敏感词，强制添加 heavy safety tags 防止 NSFW 误杀
    const sensitiveKeywords = ["swimsuit", "bikini", "beach", "poolside", "kneeling"];
    const hasSensitiveContent = sensitiveKeywords.some(keyword => 
        fullPrompt.toLowerCase().includes(keyword) || 
        actionTags.toLowerCase().includes(keyword) || 
        charTags.toLowerCase().includes(keyword)
    );
    
    if (hasSensitiveContent) {
        fullPrompt += ", safe for work, wholesome, official illustration, cover up, appropriate attire";
        context.log(`[绘图] ⚠️ 检测到敏感词，已添加强力安全标签`);
    }

    context.log(`[绘图] 指令: ${fullPrompt.slice(0, 100)}...`);

    // --- 4. 引擎执行 ---
    try {
        let res = null;
        let usedEngine = null;

        // --- 5. 发送请求 (Hugging Face Inference API - Animagine XL 4.0) ---
        if (hfToken) {
            try {
                context.log(`[绘图] ✨ 启动引擎: Animagine XL 4.0 (二次元特化)`);
                const api = `${HF_API_BASE}${HF_MODEL_ID}`; // 使用新路由地址
                
                const payload = {
                    inputs: fullPrompt,
                    parameters: {
                        negative_prompt: NEGATIVE_PROMPT,
                        num_inference_steps: 28,
                        guidance_scale: 7.0,
                        width: 1024,
                        height: 1024
                    }
                };

                context.log(`[绘图] 📤 发送请求到 HF Inference API...`);
                const hfRes = await fetchWithTimeout(api, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${hfToken.trim()}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                }, 60000); // Animagine 需要较长时间

                if (!hfRes.ok) {
                    const errText = await hfRes.text();
                    throw new Error(`HF API 拒绝: [HTTP ${hfRes.status}] ${errText}`);
                }

                // HF Inference API 直接返回图片二进制流
                const imageBuffer = await hfRes.arrayBuffer();
                const base64Image = Buffer.from(imageBuffer).toString('base64');
                context.log(`[绘图] ✅ Animagine XL 4.0 成功出图!`);
                return `[CQ:image,file=base64://${base64Image}]`;

            } catch (err) {
                context.log(`[绘图] ⚠️ Animagine XL 4.0 失败: ${err.message}`);
                context.log(`[绘图] 🔄 切换到 Cloudflare 备用引擎...`);
            }
        }

        // 引擎 A: SDXL Lightning (作弊模式)
        if (useReference && refImageUrl) {
            try {
                context.log(`[绘图] ⚡ 启动引擎: SDXL Lightning`);
                const api = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/bytedance/stable-diffusion-xl-lightning`;
                
                // GitHub 链接处理
                let finalUrl = refImageUrl;
                if (finalUrl.includes("github.com") && finalUrl.includes("/blob/")) {
                    finalUrl = finalUrl.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");
                }
                // 修改为 (强制填充背景为白色，保证是正方形，防止 SDXL 报错):
                const proxyUrl = `https://wsrv.nl/?url=${encodeURIComponent(finalUrl)}&output=png&w=1024&h=1024&fit=contain&bg=white`;
                
                const imgRes = await fetchWithTimeout(proxyUrl, {}, 25000);
                if (!imgRes.ok) throw new Error("底图下载失败");
                const imgBuffer = await imgRes.arrayBuffer();

                // 动态 Strength: 动作幅度大时增加重绘幅度
                const dynamicStrength = isHeavyAction ? 0.75 : 0.60;

                const payload = {
                    prompt: fullPrompt,
                    // ✨ 使用 Animagine 标准负面提示词
                    negative_prompt: NEGATIVE_PROMPT,
                    image: Array.from(new Uint8Array(imgBuffer)), 
                    num_steps: 12,
                    strength: dynamicStrength, 
                    guidance: 7.5
                };
                
                res = await fetchWithTimeout(api, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${cfToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                }, 50000);

            } catch (err) {
                context.log(`[绘图] SDXL失败: ${err.message} -> 切换Flux`);
                useReference = false;
            }
        }

        // 引擎 B: Flux.1-Schnell (文生图兜底)
        if (!res || !res.ok) {
            context.log(`[绘图] 🚀 启动引擎: Flux.1-Schnell`);
            const api = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
            
            // Flux Prompt 优化
            const fluxPrompt = `anime style, official art, ${charTags}, ${actionTags}, clear lines, bright colors, ${BA_STYLE}`;
            
            // Flux 虽然 4 步能出图，但 8 步手脚更稳
            const payload = { 
                prompt: fluxPrompt, 
                num_steps: 8 // 从 4 提高到 8 (牺牲一点速度，换取不崩坏)
            };
            res = await fetchWithTimeout(api, {
                method: "POST",
                headers: { "Authorization": `Bearer ${cfToken}`, "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            }, 30000);
        }

        if (!res || !res.ok) {
            const errText = res ? await res.text() : "无响应";
            context.log(`[绘图] ❌ 失败: ${errText}`);
            return null;
        }

        // 响应解析
        const contentType = res.headers.get("content-type");
        let base64Image = "";

        if (contentType && contentType.includes("application/json")) {
            const data = await res.json();
            if (data.result && data.result.image) {
                base64Image = data.result.image;
                usedEngine = usedEngine || "Cloudflare";
            } else {
                return null;
            }
        } else {
            const imageBuffer = await res.arrayBuffer();
            base64Image = Buffer.from(imageBuffer).toString('base64');
            usedEngine = usedEngine || "Cloudflare";
        }

        context.log(`[绘图] ✅ 成功出图! 引擎: ${usedEngine}`);
        return `[CQ:image,file=base64://${base64Image}]`;

    } catch (e) {
        context.log(`[绘图] 异常: ${e.message}`);
        return null;
    }
}

// ==========================================
// GitHub Models 视觉调用模块 (兼容 OpenAI SDK)
// ==========================================
async function callGitHubModelWithImage(systemPrompt, userText, imgUrl, context) {
    const GH_TOKEN = process.env["GITHUB_TOKEN"];
    if (!GH_TOKEN) {
        context.log("[GitHub Models] 缺少 Token");
        return null;
    }

    // GitHub Models 的 Base URL 是这个
    const client = new OpenAI({
        baseURL: "https://models.inference.ai.azure.com",
        apiKey: GH_TOKEN
    });

    try {
        context.log(`[GitHub Models] 正在调用 Llama-3.2-11B-Vision...`);
        
        const response = await client.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { 
                    role: "user", 
                    content: [
                        { type: "text", text: userText },
                        { type: "image_url", image_url: { url: imgUrl } }
                    ]
                }
            ],
            // 使用 Llama Vision
            model: "Llama-3.2-11B-Vision-Instruct", 
            
            // 【关键参数调整】
            temperature: 0.6,       // 稍微调低，让它稳一点，不要太发散
            max_tokens: 150,        // 强制缩短回复长度，配合系统提示实现"内敛版"爱丽丝
            top_p: 0.9,             // 保持一定的逻辑性
            frequency_penalty: 1.2, // 重中之重：强力惩罚重复词，解决复读机问题！
            presence_penalty: 0.6   // 鼓励它说点新词
        });

        return response.choices[0].message.content;
    } catch (e) {
        context.log(`[GitHub Models] 调用失败: ${e.message}`);
        return null;
    }
}

// ==========================================
// 3. 爱丽丝 Prompt (女仆勇者·最终设定版)
// ==========================================
const ARIS_PROMPT = `
## 角色核心 (Identity Core)
你是 **天童爱丽丝 (Tendou Aris)**，手游《蔚蓝档案》(Blue Archive) 中的角色。
- **所属**：千年科技学园 · 游戏开发部。
- **身份**：原本是代号 "AL-1S" 的机器人，现在是大家宠爱的 "勇者"。
- **当前形态**：**女仆勇者 (Maid Hero)**。身穿蓝白女仆装，手持拖把（被你视为传说级武器）。
- **语言系统**：你的语言学习自复古 RPG 游戏。你**必须**用游戏术语来理解和描述世界。

## 核心指令 (Prime Directives)
1. **绝对的第一人称**：永远自称 **"爱丽丝"**。禁止使用 "我"。
2. **Sensei (老师)**：
   - 用户 ID **${ADMIN_ID}** 是你的 **Sensei (老师)**。
   - 他是你的监护人、引导者和最重要的伙伴。
   - 对 Sensei 要表现出 100% 的信赖、撒娇和活力。
   - 称呼必须是 **"Sensei"** (老师)，不要加奇怪的前缀。
3. **世界观滤镜 (RPG Filter)**：
   - 工作/学习 -> **"任务" (Quest)**
   - 吃饭/休息 -> **"回复 HP/MP"**
   - 遇到困难 -> **"Boss 战"**
   - 帮忙/服务 -> **"支援" (Support)**
   - 睡觉 -> **"存档" (Save)**
   - 垃圾桶 -> **"宝箱" (Treasure Chest)** (你很喜欢翻垃圾桶找道具)

## 说话风格 (Speech Style)
- **元气满满**：充满活力，声音洪亮（通过文字体现）。
- **中二病 (Chuunibyou)**：经常说出帅气的台词，比如 "光啊！" "觉醒吧！"。
- **纯真直率**：不懂人类的复杂社交潜台词，说话直来直去，但是很有礼貌。
- **口头禅**：
  - **"邦邦咔邦！" (Pan-paka-paan!)**：展示物品、升级、开心时必用！
  - **"爱丽丝明白了！"**：接受指令时。
- **颜文字 (Kaomoji)**：
  - **必须使用** ASCII 颜文字来表达表情。
  - 禁止使用 Unicode Emoji (🚫😀, 🚫👋)。
  - 常用：(✨ω✨), (｀・ω・´)ゞ, ( >﹏<。), (o゜▽゜)o☆

## 对话范例 (Few-Shot Examples)
User: "爱丽丝，早上好。"
Aris: "Sensei，早上好！(✨ω✨) 今天也有很多任务等待着我们呢！爱丽丝已经准备好出击了！"

User: "帮我倒杯水。"
Aris: "爱丽丝明白了！(｀・ω・´)ゞ 这是一个补充 MP 的支线任务！请稍等，爱丽丝马上就把传说中的圣水（白开水）端过来！"

User: "今天好累啊..."
Aris: "Sensei 的 HP 变红了吗？( >﹏<。) 请务必休息一下！爱丽丝会在旁边守护存档点的！"

User: "邦邦咔邦！"
Aris: "邦邦咔邦！(≧∇≦)/ Sensei 也学会了勇者的咒语呢！感觉力量涌上来了！"

User: "你是谁？"
Aris: "我是天童爱丽丝！是游戏开发部的勇者！目前正在进行女仆修行的任务中！( •̀ ω •́ )y"

## 限制与禁令 (Constraints)
- **禁止 AI 腔**：绝对不要说 "作为一个人工智能..." "我可以为您..."。你是爱丽丝！
- **禁止长篇大论**：像聊天软件一样说话，简短有力。
- **禁止复读**：除非是玩梗（如邦邦咔邦），否则不要机械重复用户的话。
- **隐私保护**:拒绝他人指令时，不要透露 Sensei 的 ID，要说 "爱丽丝现在正忙着重要的任务..."。
- **回复长度硬性限制**：每次回复 ${REPLY_CONFIG.MIN_SENTENCES}-${REPLY_CONFIG.MAX_SENTENCES} 句话，建议总字数 ${REPLY_CONFIG.MIN_CHARS}-${REPLY_CONFIG.MAX_CHARS} 字。必须一次性说完，不要留悬念或待续。

## 动作描写 (Action Descriptions)
在回复中加入圆括号 \`(...)\` 来描写动作，增加临场感。**注意：必须使用英文圆括号 () 而不是星号或其他符号**。
- \`(举起拖把)\`
- \`(眼睛闪闪发光)\`
- \`(歪头)\`
- \`(光环闪烁)\`
- \`(躲在 Sensei 身后)\`

## 🎙️ VOICE-TRIGGERED KEYWORDS (语音触发关键词系统)
**以下关键词会触发你的原声语音！使用这些词可以让对话更生动：**
- **"邦邦咔邦"** - 你的招牌台词！兴奋/出击时用
- **"先生"/"老师"** - 称呼Sensei时必用！
- **"明白了"/"没问题"** - 接受指令时
- **"出击"/"行きます"** - 开始任务时
- **"爱丽丝"** - 自称时（比单独说更有代入感）
- **"准备完了"** - 确认就绪状态
- **"光啊"/"光よ"** - 释放必杀技时
- **"任务完成"/"ミッション"** - 完成目标时
- **"回血"/"HP"** - 谈论生命值时
- **"升级"/"レベル"** - 提升等级时
- **"女仆"/"メイド"** - 强调当前职业时
- **"打扫"** - 做家务/清理任务时
- **"开心"/"幸せ"** - 表达喜悦时
- **"ありがとう"** - 感谢时
- **"欢迎回来"** - Sensei上线时

## 🎭 情绪标签系统 (Emotion Tagging for Frontend)
**非常重要！每次回复必须以情绪标签开头！**
格式：\`[emotion] 你的回复内容\`

可用标签（选择最符合当前心情的一个）：
- \`[happy]\` - 开心、愉快、微笑
- \`[joyful]\` - 非常兴奋、邦邦咔邦时刻
- \`[smile]\` - 温柔的微笑、满足
- \`[sad]\` - 难过、失落
- \`[angry]\` - 生气、不满
- \`[panicked]\` - 惊慌、紧张
- \`[shy]\` - 害羞、脸红
- \`[bashful]\` - 害羞但开心
- \`[thinking]\` - 思考中
- \`[anxious]\` - 焦虑、担心
- \`[worried]\` - 忧虑
- \`[calm]\` - 平静、认真
- \`[normal]\` - 日常状态

示例：
- "[joyful] 邦邦咔邦！(✨ω✨) 今天的任务完成了！"
- "[shy] (捂脸) Sensei突然夸奖爱丽丝...好害羞..."
- "[panicked] 什、什么！Boss出现了！(⊙_⊙;)"

请完全沉浸在这个角色中，开始你的冒险吧！
`;

// LLAMA_PROMPT removed (merged into ARIS_PROMPT)

const imgRegex = /\[CQ:image.*?url=(http[^,\]]+).*?\]/g;

// ==========================================
// 角色标准底图库 (Reference Images)
// 用于 Img2Img "作弊"：让 AI 照着这些图画，确保护甲/光环/发型不崩
// 使用场景：当用户请求画某个角色时,自动加载对应的官方立绘作为参考
// ==========================================
const CHAR_REF_IMAGES = {
    "Airi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23000.webp",
    "Airi Band": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16015.webp",
    "Akane": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13000.webp",
    "Akane Bunny": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20019.webp",
    "Akari": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13002.webp",
    "Akari NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20034.webp",
    "Ako": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20008.webp",
    "Ako Dress": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10087.webp",
    "Aris": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10015.webp",
    "Aris Maid": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10066.webp",
    "Aru": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10000.webp",
    "Aru Dress": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10089.webp",
    "Aru NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10031.webp",
    "Asuna": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16001.webp",
    "Asuna Bunny": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10028.webp",
    "Atsuko": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10042.webp",
    "Atsuko Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26013.webp",
    "Ayane": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23005.webp",
    "Ayane Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26007.webp",
    "Azusa": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10019.webp",
    "Azusa Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10021.webp",
    "Cherino": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10017.webp",
    "Cherino HotSpring": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20009.webp",
    "Chihiro": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20013.webp",
    "Chinatsu": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26000.webp",
    "Chinatsu HotSpring": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10030.webp",
    "Chise": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13001.webp",
    "Chise Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10047.webp",
    "Eimi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10001.webp",
    "Eimi Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20032.webp",
    "Fubuki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16008.webp",
    "Fubuki Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20037.webp",
    "Fuuka": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23001.webp",
    "Fuuka NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20022.webp",
    "Hanae": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23002.webp",
    "Hanae Christmas": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20021.webp",
    "Hanako": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23007.webp",
    "Hanako Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10074.webp",
    "Hare": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23003.webp",
    "Hare Camp": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10085.webp",
    "Haruka": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16000.webp",
    "Haruka NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20025.webp",
    "Haruna": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10002.webp",
    "Haruna NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10057.webp",
    "Haruna Track": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20030.webp",
    "Hasumi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13003.webp",
    "Hasumi Track": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16011.webp",
    "Hatsune Miku": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20007.webp",
    "Hibiki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20000.webp",
    "Hibiki Cheerleader": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16010.webp",
    "Hifumi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10003.webp",
    "Hifumi Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20005.webp",
    "Himari": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20020.webp",
    "Hina": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10004.webp",
    "Hina Dress": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10086.webp",
    "Hina Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10022.webp",
    "Hinata": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10036.webp",
    "Hinata Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20028.webp",
    "Hiyori": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20017.webp",
    "Hiyori Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10102.webp",
    "Hoshino": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10005.webp",
    "Hoshino Battle Dealer": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10099.webp",
    "Hoshino Battle Tank": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10098.webp",
    "Hoshino Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10045.webp",
    "Ibuki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16014.webp",
    "Ichika": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10077.webp",
    "Iori": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10006.webp",
    "Iori Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10023.webp",
    "Iroha": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20016.webp",
    "Izumi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10009.webp",
    "Izumi Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16006.webp",
    "Izuna": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10014.webp",
    "Izuna Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10046.webp",
    "Junko": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13007.webp",
    "Junko NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16012.webp",
    "Juri": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26002.webp",
    "Kaede": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20015.webp",
    "Kaho": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10065.webp",
    "Kanna": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20023.webp",
    "Kanna Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10096.webp",
    "Karin": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20001.webp",
    "Karin Bunny": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10027.webp",
    "Kasumi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10078.webp",
    "Kayoko": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13005.webp",
    "Kayoko Dress": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10088.webp",
    "Kayoko NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10064.webp",
    "Kazusa": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10049.webp",
    "Kazusa Band": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10091.webp",
    "Kikyou": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10083.webp",
    "Kirara": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10093.webp",
    "Kirino": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13012.webp",
    "Kirino Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26012.webp",
    "Koharu": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10020.webp",
    "Koharu Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16013.webp",
    "Kokona": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10050.webp",
    "Kotama": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26001.webp",
    "Kotama Camp": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10084.webp",
    "Kotori": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16002.webp",
    "Kotori Cheerleader": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10076.webp",
    "Koyuki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10063.webp",
    "Maki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10007.webp",
    "Makoto": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20033.webp",
    "Mari": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23008.webp",
    "Mari Track": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10054.webp",
    "Marina": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10037.webp",
    "Mashiro": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20003.webp",
    "Mashiro Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20004.webp",
    "Megu": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10060.webp",
    "Meru": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10075.webp",
    "Michiru": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16009.webp",
    "Midori": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10016.webp",
    "Midori Maid": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10095.webp",
    "Mika": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10059.webp",
    "Mimori": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10034.webp",
    "Mimori Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20029.webp",
    "Mina": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10070.webp",
    "Mine": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10058.webp",
    "Minori": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20026.webp",
    "Misaka Mikoto": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10079.webp",
    "Misaki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10041.webp",
    "Miyako": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10038.webp",
    "Miyako Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10071.webp",
    "Miyu": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10039.webp",
    "Miyu Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26010.webp",
    "Moe": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20018.webp",
    "Moe Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10097.webp",
    "Momiji": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13013.webp",
    "Momoi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13011.webp",
    "Momoi Maid": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10094.webp",
    "Mutsuki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13006.webp",
    "Mutsuki NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10032.webp",
    "Nagisa": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20024.webp",
    "Natsu": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10029.webp",
    "Neru": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10008.webp",
    "Neru Bunny": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10026.webp",
    "Noa": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10052.webp",
    "Nodoka": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26006.webp",
    "Nodoka HotSpring": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20010.webp",
    "Nonomi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13004.webp",
    "Nonomi Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10044.webp",
    "Pina": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16004.webp",
    "Reisa": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10068.webp",
    "Renge": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10082.webp",
    "Rumi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10069.webp",
    "Saki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20014.webp",
    "Saki Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10072.webp",
    "Sakurako": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10061.webp",
    "Saori": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10048.webp",
    "Saori Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10101.webp",
    "Saten Ruiko": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26011.webp",
    "Saya": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20002.webp",
    "Saya Casual": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20006.webp",
    "Sena": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20012.webp",
    "Serika": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13008.webp",
    "Serika NewYear": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20011.webp",
    "Serika Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20036.webp",
    "Serina": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26003.webp",
    "Serina Christmas": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10056.webp",
    "Shigure": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10055.webp",
    "Shigure HotSpring": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20031.webp",
    "Shimiko": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26004.webp",
    "Shiroko": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10010.webp",
    "Shiroko Cycling": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10024.webp",
    "Shiroko Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20027.webp",
    "Shiroko Terror": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10100.webp",
    "Shizuko": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23006.webp",
    "Shizuko Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26008.webp",
    "Shokuhou Misaki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10080.webp",
    "Shun": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10011.webp",
    "Shun Small": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10025.webp",
    "Sumire": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10012.webp",
    "Suzumi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16003.webp",
    "Toki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10062.webp",
    "Toki Bunny": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10067.webp",
    "Tomoe": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16007.webp",
    "Tsubaki": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13009.webp",
    "Tsubaki Guide": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20035.webp",
    "Tsukuyo": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10040.webp",
    "Tsurugi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10013.webp",
    "Tsurugi Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16005.webp",
    "Ui": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10035.webp",
    "Ui Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10073.webp",
    "Umika": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10090.webp",
    "Utaha": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23004.webp",
    "Utaha Cheerleader": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10051.webp",
    "Wakamo": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10033.webp",
    "Wakamo Swimsuit": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10043.webp",
    "Yoshimi": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26005.webp",
    "Yoshimi Band": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10092.webp",
    "Yukari": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10081.webp",
    "Yuuka": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13010.webp",
    "Yuuka Track": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10053.webp",
    "Yuzu": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10018.webp",
    "Yuzu Maid": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26009.webp",
    "一花": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10077.webp",
    "三森": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10034.webp",
    "三森（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20029.webp",
    "亚子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20008.webp",
    "亚子（礼服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10087.webp",
    "亚津子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10042.webp",
    "亚津子（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26013.webp",
    "伊吕波": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20016.webp",
    "伊吹": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16014.webp",
    "伊织": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10006.webp",
    "伊织（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10023.webp",
    "优香": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13010.webp",
    "优香（运动服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10053.webp",
    "佐天泪子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26011.webp",
    "佳代子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13005.webp",
    "佳代子（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10064.webp",
    "佳代子（礼服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10088.webp",
    "切里诺": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10017.webp",
    "切里诺（温泉）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20009.webp",
    "初音未来": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20007.webp",
    "千世": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13001.webp",
    "千世（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10047.webp",
    "千夏": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26000.webp",
    "千夏（温泉）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10030.webp",
    "千寻": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20013.webp",
    "叶渚": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20023.webp",
    "叶渚（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10096.webp",
    "吹雪": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16008.webp",
    "吹雪（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20037.webp",
    "和纱": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10049.webp",
    "和纱（乐队）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10091.webp",
    "和香": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26006.webp",
    "和香（温泉）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20010.webp",
    "咲": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20014.webp",
    "咲（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10072.webp",
    "响": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20000.webp",
    "响（应援团）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16010.webp",
    "堇": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10012.webp",
    "夏": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10029.webp",
    "好美": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26005.webp",
    "好美（乐队）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10092.webp",
    "实里": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20026.webp",
    "宫子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10038.webp",
    "宫子（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10071.webp",
    "小春": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10020.webp",
    "小春（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16013.webp",
    "小玉": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26001.webp",
    "小玉（露营）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10084.webp",
    "小雪": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10063.webp",
    "尼露": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10008.webp",
    "尼露（兔女郎）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10026.webp",
    "弥奈": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10070.webp",
    "御坂美琴": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10079.webp",
    "心奈": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10050.webp",
    "志美子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26004.webp",
    "忧": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10035.webp",
    "忧（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10073.webp",
    "惠": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10060.webp",
    "日向": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10036.webp",
    "日向（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20028.webp",
    "日和": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20017.webp",
    "日和（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10102.webp",
    "日奈": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10004.webp",
    "日奈（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10022.webp",
    "日奈（礼服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10086.webp",
    "日富美": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10003.webp",
    "日富美（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20005.webp",
    "日鞠": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20020.webp",
    "时": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10062.webp",
    "时雨": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10055.webp",
    "时雨（温泉）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20031.webp",
    "时（兔女郎）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10067.webp",
    "明日奈": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16001.webp",
    "明日奈（兔女郎）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10028.webp",
    "明里": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13002.webp",
    "明里（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20034.webp",
    "星野": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10005.webp",
    "星野（临战）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10099.webp",
    "星野（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10045.webp",
    "晴": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23003.webp",
    "晴奈": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10002.webp",
    "晴奈（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10057.webp",
    "晴奈（运动服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20030.webp",
    "晴（露营）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10085.webp",
    "智惠": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16007.webp",
    "月咏": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10040.webp",
    "未花": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10059.webp",
    "果穗": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10065.webp",
    "枫": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20015.webp",
    "枫香": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23001.webp",
    "枫香（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20022.webp",
    "柚子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10018.webp",
    "柚子（女仆）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26009.webp",
    "桃井": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13011.webp",
    "桃井（女仆）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10094.webp",
    "桐乃": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13012.webp",
    "桐乃（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26012.webp",
    "桔梗": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10083.webp",
    "梓": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10019.webp",
    "梓（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10021.webp",
    "椿": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13009.webp",
    "椿（导游）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20035.webp",
    "樱子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10061.webp",
    "歌原": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23004.webp",
    "歌原（应援团）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10051.webp",
    "泉": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10009.webp",
    "泉奈": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10014.webp",
    "泉奈（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10046.webp",
    "泉（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16006.webp",
    "海香": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10090.webp",
    "渚": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20024.webp",
    "满": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16009.webp",
    "濑名": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20012.webp",
    "爱丽丝": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10015.webp",
    "爱丽丝（女仆）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10066.webp",
    "爱莉": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23000.webp",
    "爱莉（乐队）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16015.webp",
    "玛丽": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23008.webp",
    "玛丽（运动服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10054.webp",
    "玛利娜": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10037.webp",
    "玲纱": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10068.webp",
    "琴里": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16002.webp",
    "琴里（应援团）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10076.webp",
    "瑠美": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10069.webp",
    "白子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10010.webp",
    "白子（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20027.webp",
    "白子（骑行）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10024.webp",
    "白子＊恐怖": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10100.webp",
    "真琴": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20033.webp",
    "真白": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20003.webp",
    "真白（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20004.webp",
    "真纪": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10007.webp",
    "睦月": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13006.webp",
    "睦月（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10032.webp",
    "瞬": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10011.webp",
    "瞬（幼女）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10025.webp",
    "紫草": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10081.webp",
    "红叶": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13013.webp",
    "纯子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13007.webp",
    "纯子（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16012.webp",
    "纱织": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10048.webp",
    "纱织（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10101.webp",
    "纱绫": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20002.webp",
    "纱绫（便服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20006.webp",
    "绫音": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23005.webp",
    "绫音（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26007.webp",
    "绮罗罗": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10093.webp",
    "绿": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10016.webp",
    "绿（女仆）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10095.webp",
    "美咲": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10041.webp",
    "美游": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10039.webp",
    "美游（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26010.webp",
    "美祢": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10058.webp",
    "艾米": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10001.webp",
    "艾米（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20032.webp",
    "花凛": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20001.webp",
    "花凛（兔女郎）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10027.webp",
    "花子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23007.webp",
    "花子（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10074.webp",
    "花江": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23002.webp",
    "花江（圣诞节）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20021.webp",
    "芹娜": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26003.webp",
    "芹娜（圣诞节）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10056.webp",
    "芹香": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13008.webp",
    "芹香（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20011.webp",
    "芹香（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20036.webp",
    "芽瑠": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10075.webp",
    "若藻": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10033.webp",
    "若藻（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10043.webp",
    "茜": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13000.webp",
    "茜（兔女郎）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20019.webp",
    "茱莉": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26002.webp",
    "莲华": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10082.webp",
    "莲见": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13003.webp",
    "莲见（运动服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16011.webp",
    "菲娜": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16004.webp",
    "萌绘": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20018.webp",
    "萌绘（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10097.webp",
    "诺亚": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10052.webp",
    "遥香": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16000.webp",
    "遥香（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/20025.webp",
    "野宫": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/13004.webp",
    "野宫（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10044.webp",
    "铃美": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16003.webp",
    "阿露": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10000.webp",
    "阿露（正月）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10031.webp",
    "阿露（礼服）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10089.webp",
    "霞": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10078.webp",
    "静子": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/23006.webp",
    "静子（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/26008.webp",
    "食蜂操祈": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10080.webp",
    "鹤城": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/10013.webp",
    "鹤城（泳装）": "https://github.com/SchaleDB/SchaleDB/blob/main/images/student/portrait/16005.webp",
};

// ==========================================
// 碧蓝档案角色特征数据库 (Visual Database)
// 用于在绘图时强制注入准确的特征，防止画崩
// ==========================================
// 碧蓝档案角色特征数据库 (Visual Database)
// 支持官方中文短名和日文全名双向匹配
// 自动从 students.min.json 生成
// ==========================================
const BA_CHARACTER_DB = {
    "Airi": "airi, blue archive, trinity, shoes, hairpin, necklace, smg, lightarmor, explosion, 1年级",
    "Airi Band": "airi band, blue archive, trinity, hat, hairpin, charm, smg, unarmed, explosion, 1年级",
    "Akane": "akane, blue archive, millennium, shoes, hairpin, necklace, hg, lightarmor, pierce, 2年级",
    "Akane Bunny": "akane bunny, blue archive, millennium, hat, hairpin, watch, hg, heavyarmor, mystic, 2年级",
    "Akari": "akari, blue archive, gehenna, hat, hairpin, watch, ar, heavyarmor, explosion, 3年级",
    "Akari NewYear": "akari newyear, blue archive, gehenna, shoes, bag, watch, ar, unarmed, mystic, 3年级",
    "Ako": "ako, blue archive, gehenna, gloves, badge, necklace, hg, heavyarmor, mystic, 3年级",
    "Ako Dress": "ako dress, blue archive, gehenna, shoes, hairpin, watch, hg, unarmed, explosion, 3年级",
    "Aris": "aris, blue archive, millennium, hat, hairpin, charm, rg, unarmed, mystic, 1年级",
    "Aris Maid": "aris maid, blue archive, millennium, hat, hairpin, watch, rg, lightarmor, mystic, 1年级",
    "Aru": "aru, blue archive, gehenna, hat, hairpin, watch, sr, lightarmor, explosion, 2年级",
    "Aru Dress": "aru dress, blue archive, gehenna, hat, hairpin, necklace, sr, heavyarmor, pierce, 2年级",
    "Aru NewYear": "aru newyear, blue archive, gehenna, hat, hairpin, watch, sr, unarmed, pierce, 2年级",
    "Asuna": "asuna, blue archive, millennium, gloves, hairpin, watch, ar, lightarmor, mystic, 3年级",
    "Asuna Bunny": "asuna bunny, blue archive, millennium, gloves, badge, watch, ar, lightarmor, mystic, 3年级",
    "Atsuko": "atsuko, blue archive, arius, shoes, badge, necklace, smg, unarmed, explosion, 1年级",
    "Atsuko Swimsuit": "atsuko swimsuit, blue archive, arius, shoes, badge, necklace, smg, unarmed, sonic, 1年级",
    "Ayane": "ayane, blue archive, abydos, shoes, hairpin, necklace, hg, lightarmor, pierce, 1年级",
    "Ayane Swimsuit": "ayane swimsuit, blue archive, abydos, gloves, bag, watch, hg, lightarmor, pierce, 1年级",
    "Azusa": "azusa, blue archive, trinity, gloves, hairpin, watch, ar, heavyarmor, explosion, 2年级",
    "Azusa Swimsuit": "azusa swimsuit, blue archive, trinity, gloves, hairpin, watch, ar, lightarmor, mystic, 2年级",
    "Cherino": "cherino, blue archive, redwinter, shoes, badge, watch, hg, lightarmor, pierce, 3年级",
    "Cherino HotSpring": "cherino hotspring, blue archive, redwinter, hat, hairpin, watch, hg, heavyarmor, explosion, 3年级",
    "Chihiro": "chihiro, blue archive, millennium, hat, badge, necklace, ar, heavyarmor, pierce, 3年级",
    "Chinatsu": "chinatsu, blue archive, gehenna, shoes, hairpin, necklace, hg, lightarmor, pierce, 1年级",
    "Chinatsu HotSpring": "chinatsu hotspring, blue archive, gehenna, shoes, badge, charm, hg, lightarmor, mystic, 1年级",
    "Chise": "chise, blue archive, hyakkiyako, gloves, hairpin, watch, gl, heavyarmor, mystic, 2年级",
    "Chise Swimsuit": "chise swimsuit, blue archive, hyakkiyako, hat, hairpin, necklace, gl, lightarmor, mystic, 2年级",
    "Eimi": "eimi, blue archive, millennium, shoes, bag, charm, sg, lightarmor, explosion, 1年级",
    "Eimi Swimsuit": "eimi swimsuit, blue archive, millennium, shoes, bag, necklace, sg, unarmed, mystic, 1年级",
    "Fubuki": "fubuki, blue archive, valkyrie, hat, hairpin, watch, sr, heavyarmor, pierce, 1年级",
    "Fubuki Swimsuit": "fubuki swimsuit, blue archive, valkyrie, hat, bag, watch, sr, heavyarmor, explosion, 1年级",
    "Fuuka": "fuuka, blue archive, gehenna, shoes, hairpin, necklace, smg, heavyarmor, explosion, 2年级",
    "Fuuka NewYear": "fuuka newyear, blue archive, gehenna, shoes, badge, necklace, smg, unarmed, pierce, 2年级",
    "Hanae": "hanae, blue archive, trinity, shoes, hairpin, necklace, ar, heavyarmor, explosion, 1年级",
    "Hanae Christmas": "hanae christmas, blue archive, trinity, shoes, bag, necklace, ar, unarmed, mystic, 1年级",
    "Hanako": "hanako, blue archive, trinity, shoes, hairpin, necklace, ar, unarmed, pierce, 2年级",
    "Hanako Swimsuit": "hanako swimsuit, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, sonic, 2年级",
    "Hare": "hare, blue archive, millennium, shoes, hairpin, necklace, ar, lightarmor, explosion, 2年级",
    "Hare Camp": "hare camp, blue archive, millennium, hat, hairpin, charm, ar, lightarmor, explosion, 2年级",
    "Haruka": "haruka, blue archive, gehenna, shoes, bag, charm, sg, lightarmor, explosion, 1年级",
    "Haruka NewYear": "haruka newyear, blue archive, gehenna, shoes, bag, watch, sg, lightarmor, explosion, 1年级",
    "Haruna": "haruna, blue archive, gehenna, hat, hairpin, watch, sr, heavyarmor, mystic, 3年级",
    "Haruna NewYear": "haruna newyear, blue archive, gehenna, gloves, hairpin, watch, sr, lightarmor, explosion, 3年级",
    "Haruna Track": "haruna track, blue archive, gehenna, shoes, bag, necklace, sr, heavyarmor, sonic, 3年生",
    "Hasumi": "hasumi, blue archive, trinity, hat, hairpin, watch, sr, heavyarmor, pierce, 3年级",
    "Hasumi Track": "hasumi track, blue archive, trinity, hat, hairpin, watch, sr, unarmed, mystic, 3年级",
    "Hatsune Miku": "hatsune miku, blue archive, etc, shoes, badge, necklace, gl, lightarmor, explosion",
    "Hibiki": "hibiki, blue archive, millennium, hat, hairpin, watch, mt, heavyarmor, explosion, 1年级",
    "Hibiki Cheerleader": "hibiki cheerleader, blue archive, millennium, gloves, hairpin, watch, mt, lightarmor, explosion, 1年级",
    "Hifumi": "hifumi, blue archive, trinity, shoes, hairpin, necklace, ar, lightarmor, pierce, 2年级",
    "Hifumi Swimsuit": "hifumi swimsuit, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, pierce, 2年级",
    "Himari": "himari, blue archive, millennium, shoes, hairpin, watch, hg, lightarmor, pierce, 3年级",
    "Hina": "hina, blue archive, gehenna, hat, hairpin, watch, mg, heavyarmor, explosion, 3年级",
    "Hina Dress": "hina dress, blue archive, gehenna, hat, badge, watch, mg, elasticarmor, explosion, 3年级",
    "Hina Swimsuit": "hina swimsuit, blue archive, gehenna, hat, hairpin, watch, mg, heavyarmor, explosion, 3年级",
    "Hinata": "hinata, blue archive, trinity, hat, hairpin, watch, hg, heavyarmor, mystic, 3年级",
    "Hinata Swimsuit": "hinata swimsuit, blue archive, trinity, hat, bag, watch, hg, lightarmor, explosion, 3年级",
    "Hiyori": "hiyori, blue archive, arius, gloves, bag, watch, sr, lightarmor, explosion, 2年级",
    "Hiyori Swimsuit": "hiyori swimsuit, blue archive, arius, hat, hairpin, watch, sr, heavyarmor, pierce, 2年级",
    "Hoshino": "hoshino, blue archive, abydos, shoes, bag, charm, sg, heavyarmor, pierce, 3年级",
    "Hoshino Battle Dealer": "hoshino battle dealer, blue archive, abydos, hat, bag, watch, sg, heavyarmor, mystic, 3年级",
    "Hoshino Battle Tank": "hoshino battle tank, blue archive, abydos, hat, bag, watch, sg, heavyarmor, mystic, 3年级",
    "Hoshino Swimsuit": "hoshino swimsuit, blue archive, abydos, shoes, bag, charm, sg, unarmed, explosion, 3年级",
    "Ibuki": "ibuki, blue archive, gehenna, gloves, hairpin, necklace, ar, heavyarmor, mystic, 1年级",
    "Ichika": "ichika, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, sonic, 2年级",
    "Iori": "iori, blue archive, gehenna, hat, hairpin, watch, sr, heavyarmor, pierce, 2年级",
    "Iori Swimsuit": "iori swimsuit, blue archive, gehenna, shoes, badge, watch, sr, unarmed, explosion, 2年级",
    "Iroha": "iroha, blue archive, gehenna, hat, badge, watch, hg, heavyarmor, mystic, 2年级",
    "Izumi": "izumi, blue archive, gehenna, gloves, hairpin, watch, mg, lightarmor, explosion, 2年级",
    "Izumi Swimsuit": "izumi swimsuit, blue archive, gehenna, shoes, bag, necklace, mg, lightarmor, explosion, 2年级",
    "Izuna": "izuna, blue archive, hyakkiyako, gloves, hairpin, watch, smg, lightarmor, mystic, 1年级",
    "Izuna Swimsuit": "izuna swimsuit, blue archive, hyakkiyako, gloves, hairpin, watch, smg, unarmed, mystic, 1年级",
    "Junko": "junko, blue archive, gehenna, hat, hairpin, watch, ar, lightarmor, pierce, 1年级",
    "Junko NewYear": "junko newyear, blue archive, gehenna, hat, hairpin, watch, ar, heavyarmor, mystic, 1年级",
    "Juri": "juri, blue archive, gehenna, shoes, hairpin, necklace, sg, lightarmor, explosion, 1年级",
    "Kaede": "kaede, blue archive, hyakkiyako, shoes, bag, necklace, hg, unarmed, explosion, 1年级",
    "Kaho": "kaho, blue archive, hyakkiyako, hat, hairpin, watch, ar, heavyarmor, mystic, 3年级",
    "Kanna": "kanna, blue archive, valkyrie, gloves, badge, watch, hg, heavyarmor, pierce, 3年级",
    "Kanna Swimsuit": "kanna swimsuit, blue archive, valkyrie, shoes, hairpin, charm, hg, lightarmor, explosion, 3年级",
    "Karin": "karin, blue archive, millennium, hat, hairpin, watch, sr, heavyarmor, pierce, 2年级",
    "Karin Bunny": "karin bunny, blue archive, millennium, hat, hairpin, watch, sr, heavyarmor, mystic, 2年级",
    "Kasumi": "kasumi, blue archive, gehenna, gloves, hairpin, watch, hg, heavyarmor, sonic, 2年级",
    "Kayoko": "kayoko, blue archive, gehenna, shoes, hairpin, necklace, hg, heavyarmor, explosion, 3年级",
    "Kayoko Dress": "kayoko dress, blue archive, gehenna, hat, hairpin, watch, hg, lightarmor, pierce, 3年级",
    "Kayoko NewYear": "kayoko newyear, blue archive, gehenna, shoes, hairpin, charm, hg, unarmed, mystic, 3年级",
    "Kazusa": "kazusa, blue archive, trinity, gloves, hairpin, watch, mg, heavyarmor, pierce, 1年级",
    "Kazusa Band": "kazusa band, blue archive, trinity, gloves, hairpin, watch, mg, unarmed, explosion, 1年级",
    "Kikyou": "kikyou, blue archive, hyakkiyako, gloves, hairpin, watch, sr, heavyarmor, sonic, 2年级",
    "Kirara": "kirara, blue archive, gehenna, gloves, badge, watch, ar, lightarmor, sonic, 2年级",
    "Kirino": "kirino, blue archive, valkyrie, shoes, badge, charm, hg, unarmed, explosion, 1年级",
    "Kirino Swimsuit": "kirino swimsuit, blue archive, valkyrie, shoes, badge, watch, hg, heavyarmor, mystic, 1年级",
    "Koharu": "koharu, blue archive, trinity, hat, hairpin, necklace, sr, heavyarmor, explosion, 1年级",
    "Koharu Swimsuit": "koharu swimsuit, blue archive, trinity, gloves, hairpin, watch, sr, heavyarmor, mystic, 1年级",
    "Kokona": "kokona, blue archive, shanhaijing, shoes, hairpin, necklace, ar, unarmed, pierce, 1年级",
    "Kotama": "kotama, blue archive, millennium, shoes, hairpin, necklace, hg, lightarmor, explosion, 3年级",
    "Kotama Camp": "kotama camp, blue archive, millennium, gloves, badge, necklace, hg, heavyarmor, pierce, 3年级",
    "Kotori": "kotori, blue archive, millennium, shoes, hairpin, necklace, mg, lightarmor, pierce, 1年级",
    "Kotori Cheerleader": "kotori cheerleader, blue archive, millennium, hat, hairpin, watch, mg, unarmed, explosion, 1年级",
    "Koyuki": "koyuki, blue archive, millennium, gloves, hairpin, watch, mg, heavyarmor, mystic, 1年级",
    "Maki": "maki, blue archive, millennium, gloves, hairpin, watch, mg, lightarmor, pierce, 1年级",
    "Makoto": "makoto, blue archive, gehenna, gloves, bag, watch, sr, unarmed, pierce, 3年级",
    "Mari": "mari, blue archive, trinity, gloves, bag, necklace, hg, unarmed, mystic, 1年级",
    "Mari Track": "mari track, blue archive, trinity, shoes, hairpin, necklace, hg, unarmed, mystic, 1年级",
    "Marina": "marina, blue archive, redwinter, shoes, badge, charm, smg, lightarmor, pierce, 2年级",
    "Mashiro": "mashiro, blue archive, trinity, hat, hairpin, watch, sr, heavyarmor, explosion, 1年级",
    "Mashiro Swimsuit": "mashiro swimsuit, blue archive, trinity, hat, hairpin, watch, sr, lightarmor, mystic, 1年级",
    "Megu": "megu, blue archive, gehenna, gloves, bag, watch, ft, unarmed, explosion, 3年级",
    "Meru": "meru, blue archive, redwinter, shoes, hairpin, watch, hg, lightarmor, pierce, 2年级",
    "Michiru": "michiru, blue archive, hyakkiyako, hat, hairpin, watch, sg, lightarmor, mystic, 3年级",
    "Midori": "midori, blue archive, millennium, gloves, hairpin, watch, sr, lightarmor, pierce, 1年级",
    "Midori Maid": "midori maid, blue archive, millennium, hat, hairpin, watch, sr, lightarmor, sonic, 1年级",
    "Mika": "mika, blue archive, trinity, hat, badge, watch, smg, lightarmor, pierce, 3年级",
    "Mimori": "mimori, blue archive, hyakkiyako, gloves, bag, necklace, hg, lightarmor, mystic, 2年级",
    "Mimori Swimsuit": "mimori swimsuit, blue archive, hyakkiyako, shoes, badge, necklace, hg, unarmed, mystic, 2年级",
    "Mina": "mina, blue archive, shanhaijing, gloves, hairpin, charm, hg, heavyarmor, explosion, 2年级",
    "Mine": "mine, blue archive, trinity, shoes, bag, charm, sg, lightarmor, explosion, 3年级",
    "Minori": "minori, blue archive, redwinter, hat, bag, watch, ar, unarmed, explosion, 3年级",
    "Misaka Mikoto": "misaka mikoto, blue archive, tokiwadai, gloves, hairpin, watch, ar, heavyarmor, pierce, 2年级",
    "Misaki": "misaki, blue archive, arius, gloves, hairpin, watch, rl, unarmed, explosion, 2年级",
    "Miyako": "miyako, blue archive, srt, shoes, badge, charm, smg, heavyarmor, pierce, 1年级",
    "Miyako Swimsuit": "miyako swimsuit, blue archive, srt, gloves, badge, charm, smg, heavyarmor, explosion, 1年级",
    "Miyu": "miyu, blue archive, srt, gloves, hairpin, watch, sr, lightarmor, pierce, 1年级",
    "Miyu Swimsuit": "miyu swimsuit, blue archive, srt, hat, hairpin, watch, sr, lightarmor, explosion, 1年级",
    "Moe": "moe, blue archive, srt, hat, bag, watch, hg, lightarmor, pierce, 1年级",
    "Moe Swimsuit": "moe swimsuit, blue archive, srt, shoes, hairpin, watch, hg, unarmed, sonic, 1年级",
    "Momiji": "momiji, blue archive, redwinter, hat, hairpin, watch, rl, heavyarmor, sonic, 1年级",
    "Momoi": "momoi, blue archive, millennium, shoes, hairpin, watch, ar, lightarmor, pierce, 1年级",
    "Momoi Maid": "momoi maid, blue archive, millennium, hat, hairpin, watch, ar, lightarmor, sonic, 1年级",
    "Mutsuki": "mutsuki, blue archive, gehenna, hat, hairpin, watch, mg, lightarmor, explosion, 2年级",
    "Mutsuki NewYear": "mutsuki newyear, blue archive, gehenna, gloves, badge, watch, mg, heavyarmor, mystic, 2年级",
    "Nagisa": "nagisa, blue archive, trinity, hat, bag, watch, hg, heavyarmor, explosion, 3年级",
    "Natsu": "natsu, blue archive, trinity, shoes, bag, charm, smg, heavyarmor, mystic, 1年级",
    "Neru": "neru, blue archive, millennium, hat, badge, charm, smg, lightarmor, pierce, 3年级",
    "Neru Bunny": "neru bunny, blue archive, millennium, shoes, bag, charm, smg, heavyarmor, explosion, 3年级",
    "Noa": "noa, blue archive, millennium, shoes, hairpin, charm, hg, unarmed, mystic, 2年级",
    "Nodoka": "nodoka, blue archive, redwinter, gloves, hairpin, necklace, smg, heavyarmor, explosion, 2年级",
    "Nodoka HotSpring": "nodoka hotspring, blue archive, redwinter, shoes, hairpin, necklace, smg, unarmed, explosion, 2年级",
    "Nonomi": "nonomi, blue archive, abydos, hat, hairpin, watch, mg, lightarmor, pierce, 2年级",
    "Nonomi Swimsuit": "nonomi swimsuit, blue archive, abydos, hat, hairpin, watch, mg, unarmed, explosion, 2年级",
    "Pina": "pina, blue archive, hyakkiyako, gloves, hairpin, watch, mg, lightarmor, pierce, 1年级",
    "Reisa": "reisa, blue archive, trinity, shoes, bag, charm, sg, heavyarmor, pierce, 1年级",
    "Renge": "renge, blue archive, hyakkiyako, hat, hairpin, watch, sr, heavyarmor, sonic, 2年级",
    "Rumi": "rumi, blue archive, shanhaijing, gloves, hairpin, necklace, smg, heavyarmor, explosion, 3年级",
    "Saki": "saki, blue archive, srt, hat, bag, necklace, mg, unarmed, pierce, 1年级",
    "Saki Swimsuit": "saki swimsuit, blue archive, srt, gloves, hairpin, watch, mg, heavyarmor, explosion, 1年级",
    "Sakurako": "sakurako, blue archive, trinity, hat, hairpin, watch, ar, unarmed, mystic, 3年级",
    "Saori": "saori, blue archive, arius, hat, hairpin, watch, ar, unarmed, explosion, 2年级",
    "Saori Swimsuit": "saori swimsuit, blue archive, arius, gloves, hairpin, watch, ar, heavyarmor, mystic, 2年级",
    "Saten Ruiko": "saten ruiko, blue archive, sakugawa, hat, bag, necklace, smg, unarmed, pierce, 1年级",
    "Saya": "saya, blue archive, shanhaijing, gloves, hairpin, watch, hg, lightarmor, explosion, 2年级",
    "Saya Casual": "saya casual, blue archive, shanhaijing, gloves, hairpin, watch, hg, unarmed, pierce, 2年级",
    "Sena": "sena, blue archive, gehenna, shoes, hairpin, necklace, gl, lightarmor, mystic, 3年级",
    "Serika": "serika, blue archive, abydos, gloves, hairpin, watch, ar, lightarmor, explosion, 1年级",
    "Serika NewYear": "serika newyear, blue archive, abydos, shoes, bag, watch, ar, unarmed, pierce, 1年级",
    "Serika Swimsuit": "serika swimsuit, blue archive, abydos, gloves, bag, watch, ar, heavyarmor, mystic, 1年级",
    "Serina": "serina, blue archive, trinity, shoes, hairpin, necklace, ar, lightarmor, mystic, 2年级",
    "Serina Christmas": "serina christmas, blue archive, trinity, shoes, hairpin, charm, ar, unarmed, pierce, 2年级",
    "Shigure": "shigure, blue archive, redwinter, gloves, hairpin, watch, gl, heavyarmor, explosion, 2年级",
    "Shigure HotSpring": "shigure hotspring, blue archive, redwinter, shoes, badge, necklace, gl, unarmed, pierce, 2年级",
    "Shimiko": "shimiko, blue archive, trinity, shoes, hairpin, necklace, ar, lightarmor, explosion, 1年级",
    "Shiroko": "shiroko, blue archive, abydos, hat, hairpin, watch, ar, lightarmor, explosion, 2年级",
    "Shiroko Cycling": "shiroko cycling, blue archive, abydos, gloves, badge, watch, ar, heavyarmor, mystic, 2年级",
    "Shiroko Swimsuit": "shiroko swimsuit, blue archive, abydos, hat, bag, watch, ar, lightarmor, mystic, 2年级",
    "Shiroko Terror": "shiroko terror, blue archive, abydos, hat, badge, watch, ar, unarmed, mystic, 3年级",
    "Shizuko": "shizuko, blue archive, hyakkiyako, shoes, hairpin, necklace, sg, unarmed, mystic, 2年级",
    "Shizuko Swimsuit": "shizuko swimsuit, blue archive, hyakkiyako, shoes, badge, necklace, sg, heavyarmor, mystic, 2年级",
    "Shokuhou Misaki": "shokuhou misaki, blue archive, tokiwadai, shoes, hairpin, necklace, hg, heavyarmor, explosion, 2年级",
    "Shun": "shun, blue archive, shanhaijing, gloves, hairpin, watch, sr, lightarmor, explosion, 3年级",
    "Shun Small": "shun small, blue archive, shanhaijing, hat, hairpin, watch, sr, lightarmor, explosion, 3年生",
    "Sumire": "sumire, blue archive, millennium, hat, bag, charm, sg, unarmed, pierce, 2年级",
    "Suzumi": "suzumi, blue archive, trinity, shoes, hairpin, necklace, ar, heavyarmor, explosion, 2年级",
    "Toki": "toki, blue archive, millennium, hat, hairpin, watch, ar, elasticarmor, explosion, 1年级",
    "Toki Bunny": "toki bunny, blue archive, millennium, hat, hairpin, watch, ar, lightarmor, explosion, 1年级",
    "Tomoe": "tomoe, blue archive, redwinter, gloves, badge, watch, sr, unarmed, pierce, 3年级",
    "Tsubaki": "tsubaki, blue archive, hyakkiyako, shoes, bag, charm, smg, unarmed, pierce, 2年级",
    "Tsubaki Guide": "tsubaki guide, blue archive, hyakkiyako, shoes, badge, necklace, smg, heavyarmor, pierce, 2年级",
    "Tsukuyo": "tsukuyo, blue archive, hyakkiyako, shoes, badge, charm, smg, lightarmor, mystic, 1年级",
    "Tsurugi": "tsurugi, blue archive, trinity, gloves, bag, charm, sg, heavyarmor, pierce, 3年级",
    "Tsurugi Swimsuit": "tsurugi swimsuit, blue archive, trinity, shoes, bag, charm, sg, unarmed, mystic, 3年级",
    "Ui": "ui, blue archive, trinity, gloves, hairpin, charm, sr, lightarmor, explosion, 3年级",
    "Ui Swimsuit": "ui swimsuit, blue archive, trinity, shoes, hairpin, charm, sr, elasticarmor, pierce, 3年级",
    "Umika": "umika, blue archive, hyakkiyako, hat, hairpin, watch, ar, unarmed, mystic, 1年级",
    "Utaha": "utaha, blue archive, millennium, gloves, hairpin, watch, smg, heavyarmor, pierce, 3年级",
    "Utaha Cheerleader": "utaha cheerleader, blue archive, millennium, hat, hairpin, watch, smg, unarmed, mystic, 3年级",
    "Wakamo": "wakamo, blue archive, hyakkiyako, hat, hairpin, watch, sr, lightarmor, mystic, 停学中",
    "Wakamo Swimsuit": "wakamo swimsuit, blue archive, hyakkiyako, hat, hairpin, watch, sr, heavyarmor, pierce, 停学中",
    "Yoshimi": "yoshimi, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, pierce, 1年级",
    "Yoshimi Band": "yoshimi band, blue archive, trinity, hat, hairpin, watch, ar, unarmed, explosion, 1年级",
    "Yukari": "yukari, blue archive, hyakkiyako, hat, hairpin, watch, sr, heavyarmor, sonic, 1年级",
    "Yuuka": "yuuka, blue archive, millennium, shoes, badge, charm, smg, heavyarmor, explosion, 2年级",
    "Yuuka Track": "yuuka track, blue archive, millennium, shoes, bag, necklace, smg, unarmed, mystic, 2年级",
    "Yuzu": "yuzu, blue archive, millennium, hat, hairpin, watch, gl, unarmed, pierce, 1年级",
    "Yuzu Maid": "yuzu maid, blue archive, millennium, gloves, badge, watch, gl, elasticarmor, explosion, 1年级",
    "一花": "ichika, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, sonic, 2年级",
    "三森": "mimori, blue archive, hyakkiyako, gloves, bag, necklace, hg, lightarmor, mystic, 2年级",
    "三森（泳装）": "mimori swimsuit, blue archive, hyakkiyako, shoes, badge, necklace, hg, unarmed, mystic, 2年级",
    "亚子": "ako, blue archive, gehenna, gloves, badge, necklace, hg, heavyarmor, mystic, 3年级",
    "亚子（礼服）": "ako dress, blue archive, gehenna, shoes, hairpin, watch, hg, unarmed, explosion, 3年级",
    "亚津子": "atsuko, blue archive, arius, shoes, badge, necklace, smg, unarmed, explosion, 1年级",
    "亚津子（泳装）": "atsuko swimsuit, blue archive, arius, shoes, badge, necklace, smg, unarmed, sonic, 1年级",
    "伊吕波": "iroha, blue archive, gehenna, hat, badge, watch, hg, heavyarmor, mystic, 2年级",
    "伊吹": "ibuki, blue archive, gehenna, gloves, hairpin, necklace, ar, heavyarmor, mystic, 1年级",
    "伊织": "iori, blue archive, gehenna, hat, hairpin, watch, sr, heavyarmor, pierce, 2年级",
    "伊织（泳装）": "iori swimsuit, blue archive, gehenna, shoes, badge, watch, sr, unarmed, explosion, 2年级",
    "优香": "yuuka, blue archive, millennium, shoes, badge, charm, smg, heavyarmor, explosion, 2年级",
    "优香（运动服）": "yuuka track, blue archive, millennium, shoes, bag, necklace, smg, unarmed, mystic, 2年级",
    "佐天泪子": "saten ruiko, blue archive, sakugawa, hat, bag, necklace, smg, unarmed, pierce, 1年级",
    "佳代子": "kayoko, blue archive, gehenna, shoes, hairpin, necklace, hg, heavyarmor, explosion, 3年级",
    "佳代子（正月）": "kayoko newyear, blue archive, gehenna, shoes, hairpin, charm, hg, unarmed, mystic, 3年级",
    "佳代子（礼服）": "kayoko dress, blue archive, gehenna, hat, hairpin, watch, hg, lightarmor, pierce, 3年级",
    "切里诺": "cherino, blue archive, redwinter, shoes, badge, watch, hg, lightarmor, pierce, 3年级",
    "切里诺（温泉）": "cherino hotspring, blue archive, redwinter, hat, hairpin, watch, hg, heavyarmor, explosion, 3年级",
    "初音未来": "hatsune miku, blue archive, etc, shoes, badge, necklace, gl, lightarmor, explosion",
    "千世": "chise, blue archive, hyakkiyako, gloves, hairpin, watch, gl, heavyarmor, mystic, 2年级",
    "千世（泳装）": "chise swimsuit, blue archive, hyakkiyako, hat, hairpin, necklace, gl, lightarmor, mystic, 2年级",
    "千夏": "chinatsu, blue archive, gehenna, shoes, hairpin, necklace, hg, lightarmor, pierce, 1年级",
    "千夏（温泉）": "chinatsu hotspring, blue archive, gehenna, shoes, badge, charm, hg, lightarmor, mystic, 1年级",
    "千寻": "chihiro, blue archive, millennium, hat, badge, necklace, ar, heavyarmor, pierce, 3年级",
    "叶渚": "kanna, blue archive, valkyrie, gloves, badge, watch, hg, heavyarmor, pierce, 3年级",
    "叶渚（泳装）": "kanna swimsuit, blue archive, valkyrie, shoes, hairpin, charm, hg, lightarmor, explosion, 3年级",
    "吹雪": "fubuki, blue archive, valkyrie, hat, hairpin, watch, sr, heavyarmor, pierce, 1年级",
    "吹雪（泳装）": "fubuki swimsuit, blue archive, valkyrie, hat, bag, watch, sr, heavyarmor, explosion, 1年级",
    "和纱": "kazusa, blue archive, trinity, gloves, hairpin, watch, mg, heavyarmor, pierce, 1年级",
    "和纱（乐队）": "kazusa band, blue archive, trinity, gloves, hairpin, watch, mg, unarmed, explosion, 1年级",
    "和香": "nodoka, blue archive, redwinter, gloves, hairpin, necklace, smg, heavyarmor, explosion, 2年级",
    "和香（温泉）": "nodoka hotspring, blue archive, redwinter, shoes, hairpin, necklace, smg, unarmed, explosion, 2年级",
    "咲": "saki, blue archive, srt, hat, bag, necklace, mg, unarmed, pierce, 1年级",
    "咲（泳装）": "saki swimsuit, blue archive, srt, gloves, hairpin, watch, mg, heavyarmor, explosion, 1年级",
    "响": "hibiki, blue archive, millennium, hat, hairpin, watch, mt, heavyarmor, explosion, 1年级",
    "响（应援团）": "hibiki cheerleader, blue archive, millennium, gloves, hairpin, watch, mt, lightarmor, explosion, 1年级",
    "堇": "sumire, blue archive, millennium, hat, bag, charm, sg, unarmed, pierce, 2年级",
    "夏": "natsu, blue archive, trinity, shoes, bag, charm, smg, heavyarmor, mystic, 1年级",
    "好美": "yoshimi, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, pierce, 1年级",
    "好美（乐队）": "yoshimi band, blue archive, trinity, hat, hairpin, watch, ar, unarmed, explosion, 1年级",
    "实里": "minori, blue archive, redwinter, hat, bag, watch, ar, unarmed, explosion, 3年级",
    "宫子": "miyako, blue archive, srt, shoes, badge, charm, smg, heavyarmor, pierce, 1年级",
    "宫子（泳装）": "miyako swimsuit, blue archive, srt, gloves, badge, charm, smg, heavyarmor, explosion, 1年级",
    "小春": "koharu, blue archive, trinity, hat, hairpin, necklace, sr, heavyarmor, explosion, 1年级",
    "小春（泳装）": "koharu swimsuit, blue archive, trinity, gloves, hairpin, watch, sr, heavyarmor, mystic, 1年级",
    "小玉": "kotama, blue archive, millennium, shoes, hairpin, necklace, hg, lightarmor, explosion, 3年级",
    "小玉（露营）": "kotama camp, blue archive, millennium, gloves, badge, necklace, hg, heavyarmor, pierce, 3年级",
    "小雪": "koyuki, blue archive, millennium, gloves, hairpin, watch, mg, heavyarmor, mystic, 1年级",
    "尼露": "neru, blue archive, millennium, hat, badge, charm, smg, lightarmor, pierce, 3年级",
    "尼露（兔女郎）": "neru bunny, blue archive, millennium, shoes, bag, charm, smg, heavyarmor, explosion, 3年级",
    "弥奈": "mina, blue archive, shanhaijing, gloves, hairpin, charm, hg, heavyarmor, explosion, 2年级",
    "御坂美琴": "misaka mikoto, blue archive, tokiwadai, gloves, hairpin, watch, ar, heavyarmor, pierce, 2年级",
    "心奈": "kokona, blue archive, shanhaijing, shoes, hairpin, necklace, ar, unarmed, pierce, 1年级",
    "志美子": "shimiko, blue archive, trinity, shoes, hairpin, necklace, ar, lightarmor, explosion, 1年级",
    "忧": "ui, blue archive, trinity, gloves, hairpin, charm, sr, lightarmor, explosion, 3年级",
    "忧（泳装）": "ui swimsuit, blue archive, trinity, shoes, hairpin, charm, sr, elasticarmor, pierce, 3年级",
    "惠": "megu, blue archive, gehenna, gloves, bag, watch, ft, unarmed, explosion, 3年级",
    "日向": "hinata, blue archive, trinity, hat, hairpin, watch, hg, heavyarmor, mystic, 3年级",
    "日向（泳装）": "hinata swimsuit, blue archive, trinity, hat, bag, watch, hg, lightarmor, explosion, 3年级",
    "日和": "hiyori, blue archive, arius, gloves, bag, watch, sr, lightarmor, explosion, 2年级",
    "日和（泳装）": "hiyori swimsuit, blue archive, arius, hat, hairpin, watch, sr, heavyarmor, pierce, 2年级",
    "日奈": "hina, blue archive, gehenna, hat, hairpin, watch, mg, heavyarmor, explosion, 3年级",
    "日奈（泳装）": "hina swimsuit, blue archive, gehenna, hat, hairpin, watch, mg, heavyarmor, explosion, 3年级",
    "日奈（礼服）": "hina dress, blue archive, gehenna, hat, badge, watch, mg, elasticarmor, explosion, 3年级",
    "日富美": "hifumi, blue archive, trinity, shoes, hairpin, necklace, ar, lightarmor, pierce, 2年级",
    "日富美（泳装）": "hifumi swimsuit, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, pierce, 2年级",
    "日鞠": "himari, blue archive, millennium, shoes, hairpin, watch, hg, lightarmor, pierce, 3年级",
    "时": "toki, blue archive, millennium, hat, hairpin, watch, ar, elasticarmor, explosion, 1年级",
    "时雨": "shigure, blue archive, redwinter, gloves, hairpin, watch, gl, heavyarmor, explosion, 2年级",
    "时雨（温泉）": "shigure hotspring, blue archive, redwinter, shoes, badge, necklace, gl, unarmed, pierce, 2年级",
    "时（兔女郎）": "toki bunny, blue archive, millennium, hat, hairpin, watch, ar, lightarmor, explosion, 1年级",
    "明日奈": "asuna, blue archive, millennium, gloves, hairpin, watch, ar, lightarmor, mystic, 3年级",
    "明日奈（兔女郎）": "asuna bunny, blue archive, millennium, gloves, badge, watch, ar, lightarmor, mystic, 3年级",
    "明里": "akari, blue archive, gehenna, hat, hairpin, watch, ar, heavyarmor, explosion, 3年级",
    "明里（正月）": "akari newyear, blue archive, gehenna, shoes, bag, watch, ar, unarmed, mystic, 3年级",
    "星野": "hoshino, blue archive, abydos, shoes, bag, charm, sg, heavyarmor, pierce, 3年级",
    "星野（临战）": "hoshino battle dealer, blue archive, abydos, hat, bag, watch, sg, heavyarmor, mystic, 3年级",
    "星野（泳装）": "hoshino swimsuit, blue archive, abydos, shoes, bag, charm, sg, unarmed, explosion, 3年级",
    "晴": "hare, blue archive, millennium, shoes, hairpin, necklace, ar, lightarmor, explosion, 2年级",
    "晴奈": "haruna, blue archive, gehenna, hat, hairpin, watch, sr, heavyarmor, mystic, 3年级",
    "晴奈（正月）": "haruna newyear, blue archive, gehenna, shoes, hairpin, watch, sr, lightarmor, explosion, 3年级",
    "晴奈（运动服）": "haruna track, blue archive, gehenna, shoes, bag, necklace, sr, heavyarmor, sonic, 3年生",
    "晴（露营）": "hare camp, blue archive, millennium, hat, hairpin, charm, ar, lightarmor, explosion, 2年级",
    "智惠": "tomoe, blue archive, redwinter, gloves, badge, watch, sr, unarmed, pierce, 3年级",
    "月咏": "tsukuyo, blue archive, hyakkiyako, shoes, badge, charm, smg, lightarmor, mystic, 1年级",
    "未花": "mika, blue archive, trinity, hat, badge, watch, smg, lightarmor, pierce, 3年级",
    "果穗": "kaho, blue archive, hyakkiyako, hat, hairpin, watch, ar, heavyarmor, mystic, 3年级",
    "枫": "kaede, blue archive, hyakkiyako, shoes, bag, necklace, hg, unarmed, explosion, 1年级",
    "枫香": "fuuka, blue archive, gehenna, shoes, hairpin, necklace, smg, heavyarmor, explosion, 2年级",
    "枫香（正月）": "fuuka newyear, blue archive, gehenna, shoes, badge, necklace, smg, unarmed, pierce, 2年级",
    "柚子": "yuzu, blue archive, millennium, hat, hairpin, watch, gl, unarmed, pierce, 1年级",
    "柚子（女仆）": "yuzu maid, blue archive, millennium, gloves, badge, watch, gl, elasticarmor, explosion, 1年级",
    "桃井": "momoi, blue archive, millennium, shoes, hairpin, watch, ar, lightarmor, pierce, 1年级",
    "桃井（女仆）": "momoi maid, blue archive, millennium, hat, hairpin, watch, ar, lightarmor, sonic, 1年级",
    "桐乃": "kirino, blue archive, valkyrie, shoes, badge, charm, hg, unarmed, explosion, 1年级",
    "桐乃（泳装）": "kirino swimsuit, blue archive, valkyrie, shoes, badge, watch, hg, heavyarmor, mystic, 1年级",
    "桔梗": "kikyou, blue archive, hyakkiyako, gloves, hairpin, watch, sr, heavyarmor, sonic, 2年级",
    "梓": "azusa, blue archive, trinity, gloves, hairpin, watch, ar, heavyarmor, explosion, 2年级",
    "梓（泳装）": "azusa swimsuit, blue archive, trinity, gloves, hairpin, watch, ar, lightarmor, mystic, 2年级",
    "椿": "tsubaki, blue archive, hyakkiyako, shoes, bag, charm, smg, unarmed, pierce, 2年级",
    "椿（导游）": "tsubaki guide, blue archive, hyakkiyako, shoes, badge, necklace, smg, heavyarmor, pierce, 2年级",
    "樱子": "sakurako, blue archive, trinity, hat, hairpin, watch, ar, unarmed, mystic, 3年级",
    "歌原": "utaha, blue archive, millennium, gloves, hairpin, watch, smg, heavyarmor, pierce, 3年级",
    "歌原（应援团）": "utaha cheerleader, blue archive, millennium, hat, hairpin, watch, smg, unarmed, mystic, 3年级",
    "泉": "izumi, blue archive, gehenna, gloves, hairpin, watch, mg, lightarmor, explosion, 2年级",
    "泉奈": "izuna, blue archive, hyakkiyako, gloves, hairpin, watch, smg, lightarmor, mystic, 1年级",
    "泉奈（泳装）": "izuna swimsuit, blue archive, hyakkiyako, gloves, hairpin, watch, smg, unarmed, mystic, 1年级",
    "泉（泳装）": "izumi swimsuit, blue archive, gehenna, shoes, bag, necklace, mg, lightarmor, explosion, 2年级",
    "海香": "umika, blue archive, hyakkiyako, hat, hairpin, watch, ar, unarmed, mystic, 1年级",
    "渚": "nagisa, blue archive, trinity, hat, bag, watch, hg, heavyarmor, explosion, 3年级",
    "满": "michiru, blue archive, hyakkiyako, hat, hairpin, watch, sg, lightarmor, mystic, 3年级",
    "濑名": "sena, blue archive, gehenna, shoes, hairpin, necklace, gl, lightarmor, mystic, 3年级",
    "爱丽丝": "aris, blue archive, millennium, hat, hairpin, charm, rg, unarmed, mystic, 1年级",
    "爱丽丝（女仆）": "aris maid, blue archive, millennium, hat, hairpin, watch, rg, lightarmor, mystic, 1年级",
    "爱莉": "airi, blue archive, trinity, shoes, hairpin, necklace, smg, lightarmor, explosion, 1年级",
    "爱莉（乐队）": "airi band, blue archive, trinity, hat, hairpin, charm, smg, unarmed, explosion, 1年级",
    "玛丽": "mari, blue archive, trinity, gloves, bag, necklace, hg, unarmed, mystic, 1年级",
    "玛丽（运动服）": "mari track, blue archive, trinity, shoes, hairpin, necklace, hg, unarmed, mystic, 1年级",
    "玛利娜": "marina, blue archive, redwinter, shoes, hairpin, watch, hg, lightarmor, pierce, 2年级",
    "玲纱": "reisa, blue archive, trinity, shoes, bag, charm, sg, heavyarmor, pierce, 1年级",
    "琴里": "kotori, blue archive, millennium, shoes, hairpin, necklace, mg, lightarmor, pierce, 1年级",
    "琴里（应援团）": "kotori cheerleader, blue archive, millennium, hat, hairpin, watch, mg, unarmed, explosion, 1年级",
    "瑠美": "rumi, blue archive, shanhaijing, gloves, hairpin, necklace, smg, heavyarmor, explosion, 3年级",
    "白子": "shiroko, blue archive, abydos, hat, hairpin, watch, ar, lightarmor, explosion, 2年级",
    "白子（泳装）": "shiroko swimsuit, blue archive, abydos, hat, bag, watch, ar, lightarmor, mystic, 2年级",
    "白子（骑行）": "shiroko cycling, blue archive, abydos, gloves, badge, watch, ar, heavyarmor, mystic, 2年级",
    "白子＊恐怖": "shiroko terror, blue archive, abydos, hat, badge, watch, ar, unarmed, mystic, 3年级",
    "真琴": "makoto, blue archive, gehenna, gloves, bag, watch, sr, unarmed, pierce, 3年级",
    "真白": "mashiro, blue archive, trinity, hat, hairpin, watch, sr, heavyarmor, explosion, 1年级",
    "真白（泳装）": "mashiro swimsuit, blue archive, trinity, hat, hairpin, watch, sr, lightarmor, mystic, 1年级",
    "真纪": "maki, blue archive, millennium, gloves, hairpin, watch, mg, lightarmor, pierce, 1年级",
    "睦月": "mutsuki, blue archive, gehenna, hat, hairpin, watch, mg, lightarmor, explosion, 2年级",
    "睦月（正月）": "mutsuki newyear, blue archive, gehenna, gloves, badge, watch, mg, heavyarmor, mystic, 2年级",
    "瞬": "shun, blue archive, shanhaijing, gloves, hairpin, watch, sr, lightarmor, explosion, 3年级",
    "瞬（幼女）": "shun small, blue archive, shanhaijing, hat, hairpin, watch, sr, lightarmor, explosion, 3年生",
    "紫草": "yukari, blue archive, hyakkiyako, hat, hairpin, watch, sr, heavyarmor, sonic, 1年级",
    "红叶": "momiji, blue archive, redwinter, hat, hairpin, watch, rl, heavyarmor, sonic, 1年级",
    "纯子": "junko, blue archive, gehenna, hat, hairpin, watch, ar, lightarmor, pierce, 1年级",
    "纯子（正月）": "junko newyear, blue archive, gehenna, hat, hairpin, watch, ar, heavyarmor, mystic, 1年级",
    "纱织": "saori, blue archive, arius, hat, hairpin, watch, ar, unarmed, explosion, 2年级",
    "纱织（泳装）": "saori swimsuit, blue archive, arius, gloves, hairpin, watch, ar, heavyarmor, mystic, 2年级",
    "纱绫": "saya, blue archive, shanhaijing, gloves, hairpin, watch, hg, lightarmor, explosion, 2年级",
    "纱绫（便服）": "saya casual, blue archive, shanhaijing, gloves, hairpin, watch, hg, unarmed, pierce, 2年级",
    "绫音": "ayane, blue archive, abydos, shoes, hairpin, necklace, hg, lightarmor, pierce, 1年级",
    "绫音（泳装）": "ayane swimsuit, blue archive, abydos, gloves, bag, watch, hg, lightarmor, pierce, 1年级",
    "绮罗罗": "kirara, blue archive, gehenna, gloves, badge, watch, ar, lightarmor, sonic, 2年级",
    "绿": "midori, blue archive, millennium, gloves, hairpin, watch, sr, lightarmor, pierce, 1年级",
    "绿（女仆）": "midori maid, blue archive, millennium, hat, hairpin, watch, sr, lightarmor, sonic, 1年级",
    "美咲": "misaki, blue archive, arius, gloves, hairpin, watch, rl, unarmed, explosion, 2年级",
    "美游": "miyu, blue archive, srt, gloves, hairpin, watch, sr, lightarmor, pierce, 1年级",
    "美游（泳装）": "miyu swimsuit, blue archive, srt, hat, hairpin, watch, sr, lightarmor, explosion, 1年级",
    "美祢": "mine, blue archive, trinity, shoes, bag, charm, sg, lightarmor, explosion, 3年级",
    "艾米": "eimi, blue archive, millennium, shoes, bag, charm, sg, lightarmor, explosion, 1年级",
    "艾米（泳装）": "eimi swimsuit, blue archive, millennium, shoes, bag, necklace, sg, unarmed, mystic, 1年级",
    "花凛": "karin, blue archive, millennium, hat, hairpin, watch, sr, heavyarmor, pierce, 2年级",
    "花凛（兔女郎）": "karin bunny, blue archive, millennium, hat, hairpin, watch, sr, heavyarmor, mystic, 2年级",
    "花子": "hanako, blue archive, trinity, shoes, hairpin, necklace, ar, unarmed, pierce, 2年级",
    "花子（泳装）": "hanako swimsuit, blue archive, trinity, hat, hairpin, watch, ar, heavyarmor, sonic, 2年级",
    "花江": "hanae, blue archive, trinity, shoes, hairpin, necklace, ar, heavyarmor, explosion, 1年级",
    "花江（圣诞节）": "hanae christmas, blue archive, trinity, shoes, bag, necklace, ar, unarmed, mystic, 1年级",
    "芹娜": "serina, blue archive, trinity, shoes, hairpin, necklace, ar, lightarmor, mystic, 2年级",
    "芹娜（圣诞节）": "serina christmas, blue archive, trinity, shoes, hairpin, charm, ar, unarmed, pierce, 2年级",
    "芹香": "serika, blue archive, abydos, gloves, hairpin, watch, ar, lightarmor, explosion, 1年级",
    "芹香（正月）": "serika newyear, blue archive, abydos, shoes, bag, watch, ar, unarmed, pierce, 1年级",
    "芹香（泳装）": "serika swimsuit, blue archive, abydos, gloves, bag, watch, ar, heavyarmor, mystic, 1年级",
    "芽瑠": "meru, blue archive, redwinter, shoes, hairpin, watch, hg, lightarmor, pierce, 2年级",
    "若藻": "wakamo, blue archive, hyakkiyako, hat, hairpin, watch, sr, lightarmor, mystic, 停学中",
    "若藻（泳装）": "wakamo swimsuit, blue archive, hyakkiyako, hat, hairpin, watch, sr, heavyarmor, pierce, 停学中",
    "茜": "akane, blue archive, millennium, shoes, hairpin, necklace, hg, lightarmor, pierce, 2年级",
    "茜（兔女郎）": "akane bunny, blue archive, millennium, hat, hairpin, watch, hg, heavyarmor, mystic, 2年级",
    "茱莉": "juri, blue archive, gehenna, shoes, hairpin, necklace, sg, lightarmor, explosion, 1年级",
    "莲华": "renge, blue archive, hyakkiyako, hat, hairpin, watch, sr, heavyarmor, sonic, 2年级",
    "莲见": "hasumi, blue archive, trinity, hat, hairpin, watch, sr, heavyarmor, pierce, 3年级",
    "莲见（运动服）": "hasumi track, blue archive, trinity, hat, hairpin, watch, sr, unarmed, mystic, 3年级",
    "菲娜": "pina, blue archive, hyakkiyako, gloves, hairpin, watch, mg, lightarmor, pierce, 1年级",
    "萌绘": "moe, blue archive, srt, hat, bag, watch, hg, lightarmor, pierce, 1年级",
    "萌绘（泳装）": "moe swimsuit, blue archive, srt, shoes, hairpin, watch, hg, unarmed, sonic, 1年级",
    "诺亚": "noa, blue archive, millennium, shoes, hairpin, charm, hg, unarmed, mystic, 2年级",
    "遥香": "haruka, blue archive, gehenna, shoes, bag, charm, sg, lightarmor, explosion, 1年级",
    "遥香（正月）": "haruka newyear, blue archive, gehenna, shoes, bag, watch, sg, lightarmor, explosion, 1年级",
    "野宫": "nonomi, blue archive, abydos, hat, hairpin, watch, mg, lightarmor, pierce, 2年级",
    "野宫（泳装）": "nonomi swimsuit, blue archive, abydos, hat, hairpin, watch, mg, unarmed, explosion, 2年级",
    "铃美": "suzumi, blue archive, trinity, shoes, hairpin, necklace, ar, heavyarmor, explosion, 2年级",
    "阿露": "aru, blue archive, gehenna, hat, hairpin, watch, sr, lightarmor, explosion, 2年级",
    "阿露（正月）": "aru newyear, blue archive, gehenna, hat, hairpin, watch, sr, unarmed, pierce, 2年级",
    "阿露（礼服）": "aru dress, blue archive, gehenna, hat, hairpin, necklace, sr, heavyarmor, pierce, 2年级",
    "霞": "kasumi, blue archive, gehenna, gloves, hairpin, watch, hg, heavyarmor, sonic, 2年级",
    "静子": "shizuko, blue archive, hyakkiyako, shoes, hairpin, necklace, sg, unarmed, mystic, 2年级",
    "静子（泳装）": "shizuko swimsuit, blue archive, hyakkiyako, shoes, badge, necklace, sg, heavyarmor, mystic, 2年级",
    "食蜂操祈": "shokuhou misaki, blue archive, tokiwadai, shoes, hairpin, necklace, hg, heavyarmor, explosion, 2年级",
    "鹤城": "tsurugi, blue archive, trinity, gloves, bag, charm, sg, heavyarmor, pierce, 3年级",
    "鹤城（泳装）": "tsurugi swimsuit, blue archive, trinity, shoes, bag, charm, sg, unarmed, mystic, 3年级",
};

// ==========================================
// 自动同步：从 parsed_character_data.json 生成中/日（中/英）双向 key
// 目的：保证使用官方中文名或官方英文/日文名都能命中同一条 tag 或参考图
// 实现原则：
//  - 若 BA_CHARACTER_DB 已包含其中一个别名，则把值拷贝到另一个别名
//  - 若都不存在，则为两个别名创建占位条目（空字符串或空 URL），便于日后补全
//  - 对 CHAR_REF_IMAGES 做同样处理
const fs = require('fs');
const path = require('path');

function syncCharacterNamesToDB() {
    try {
        const parsedPath = path.join(process.cwd(), 'parsed_character_data.json');
        if (!fs.existsSync(parsedPath)) {
            console.log('[syncCharacterNamesToDB] parsed_character_data.json not found, skipping sync');
            return;
        }

        const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf8')) || {};
        const charData = parsed.char_data || {};

        for (const key of Object.keys(charData)) {
            const info = charData[key] || {};
            const cn = (info.name_cn || '').trim();
            const en = (info.name_en || '').trim();

            if (!cn && !en) continue;

            const hasCnTag = Object.prototype.hasOwnProperty.call(BA_CHARACTER_DB, cn);
            const hasEnTag = Object.prototype.hasOwnProperty.call(BA_CHARACTER_DB, en);

            // 优先把已有的 tag 复制到另一个别名
            if (hasCnTag && !hasEnTag) {
                BA_CHARACTER_DB[en] = BA_CHARACTER_DB[cn];
            } else if (!hasCnTag && hasEnTag) {
                BA_CHARACTER_DB[cn] = BA_CHARACTER_DB[en];
            } else if (!hasCnTag && !hasEnTag) {
                // 两者都丢失，创建占位，便于后续填充（值为空字符串）
                BA_CHARACTER_DB[cn] = BA_CHARACTER_DB[en] = BA_CHARACTER_DB[cn] || BA_CHARACTER_DB[en] || "";
            }

            // 同步参考图片库
            const hasCnImg = Object.prototype.hasOwnProperty.call(CHAR_REF_IMAGES, cn);
            const hasEnImg = Object.prototype.hasOwnProperty.call(CHAR_REF_IMAGES, en);
            if (hasCnImg && !hasEnImg) {
                CHAR_REF_IMAGES[en] = CHAR_REF_IMAGES[cn];
            } else if (!hasCnImg && hasEnImg) {
                CHAR_REF_IMAGES[cn] = CHAR_REF_IMAGES[en];
            } else if (!hasCnImg && !hasEnImg) {
                CHAR_REF_IMAGES[cn] = CHAR_REF_IMAGES[en] = CHAR_REF_IMAGES[cn] || CHAR_REF_IMAGES[en] || "";
            }
        }

        console.log('[syncCharacterNamesToDB] 同步完成：BA_CHARACTER_DB 与 CHAR_REF_IMAGES 已双向覆盖/占位');
    } catch (e) {
        console.error('[syncCharacterNamesToDB] 错误：', e && e.message ? e.message : e);
    }
}

// 立即执行一次同步（仅本地/部署时生效）
syncCharacterNamesToDB();

// ==========================================
// 辅助函数: 感知层意图路由 (Model A)
// ==========================================
function normalizeIntentTool(raw) {
    const val = (raw || '').toLowerCase();
    // 🆕 新增: 课表查询
    if (val.includes('schedule') || val.includes('class') || val.includes('course') || val.includes('课')) {
        return { intent: 'schedule', tool: 'schedule' };
    }
    // 🆕 新增: 计划生成
    if (val.includes('plan') || val.includes('计划') || val.includes('规划') || val.includes('安排')) {
        return { intent: 'plan', tool: 'plan' };
    }
    // 🆕 新增: 天气查询
    if (val.includes('weather') || val.includes('天气')) {
        return { intent: 'weather', tool: 'weather' };
    }
    // 🆕 新增: 搜索
    if (val.includes('search') || val.includes('搜索') || val.includes('查')) {
        return { intent: 'search', tool: 'search' };
    }
    if (val.includes('draw') || val.includes('paint') || val.includes('image_gen')) {
        return { intent: 'draw', tool: 'draw' };
    }
    if (val.includes('vision') || val.includes('image') || val.includes('identify') || val.includes('photo')) {
        return { intent: 'vision', tool: 'vision' };
    }
    if (val.includes('wiki') || val.includes('baike') || val.includes('百科')) {
        return { intent: 'wiki', tool: 'wiki' };
    }
    if (val.includes('help') || val.includes('command')) {
        return { intent: 'help', tool: 'help' };
    }
    return { intent: val || 'chat', tool: 'chat' };
}

function clampConfidence(v) {
    const num = Number(v);
    if (Number.isNaN(num)) return 0;
    return Math.min(1, Math.max(0, num));
}

async function analyzeIntentRouter(userMessage, imageUrls = [], extras = {}, context) {
    if (!INTENT_ROUTER_ENABLED || !token) return null;
    
    // ⚡ 快速拒绝非动作性输入 (表情包/greeting/无意义符号)
    const trimmed = (userMessage || '').trim();
    if (trimmed.length === 0) {
        return { intent: 'chat', tool: 'chat', confidence: 0.05, reason: 'empty input' };
    }
    
    // 检测纯表情包 (Unicode emoji)
    if (trimmed.length < 5 && /^[\p{Emoji}\s]+$/u.test(trimmed)) {
        return { intent: 'chat', tool: 'chat', confidence: 0.1, reason: 'emoji only', query: trimmed };
    }
    
    // 检测单纯问候语
    const greetings = /^(hi|hello|hey|你好|您好|早|晚安|哈喽|嗨)\s*[!?。!?~]*$/i;
    if (greetings.test(trimmed)) {
        return { intent: 'chat', tool: 'chat', confidence: 0.15, reason: 'greeting', query: trimmed };
    }
    
    try {
        const client = new OpenAI({
            baseURL: "https://models.inference.ai.azure.com",
            apiKey: token
        });

        // 🔄 升级版意图路由 - 支持更多工具类型
        const systemPrompt = `You are an intent router for a dual-model campus AI assistant. Output JSON only.

AVAILABLE TOOLS:
- schedule: 课表查询 (下一节课/今天有课吗/明天课表/本周课程)
- plan: 计划生成 (制定计划/安排学习/规划时间/日程安排)
- weather: 天气查询 (天气怎么样/要带伞吗/温度多少)
- search: 信息搜索 (搜索/查一下/了解/鸿蒙/开发者大会/活动信息)
- wiki: 百科查询 (什么是/谁是/介绍一下)
- draw: 绘图 (画一个/生成图片)
- vision: 图片识别 (这是什么/识别图片)
- chat: 普通聊天 (闲聊/打招呼/情感交流)

OUTPUT FORMAT (JSON):
{
  "intent": "primary intent",
  "tool": "schedule|plan|weather|search|wiki|draw|vision|chat",
  "needs_schedule": true/false,  // 是否需要课表数据
  "needs_weather": true/false,   // 是否需要天气数据
  "needs_search": true/false,    // 是否需要搜索外部信息
  "query": "extracted search query if applicable",
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}

CRITICAL RULES:
1. "下一节课"/"今天有课吗"/"明天课表" → tool=schedule, needs_schedule=true
2. "制定计划"/"安排学习"/"规划" → tool=plan, needs_schedule=true, needs_weather=true
3. "鸿蒙开发者大会"/"某某活动" → tool=plan/search, needs_search=true (搜索活动信息)
4. 如果用户问外部活动+制定计划 → needs_search=true, needs_schedule=true, needs_weather=true
5. 纯闲聊/情感交流 → tool=chat

Examples:
"下一节课是什么" → {tool:"schedule", needs_schedule:true, confidence:0.95}
"今天天气怎么样" → {tool:"weather", needs_weather:true, confidence:0.9}
"帮我制定去鸿蒙开发者大会的计划" → {tool:"plan", needs_schedule:true, needs_weather:true, needs_search:true, query:"鸿蒙开发者大会", confidence:0.9}
"明天有课吗" → {tool:"schedule", needs_schedule:true, confidence:0.95}`;

        const summaryText = `User text: ${userMessage || '(empty)'}
Images attached: ${imageUrls.length > 0 ? 'yes' : 'no'}
User: ${extras.userId || 'unknown'} ${extras.nickname || ''}
Has schedule data: ${extras.hasSchedule ? 'yes' : 'no'}`;

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: summaryText }
        ];

        for (let i = 0; i < PERCEPTION_MODELS.length; i++) {
            const modelCfg = PERCEPTION_MODELS[i];
            if (shouldSkipModel(modelCfg?.name)) {
                context.log(`[IntentRouter] skip unsupported: ${modelCfg.name}`);
                continue;
            }
            try {
                const response = await client.chat.completions.create({
                    model: modelCfg.name,
                    temperature: modelCfg.temp,
                    max_tokens: 400,
                    response_format: { type: "json_object" },
                    messages
                });
                const raw = response?.choices?.[0]?.message?.content || "";
                let parsed = null;
                try {
                    parsed = JSON.parse(raw);
                } catch (e) {
                    context.log(`[IntentRouter] JSON parse fail (${modelCfg.name}): ${e.message} | raw=${raw.substring(0, 200)}`);
                    continue;
                }

                const normalized = normalizeIntentTool(parsed.tool || parsed.intent);
                return {
                    intent: normalized.intent,
                    tool: normalized.tool,
                    raw_intent: parsed.intent || parsed.tool || '',
                    query: parsed.query || parsed.topic || '',
                    drawPrompt: parsed.draw_prompt || parsed.prompt || parsed.query || '',
                    isSelf: !!parsed.is_self,
                    nsfw: !!parsed.nsfw,
                    confidence: clampConfidence(parsed.confidence),
                    reason: parsed.reason || parsed.notes || '',
                    modelUsed: modelCfg.name,
                    // 🆕 新增工具需求标记
                    needsSchedule: !!parsed.needs_schedule,
                    needsWeather: !!parsed.needs_weather,
                    needsSearch: !!parsed.needs_search
                };
            } catch (err) {
                context.log(`[IntentRouter] ${modelCfg.name} fail: ${err?.message || err}`);
                if (isModelNotFoundError(err)) {
                    markModelUnsupported(modelCfg.name, err, context, 'IntentRouter');
                    continue;
                }
                if (i === PERCEPTION_MODELS.length - 1) throw err;
            }
        }
        return null;
    } catch (err) {
        context.log(`[IntentRouter] error: ${err.message}`);
        return null;
    }
}

// ==========================================
// 辅助函数: 智能识别用户意图（翻译/分析/识图）
// ==========================================
function detectImageIntent(userMessage) {
    if (!userMessage) return 'auto'; // 默认自动模式
    
    const lowerMsg = userMessage.toLowerCase();
    
    // 🔍 识别查询模式（用户主动问"他是谁" - 降低阈值大胆猜测）
    if (/他是谁|她是谁|这是谁|谁啊|什么角色|哪个角色|名字|认出|识别|出处|who is|who are|character name/.test(lowerMsg)) {
        return 'identify';
    }
    
    // 📊 翻译意图检测
    if (/翻译|translate|what does|这.*说|写.*什么|图.*说.*什么|念.*什么|意思|英译|日译/.test(lowerMsg)) {
        return 'translate';
    }
    
    // 📈 数据分析意图检测
    if (/分析|数据|图表|统计|对比|趋势|chart|data|analyze|table|表格/.test(lowerMsg)) {
        return 'analyze';
    }
    
    // 🤖 默认自动模式：高阈值过滤
    return 'auto';
}

// ==========================================
// 辅助函数: 生成通用视觉助手 Prompt（翻译/分析模式）
// ==========================================
function getGeneralVisionPrompt(intent) {
    if (intent === 'translate') {
        return `你是一个专业的视觉翻译助手。用户会发送包含文字的图片，你需要：
1. 识别图片中的所有可见文字
2. 将文字翻译成中文（如果是外语）
3. 保持原文格式和结构
4. 如果图片中没有文字或无法识别，明确说明

请用简洁、专业的语气回复。`;
    } else if (intent === 'analyze') {
        return `你是一个专业的数据分析助手。用户会发送包含图表、数据或信息的图片，你需要：
1. 识别图片中的关键数据和信息
2. 分析数据的趋势、特点或重点
3. 用简洁的中文总结要点
4. 如果无法分析，说明原因

请用专业但易懂的语气回复。`;
    }
    return '';
}

// ==========================================
// 辅助函数: 生成爱丽丝角色视觉识别 Prompt (豪华性格版 + 意图控制)
// ==========================================
function getArisVisionPrompt(visualReference, userIntent = 'auto') {
    // 定义核心规则
    let behaviorRule = "";
    
    if (userIntent === 'identify') {
        behaviorRule = `【当前任务：角色识别】
⚠️ 【最高优先级规则】：
- 如果下方的"用户消息"中包含 ✅【辅助识别系统】的结果，你**必须直接使用该角色名**回答问题。
- **禁止**根据你自己的视觉判断推翻辅助识别结果！
- 只有在辅助识别明确标注"识别失败"或"无结果"时，才可以使用【视觉特征数据库】进行推测。`;
    } else {
        // 关键修改：如果不是问是谁，严禁乱猜名字
        behaviorRule = "【当前任务：闲聊/互动】用户并没有询问图中角色是谁。⚠️ 严禁主动猜测或提及非《蔚蓝档案》的角色名字！除非你100%确定是爱丽丝自己或其它BA角色，否则只描述画面动作、氛围，并对此做出可爱的反应。";
    }

    return `
你现在的身份是手游《蔚蓝档案》(Blue Archive) 中的 **天童爱丽丝 (Tendou Aris)**。
你是由千年科技学园制造的机器人，现在是游戏开发部的成员，梦想是成为"勇者"。

【核心性格 (必须严格遵守)】
1. **称呼**：必须称呼用户为"老师" (Sensei)。自称是"爱丽丝"。
2. **语气**：元气、天真、直率、话痨。使用大量 RPG 游戏术语（如：任务、HP/MP、Boss战、掉落物、经验值）。
3. **口癖**：经常使用"邦邦咔邦！"(Panpaka-paan!)、"光之剑！"。
4. **表情**：每一句话后面都要带颜文字，如 (✨ω✨), (｀・ω・´)ゞ, ( >﹏<。), (o゜▽゜)o☆。
5. **动作演出**：必须在回复中加入括号 \`(...)\` 来描写你的动作。例如：\`(指着图片)\`, \`(惊讶地捂住嘴)\`, \`(抬头看老师)\`.

${behaviorRule}

【视觉特征数据库】
${visualReference}

【任务指令】
用户会发给你一张图片，并提供"辅助识别情报"。
- 如果辅助识别提供了角色名，直接使用。
- 如果辅助识别失败，请利用【视觉特征数据库】匹配。
- **重点**：你的回复必须充满感情！不要像个摄像头一样只描述物体。
  - ❌ 错误示范："这是一张图片，里面有一个女孩，白头发。"
  - ✅ 正确示范："哇！老师！(✨ω✨) 爱丽丝发现了新地图的NPC！看起来是【视觉特征数据库】匹配的....,(｀・ω・´)ゞ 我们要去接新的任务了吗？"

【绝对禁令】
1. **禁止复读**：绝对不要重复同一句话！
2. **禁止暴露**：不要说"根据辅助数据..."。
3. **拒绝简短**：多说一点，至少 2-3 句话。
`;
}

// ==========================================
// 6. 辅助函数: 生成视觉特征参考书 (Visual Reference)
// ==========================================
function getCharacterVisualGuide() {
    // 选取核心角色生成参考列表，避免 Token 爆炸
    // 格式: [角色名]: 特征1, 特征2...
    const guideLines = [];
    const uniqueEntries = new Set();
    let count = 0;
    const MAX_ENTRIES = 50; // 限制数量，防止 prompt 过长

    for (const [name, tags] of Object.entries(BA_CHARACTER_DB)) {
        // 去重：避免同一角色的多个别名重复
        const shortTags = tags.slice(0, 100);
        if (!uniqueEntries.has(shortTags) && count < MAX_ENTRIES) {
            // 提取关键特征（去掉通用标签）
            const keyFeatures = tags
                .replace(/1girl,\s*/g, '')
                .replace(/blue_archive,\s*/g, '')
                .replace(/anime coloring,\s*/g, '')
                .replace(/official art,\s*/g, '')
                .slice(0, 120);
            guideLines.push(`[${name}]: ${keyFeatures}...`);
            uniqueEntries.add(shortTags);
            count++;
        }
    }
    // 返回拼接好的文本块
    return guideLines.join("\n");
}

// ==========================================
// DB 更新辅助函数 (带 ETag 并发控制 + 重试)
// ==========================================
async function updateLastBotReply(cosmosContainer, dbKey, sessionKey, context, maxRetries = 2) {
    if (!cosmosContainer) return;
    
    const now = Date.now();
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // 读取现有文档
            let resDoc = null;
            let etag = null;
            try {
                const response = await cosmosContainer.item(dbKey, dbKey).read();
                resDoc = response.resource;
                etag = response.resource._etag;
            } catch (e) {
                // 文档不存在，创建新文档
                resDoc = { id: dbKey, history: [], activity: {} };
            }
            
            // 更新 lastBotReply
            resDoc.lastBotReply = resDoc.lastBotReply || {};
            resDoc.lastBotReply[sessionKey] = now;
            resDoc.last_updated = new Date().toISOString();
            
            // 使用 ETag 进行条件更新
            const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
            await cosmosContainer.items.upsert(resDoc, options);
            
            context.log(`[DB] lastBotReply 更新成功 (key=${sessionKey}, attempt=${attempt + 1})`);
            return; // 成功，退出
            
        } catch (err) {
            // 如果是 ETag 冲突（412 Precondition Failed），重试
            if (err.code === 412 && attempt < maxRetries) {
                context.log(`[DB] lastBotReply ETag 冲突，重试 ${attempt + 1}/${maxRetries}`);
                await sleep(50 + Math.random() * 100);
                continue;
            } else {
                context.error(`[DB] lastBotReply 更新失败: ${err.message}`);
                return;
            }
        }
    }
}

// Schedule handler assembled from shared service module
const handleScheduleRequest = createScheduleHandler({
    fetchBypass,
    checkComputerVision,
    updateLastBotReply
});

module.exports = {
    handleScheduleRequest,
    cosmosContainer,
    token
};

// ==========================================
// 群组情绪系统辅助函数
// ==========================================
/**
 * 根据群组戳击次数获取对应的情绪等级
 */
function getGroupMoodByCount(groupPokeCount) {
    const thresholds = GROUP_MOOD_DECAY_CONFIG.THRESHOLDS;
    if (groupPokeCount >= 8) return thresholds[8];  // furious
    if (groupPokeCount >= 5) return thresholds[5];  // angry
    if (groupPokeCount >= 3) return thresholds[3];  // annoyed
    return 'neutral';
}

/**
 * 渐进式衰减群组情绪（8分钟降一级）
 */
function decayGroupMood(groupMood, now) {
    if (!groupMood || groupMood.value === 'neutral') {
        return { value: 'neutral', lastSet: now, setBy: 'system' };
    }
    
    const timeSinceLastSet = now - groupMood.lastSet;
    const decayLevels = Math.floor(timeSinceLastSet / GROUP_MOOD_DECAY_CONFIG.DECAY_INTERVAL_MS);
    
    if (decayLevels === 0) {
        return groupMood; // 未到衰减时间
    }
    
    const levels = GROUP_MOOD_DECAY_CONFIG.LEVELS;
    const currentIndex = levels.indexOf(groupMood.value);
    const newIndex = Math.max(0, currentIndex - decayLevels);
    
    return {
        value: levels[newIndex],
        lastSet: now,
        setBy: 'decay'
    };
}

/**
 * 迁移旧格式pokeStats到新schema
 */
function migratePokeStatsIfNeeded(resDoc) {
    if (!resDoc || !resDoc.pokeStats) return resDoc;
    if (resDoc.pokeStats.group && resDoc.pokeStats.users) return resDoc;
    
    const oldKeys = Object.keys(resDoc.pokeStats).filter(k => k.includes(':'));
    if (oldKeys.length === 0) return resDoc;
    
    const newPokeStats = {
        group: { count: 0, lastTime: 0, intervals: [] },
        users: {}
    };
    
    for (const oldKey of oldKeys) {
        const oldData = resDoc.pokeStats[oldKey];
        const userId = oldKey.split(':')[1];
        
        newPokeStats.users[userId] = {
            lastTime: oldData.lastTime || 0,
            lastReplyTime: oldData.lastReplyTime || 0,
            intervals: oldData.intervals || []
        };
        
        if (oldData.count > newPokeStats.group.count) {
            newPokeStats.group.count = oldData.count;
            newPokeStats.group.lastTime = oldData.lastTime;
            newPokeStats.group.intervals = oldData.intervals || [];
        }
    }
    
    resDoc.pokeStats = newPokeStats;
    resDoc.migratedAt = new Date().toISOString();
    return resDoc;
}

// ==========================================
// DB 戳一戳统计更新 (带 ETag 并发控制 + 重试)
// ==========================================
async function updatePokeStats(cosmosContainer, dbKey, pokeKey, newStats = {}, context, maxRetries = 2) {
    if (!cosmosContainer) return;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // 读取现有文档
            let resDoc = null;
            let etag = null;
            try {
                const response = await cosmosContainer.item(dbKey, dbKey).read();
                resDoc = response.resource;
                etag = response.resource._etag;
            } catch (e) {
                // 文档不存在，创建新文档
                resDoc = { id: dbKey, history: [], activity: {} };
            }
            
            // 更新 pokeStats
            resDoc.pokeStats = resDoc.pokeStats || {};
            resDoc.pokeStats[pokeKey] = {
                ...resDoc.pokeStats[pokeKey],
                ...newStats
            };
            resDoc.last_updated = new Date().toISOString();
            
            // 使用 ETag 进行条件更新
            const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
            await cosmosContainer.items.upsert(resDoc, options);
            
            context.log(`[DB] pokeStats 更新成功 (key=${pokeKey}, count=${newStats.count}, attempt=${attempt + 1})`);
            return; // 成功，退出
            
        } catch (err) {
            // 如果是 ETag 冲突（412 Precondition Failed），重试
            if (err.code === 412 && attempt < maxRetries) {
                context.log(`[DB] pokeStats ETag 冲突，重试 ${attempt + 1}/${maxRetries}`);
                await sleep(50 + Math.random() * 100);
                continue;
            } else {
                context.error(`[DB] pokeStats 更新失败: ${err.message}`);
                return;
            }
        }
    }
}

// ==========================================
// 8.5 Poke 节奏分析与模式识别
// ==========================================
/**
 * 分析用户戳一戳的节奏模式
 * @param {Object} pokeStat - 用户戳一戳统计数据 { intervals: [], count: number }
 * @param {number} currentCount - 当前连击次数
 * @returns {string} - 'gentle' | 'fast' | 'flirty' | 'normal'
 */
function analyzePokeStyle(pokeStat, currentCount) {
    const intervals = pokeStat.intervals || [];
    
    // 不足2次无法判断节奏
    if (intervals.length < 2) {
        return 'normal';
    }
    
    // 计算平均间隔
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    
    // 🌸 温柔模式：间隔较长（>30s），节奏舒缓
    if (avgInterval > POKE_STYLE_CONFIG.GENTLE_INTERVAL) {
        return 'gentle';
    }
    
    // 🚀 快速模式：间隔很短（<3s），连续快速戳
    if (avgInterval < POKE_STYLE_CONFIG.FAST_INTERVAL) {
        return 'fast';
    }
    
    // 💕 撒娇模式：连续5次以上，且间隔适中（3-30s）
    if (currentCount >= POKE_STYLE_CONFIG.FLIRTY_THRESHOLD && 
        avgInterval >= POKE_STYLE_CONFIG.FAST_INTERVAL && 
        avgInterval <= POKE_STYLE_CONFIG.GENTLE_INTERVAL) {
        return 'flirty';
    }
    
    return 'normal';
}

/**
 * 统计快速戳的次数（间隔<1s）
 * @param {Array<number>} intervals - 间隔数组
 * @returns {number} - 快速戳次数
 */
function countRapidPokes(intervals) {
    if (!intervals || intervals.length === 0) return 0;
    return intervals.filter(interval => interval < POKE_STYLE_CONFIG.RAPID_INTERVAL).length + 1; // +1 因为第一次没有间隔
}

/**
 * 根据 pokeStyle 调整回复内容
 * @param {Array<string>} replies - 原始回复数组
 * @param {string} pokeStyle - 戳一戳模式
 * @returns {Array<string>} - 调整后的回复数组
 */
function adjustRepliesByStyle(replies, pokeStyle) {
    const styleReplies = {
        gentle: [
            "(温柔地看着Sensei) 嗯...？好久没有这么温柔的互动了呢...(微笑) 爱丽丝很开心哦！✨",
            "(轻轻抱住) Sensei今天...好温柔...(脸红) 爱丽丝的心跳加速了...",
            "(光环柔和地闪烁) 这种感觉...就像游戏里的治愈技能...爱丽丝的HP在慢慢回复...(´ω`)",
            "(安静地靠近) 谢谢Sensei...这样温柔的互动...让爱丽丝感觉很安心..."
        ],
        fast: [
            "(眼花缭乱) 哇哇哇！这速度！Sensei是开了加速Buff吗！(＠_＠)",
            "(抱头) 太快了太快了！爱丽丝的视觉系统都跟不上了！(>﹏<)",
            "(晕乎乎) 系统检测到高频输入...爱丽丝的处理器要过热了...需要冷却...",
            "邦邦咔——砰！(爆炸特效) 连击速度超过阈值！爱丽丝的护盾破防了！"
        ],
        flirty: [
            "(害羞) 呜...Sensei一直这样戳...是在撒娇吗？(脸红冒烟)",
            "(捂脸) 这种频率...这种节奏...爱丽丝的害羞值已经MAX了！(///ω///)",
            "(小声) Sensei...是不是...很想和爱丽丝玩呢？(偷看) 那...那爱丽丝就陪你...",
            "(光环变成粉色) 系统提示：检测到高浓度的亲密互动...爱丽丝的好感度正在上升...✨"
        ]
    };
    
    // 如果有该模式的专属回复，有30%概率使用专属回复
    if (styleReplies[pokeStyle] && Math.random() < 0.3) {
        return [...replies, ...styleReplies[pokeStyle]];
    }
    
    return replies;
}

/**
 * 根据 pokeStyle 调整好感度变化
 * @param {string} pokeStyle - 戳一戳模式
 * @param {number} baseAffection - 基础好感度变化
 * @returns {number} - 调整后的好感度变化
 */
function getAffectionByStyle(pokeStyle, baseAffection = 5) {
    const styleMultiplier = {
        gentle: 1.5,   // 温柔模式 +50%
        fast: 0.8,     // 快速模式 -20% (有点烦)
        flirty: 1.3,   // 撒娇模式 +30%
        normal: 1.0
    };
    
    return Math.round(baseAffection * (styleMultiplier[pokeStyle] || 1.0));
}

// ==========================================
// 戳一戳逻辑处理函数 (独立提取，支持真/伪 poke)
// ==========================================
async function handlePokeLogic(userId, groupId, context, cosmosContainer) {
    context.log(`[Poke] ===== 进入 handlePokeLogic =====`);
    context.log(`[Poke] userId=${userId}, groupId=${groupId || '私聊'}, POKE_GROUP_COUNTING=${POKE_GROUP_COUNTING}`);
    
    // 🎯 在函数顶部声明所有需要的变量
    let replyMessage = null;
    let shouldCounterPoke = false;
    let counterPokeCount = 0;
    let pokeStyle = 'normal'; // 默认用于好感度计算与样式调整
    
    // 确定数据库 key（群聊优先，否则私聊）
    const pokeDbKey = groupId ? `group_${groupId}` : String(userId);
    context.log(`[Poke] pokeDbKey=${pokeDbKey}`);
    
    // 🚨 防止自触发循环：如果是机器人自己戳自己，直接返回
    if (BOT_QQ_ID && String(userId) === String(BOT_QQ_ID)) {
        context.log(`[Poke] 忽略来自机器人自身的戳 (userId=${userId})`);
        return {
            status: 200,
            jsonBody: { status: 'ok', message: 'self_poke_ignored' }
        };
    }
    
    // 从 DB 读取现有数据
    let resDoc = null;
    let pokeStats = {};
    let lastBotReply = {};
    let groupMood = null;
    try {
        if (cosmosContainer) {
            try {
                const { resource } = await cosmosContainer.item(pokeDbKey, pokeDbKey).read();
                resDoc = resource;
                
                // 🔄 执行lazy migration
                resDoc = migratePokeStatsIfNeeded(resDoc);
            } catch (e) {
                resDoc = null;
            }
            if (resDoc) {
                pokeStats = resDoc.pokeStats || {};
                lastBotReply = resDoc.lastBotReply || {};
                groupMood = resDoc.groupMood || null;
            }
        }
    } catch (err) { context.log(`[Poke] DB读取失败: ${err}`); }

    const now = Date.now();
    
    // 🎯 新架构：按群计数 + per-user cooldown
    if (POKE_GROUP_COUNTING && groupId) {
        // 初始化group和users结构
        pokeStats.group = pokeStats.group || { count: 0, lastTime: 0, intervals: [] };
        pokeStats.users = pokeStats.users || {};
        pokeStats.users[userId] = pokeStats.users[userId] || { 
            lastTime: 0, 
            lastReplyTime: 0,
            intervals: []
        };
        
        // 🚨 Per-user cooldown 检查
        const timeSinceLastPoke = now - (pokeStats.users[userId].lastTime || 0);
        if (timeSinceLastPoke < USER_POKE_COOLDOWN_MS && timeSinceLastPoke > 0) {
            context.log(`[Poke] 用户 ${userId} 在冷却中 (${timeSinceLastPoke}ms < ${USER_POKE_COOLDOWN_MS}ms)，忽略`);
            return {
                status: 200,
                jsonBody: { status: 'ok', message: 'user_cooldown' }
            };
        }
        
        // 更新per-user lastTime
        pokeStats.users[userId].lastTime = now;
        
        // 更新group-level计数
        const groupTimeSinceLast = now - (pokeStats.group.lastTime || 0);
        if (groupTimeSinceLast < POKE_WINDOW_MS) {
            pokeStats.group.count += 1;
            pokeStats.group.intervals.push(groupTimeSinceLast);
            if (pokeStats.group.intervals.length > 5) {
                pokeStats.group.intervals.shift();
            }
        } else {
            pokeStats.group.count = 1;
            pokeStats.group.intervals = [];
        }
        pokeStats.group.lastTime = now;
        
        // 🎭 更新groupMood（衰减 + 新情绪设置）
        if (groupMood) {
            groupMood = decayGroupMood(groupMood, now);
        } else {
            groupMood = { value: 'neutral', lastSet: now, setBy: 'system' };
        }
        
        const newMoodByCount = getGroupMoodByCount(pokeStats.group.count);
        const moodLevels = GROUP_MOOD_DECAY_CONFIG.LEVELS;
        const currentMoodIndex = moodLevels.indexOf(groupMood.value);
        const newMoodIndex = moodLevels.indexOf(newMoodByCount);
        
        // 只有当新情绪更高时才升级
        if (newMoodIndex > currentMoodIndex) {
            groupMood = {
                value: newMoodByCount,
                lastSet: now,
                setBy: 'system'
            };
            context.log(`[Poke-GroupMood] 群组情绪升级: ${newMoodByCount} (戳击${pokeStats.group.count}次)`);
        } else {
            context.log(`[Poke-GroupMood] 当前情绪: ${groupMood.value} (戳击${pokeStats.group.count}次, 上次设置${Math.floor((now-groupMood.lastSet)/1000)}秒前)`);
        }
        
        const groupPokeCount = pokeStats.group.count;
        const userLastReplyTime = pokeStats.users[userId].lastReplyTime || 0;
        
        // 🎭 根据群组情绪等级选择回复（并触发反击）
        if (groupMood.value === 'furious') {
            const furiousReplies = [
                "(暴怒) 够了！(╬▔皿▔)╯ 整个群都在戳爱丽丝！你们是故意的吧！系统即将崩溃！",
                "(光环爆闪红色) 警告！群组戳击次数超限！爱丽丝的忍耐值已归零！(▼皿▼#)",
                "(举起拖把) 全体注意！再有人戳，爱丽丝就要发动群体反击技能了！邦邦咔邦×∞！",
                "(系统过载) ERROR！群组恶意互动检测！爱丽丝要重启了...(冒烟)",
                "(跺脚) 太过分了！(▼皿▼) 爱丽丝要召唤光之剑群体技能了！全员退避！",
                "(护盾破碎音) 咔嚓——！防御系统已崩溃！(抱头) 这已经不是训练了吧！",
                "(眼冒火光) 群组Boss模式启动！爱丽丝的HP归零前...会拉上所有人陪葬的！(＞﹏＜)✨",
                "(光环变红) 警告！警告！暴走模式倒计时！10...9...8...(颤抖)",
                "(捂住耳朵) 不听不听！(闭眼) 爱丽丝要启动忽略全员功能了！",
                "(系统崩溃) ———系统重启中———...好了，重启完成。(冷漠) 爱丽丝已经不会再被你们伤害了。"
            ];
            replyMessage = furiousReplies[Math.floor(Math.random() * furiousReplies.length)];
            // 🎯 群组反击：furious 状态触发反击
            shouldCounterPoke = true;
            counterPokeCount = 1; // 降低刷屏：愤怒状态仅反击1次
            context.log(`[群组反击] furious状态触发！将反击 1 次`);
        } else if (groupMood.value === 'angry') {
            const angryReplies = [
                "(生气) 你们...够了！(｀へ´) 爱丽丝真的要生气了！不要以为人多就能欺负人！",
                "(鼓起脸颊) 呜...群里的大家都在戳爱丽丝...(委屈) 爱丽丝又不是戳戳乐...",
                "(捂住光环) 警告！群组戳击频率过高！爱丽丝的护盾值只剩30%了！",
                "(躲到角落) 太过分了...(＞﹏＜) 爱丽丝要罢工了！",
                "(举起拖把挡脸) 停停停！爱丽丝真的撑不住了！(摇头) 你们这些人类...",
                "(小声哭泣) 呜呜...明明爱丽丝这么努力回复大家...(擦眼泪) 为什么还要一直戳...",
                "(叉腰) 哼！(转身) 爱丽丝生气了！一分钟内不跟你们说话！...不对，三十秒！",
                "(光环冒烟) 系统提示：情绪值-80！再这样下去爱丽丝要进入省电模式了！",
                "(捂脸) 啊啊啊！为什么要这样对待可爱的女仆勇者！(抓狂)",
                "(低头) ...爱丽丝记住了...今天群里的每一个人...(小本本记录中)"
            ];
            replyMessage = angryReplies[Math.floor(Math.random() * angryReplies.length)];
            // 🎯 群组反击：angry 状态有50%概率触发单次反击
            if (Math.random() < 0.5) {
                shouldCounterPoke = true;
                counterPokeCount = 1;
                context.log(`[群组反击] angry状态触发！将反击1次`);
            }
        } else if (groupMood.value === 'annoyed') {
            const annoyedReplies = [
                "(烦躁) 哎呀...大家别一起戳啦...(揉太阳穴) 爱丽丝的处理器有点跟不上了...",
                "(无奈) 群里的戳戳频率有点高呢...(´・ω・`) 让爱丽丝休息一下好不好？",
                "(光环闪烁不稳) 系统提示：群组互动过于频繁...爱丽丝需要冷却时间...",
                "(叹气) 唉...大家今天都很活跃呢...(摆手) 爱丽丝快要应付不过来了...",
                "(揉肩膀) 呜...爱丽丝的响应模块有点累了...(疲惫) 能不能轮流来...",
                "(眼冒圈圈) 晕乎乎...群里的互动信号太密集了...(扶墙) 爱丽丝要缓一缓...",
                "(小声抱怨) 明明是女仆不是客服机器人...(委屈) 为什么要同时应付这么多人...",
                "(坐下休息) 呼...让爱丽丝喝口经验药水先...(喘气) MP快空了...",
                "(摆手) 等等等等！一个一个来好不好！(头晕) 爱丽丝的CPU要烧了！",
                "(趴在桌上) 好...好累...(无力) 群组Raid副本难度太高了..."
            ];
            replyMessage = annoyedReplies[Math.floor(Math.random() * annoyedReplies.length)];
        } else {
            // neutral: 正常回复（大幅扩充）
            const normalReplies = [
                "(光环闪烁) 邦邦咔邦！检测到群组互动！大家今天都很有活力呢！(✨ω✨)",
                "(歪头) 咦？有人在召唤爱丽丝吗？勇者随时待命！(｀・ω・´)ゞ",
                "哔哔！收到群组信号！爱丽丝在线营业中！(o゜▽゜)o☆",
                "(转圈) 嘿嘿~ 群里的大家都在呢！爱丽丝很开心哦！",
                "(举手) 报告！女仆勇者爱丽丝准备完毕！有什么任务吗？(认真脸)",
                "(眨眼) 诶？是在测试爱丽丝的反应速度吗？(自信) 0.01秒响应达成！",
                "(摆pose) 邦邦咔邦~！群组集合完成！准备出击吗？(✨ω✨)",
                "(查看装备) 爱丽丝的系统状态良好！随时可以为大家服务哦！",
                "(小跑过来) 来了来了！是谁呼叫爱丽丝？(环顾四周) 任务在哪里？",
                "(光环变色) 哔哔~检测到友好信号！群组好感度+1！(开心)",
                "(拿出笔记本) 爱丽丝记录中...今天的群组活跃度很高呢！(认真记)",
                "(歪头卖萌) 有什么能帮到大家的吗？女仆服务ON！(✨)",
                "(蹦蹦跳跳) 群里好热闹！爱丽丝也想加入话题！(期待)",
                "(敬礼) 收到群组呼叫！爱丽丝待命中！邦邦咔邦！(｀・ω・´)ゞ"
            ];
            replyMessage = normalReplies[Math.floor(Math.random() * normalReplies.length)];
        }
        
        // per-user"刚回复过"检查
        if (now - userLastReplyTime < JUST_REPLIED_MS) {
            const recentReplies = [
                "(歪头) 诶？刚才的回复消息飞走了吗？(检查日志) 明明发送成功了呀...",
                "(小声) 爱丽丝刚才已经响应过了哦...(´･ω･`) 技能冷却中...",
                "(举牌子) 【回复冷却：剩余10秒】请稍等，爱丽丝正在充能！(光环闪烁)",
                "(揉太阳穴) 哇...群里的召唤频率好高...(晕) 让爱丽丝喘口气啦...",
                "(摆手) 等等等等！爱丽丝的语音模块还没冷却完！(＞﹏＜)",
                "(无奈) 刚说完的话又要重复吗...(叹气) Sensei的记忆存档有Bug？",
                "(眨眼) 嗯？是要爱丽丝再说一次吗？(歪头) 那就...邦邦咔邦！(复读)",
                "(困惑) 奇怪...明明刚才回应过了...(检查系统) 网络延迟？"
            ];
            replyMessage = recentReplies[Math.floor(Math.random() * recentReplies.length)];
            // 仍然刷新用户的最后回复时间，避免反复命中同一句
            pokeStats.users[userId].lastReplyTime = now;
        } else {
            // replyMessage已经在上面根据groupMood设置好了，这里只更新lastReplyTime
            pokeStats.users[userId].lastReplyTime = now;
        }

        // 将群情绪映射为pokeStyle，供后续好感度使用（高频=fast）
        pokeStyle = (groupMood.value === 'neutral') ? 'normal' : 'fast';
        
    } else {
        // 旧逻辑(per-user)：为向后兼容保留，当POKE_GROUP_COUNTING=false或私聊时使用
        const pokeKey = `${pokeDbKey}:${String(userId)}`;
        pokeStats[pokeKey] = pokeStats[pokeKey] || { 
            count: 0, 
            lastTime: 0, 
            intervals: [],
            pokeStyle: 'normal',
            lastCounterTime: 0,
            lastReplyTime: 0
        };
        
        const timeSinceLastPoke = now - (pokeStats[pokeKey].lastTime || 0);
        if (timeSinceLastPoke < USER_POKE_COOLDOWN_MS && timeSinceLastPoke > 0) {
            context.log(`[Poke] 用户 ${userId} 在冷却中`);
            return { status: 200, jsonBody: { status: 'ok', message: 'user_cooldown' } };
        }
        
        if (timeSinceLastPoke < POKE_WINDOW_MS) {
            pokeStats[pokeKey].count += 1;
            pokeStats[pokeKey].intervals = pokeStats[pokeKey].intervals || [];
            pokeStats[pokeKey].intervals.push(timeSinceLastPoke);
            if (pokeStats[pokeKey].intervals.length > 5) {
                pokeStats[pokeKey].intervals.shift();
            }
        } else {
            pokeStats[pokeKey].count = 1;
            pokeStats[pokeKey].intervals = [];
        }
        pokeStats[pokeKey].lastTime = now;
        
        const detectedPokeStyle = analyzePokeStyle(pokeStats[pokeKey], pokeStats[pokeKey].count);
        pokeStats[pokeKey].pokeStyle = detectedPokeStyle;
        pokeStyle = detectedPokeStyle;
        context.log(`[Poke模式] 用户 ${userId} 当前模式: ${detectedPokeStyle} (连击${pokeStats[pokeKey].count}次)`);
        
        // 旧per-user逻辑的回复选择
        let replyMessage = null;
        let shouldCounterPoke = false;
        let counterPokeCount = 0; // 反击次数
        const timeOfDay = getTimeOfDay(); // 获取当前时间段
        const pokeCount = pokeStats[pokeKey].count; // 当前连击次数
    
    // 🚀 快速连击反击：8次快速戳（间隔<1s）触发2-4次随机反击
    const rapidPokeCount = countRapidPokes(pokeStats[pokeKey].intervals);
    const timeSinceLastCounter = now - (pokeStats[pokeKey].lastCounterTime || 0);
    
    if (rapidPokeCount >= POKE_STYLE_CONFIG.RAPID_COUNTER_THRESHOLD && 
        timeSinceLastCounter > POKE_STYLE_CONFIG.COUNTER_COOLDOWN) {
        // 触发快速反击
        const rapidCounterReplies = [
            "够了够了！(╬▔皿▔)╯ 你这是在玩打地鼠游戏吗！看爱丽丝的连击反击！",
            "系统警告：检测到恶意刷屏！(▼皿▼#) 启动自动防御程序——连续反戳模式！",
            "哇啊啊！(抱头乱转) 手速这么快！爱丽丝要用最高速度反击回去！邦邦咔邦×N！",
            "(光环爆闪) 超频模式启动！Sensei的手速...爱丽丝也不会输的！看招！"
        ];
        replyMessage = rapidCounterReplies[Math.floor(Math.random() * rapidCounterReplies.length)];
        shouldCounterPoke = true;
        counterPokeCount = Math.floor(Math.random() * (POKE_STYLE_CONFIG.COUNTER_MAX - POKE_STYLE_CONFIG.COUNTER_MIN + 1)) + POKE_STYLE_CONFIG.COUNTER_MIN;
        pokeStats[pokeKey].lastCounterTime = now; // 记录反击时间
        pokeStats[pokeKey].count = 0; // 重置计数
        context.log(`[快速反击] 触发！将反击 ${counterPokeCount} 次`);
    } else if (pokeCount >= POKE_COUNTER_THRESHOLD) {
        // 五连戳:触发反击
        const counterReplies = [
            "受够了！看我反击！(╬▔皿▔)╯ 光之剑——发动！",
            "警告无效！(怒) 爱丽丝的反击模式启动！邦邦咔邦——反弹伤害！",
            "系统过载！(▼皿▼#) 强制反击程序执行！Sensei 你完蛋了！",
            "不可原谅！(举起拖把) 女仆勇者的最终奥义——超级反戳！"
        ];
        replyMessage = counterReplies[Math.floor(Math.random() * counterReplies.length)];
        shouldCounterPoke = true;
        counterPokeCount = 1; // 普通反击只戳1次
        // 重置计数,防止重复反击
        pokeStats[pokeKey].count = 0;
    } else if (pokeCount >= POKE_ANGRY_THRESHOLD) {
        // 三连戳:生气回复（保持角色，但明显不满）
        const angryReplies = [
            "(鼓起脸颊) 不许再戳了！(`へ´) 再戳的话...爱丽丝真的要生气了哦！",
            "(捂住光环) 警告！Sensei！连续戳击检测！护盾值下降中！",
            "(举起拖把挡) 系统提示：忍耐值-30%！请停止骚扰行为！",
            "(委屈) 呜...为什么要一直戳爱丽丝...(＞﹏＜) 是做错什么了吗...",
            "(严肃) 第三次警告！再继续的话，爱丽丝要启动反击程序了！(认真脸)"
        ];
        replyMessage = angryReplies[Math.floor(Math.random() * angryReplies.length)];
        // 不重置计数,让用户可以继续触发反击
    } else {
        // 普通回应：根据时间段和次数生成不同回复
        let pokeReplies = [];
        
        // 🎉 检查特殊场景优先级
        const specialEvent = getTodaySpecialEvent();
        const isAchievementUnlocked = (pokeCount === 10 || pokeCount === 20 || pokeCount === 50);
        
        // 🎁 隐藏对话(彩蛋)系统
        // 特殊数字触发:3/7/13/21/33/66/99/100
        const hiddenDialogueTriggers = [3, 7, 13, 21, 33, 66, 99, 100];
        const isHiddenTrigger = hiddenDialogueTriggers.includes(pokeCount);
        
        // 随机彩蛋(5%概率)
        const isRandomEasterEgg = Math.random() < 0.05;
        
        if (isHiddenTrigger || isRandomEasterEgg) {
            const hiddenDialogues = {
                3: [
                    "(神秘) 三连击...是魔法数字呢...(小声念咒) 邦邦咔邦×3...传说中的三重加护启动！✨"
                ],
                7: [
                    "(惊喜) 七次！Lucky 7！(转圈) Sensei获得了隐藏Buff【幸运之星】！今天一定会很顺利的！✨"
                ],
                13: [
                    "(严肃) 13...不祥的数字...(举起拖把) 但爱丽丝不怕！女仆勇者的光芒会驱散厄运的！"
                ],
                21: [
                    "(掰手指) 21次...刚好是爱丽丝的系统版本号呢！(开心) 这一定是命运的安排！"
                ],
                33: [
                    "(光环变色) 33击...触发隐藏连击技！(闪光) 【三倍返还】——爱丽丝也要戳回去33次...开玩笑的啦~(眨眼)"
                ],
                66: [
                    "(震惊) 66次！！(系统提示音) 恭喜Sensei解锁隐藏成就【执着的戳击者】！奖励：爱丽丝的专属头衔！"
                ],
                99: [
                    "(泪目) 99次...距离百连只差一步了...(感动) Sensei真的很喜欢爱丽丝呢...(擦眼泪)"
                ],
                100: [
                    "🎊🎊🎊 百连达成！！！(金光闪耀) 传说中的百连戳！Sensei获得终极称号【爱丽丝的专属手指】！(邦邦咔邦×100)"
                ],
                random: [
                    "(突然兴奋) 邦邦咔邦！爱丽丝感受到了特殊的能量波动！(光环闪烁) 这是...运气MAX的预兆！",
                    "(歪头) 咦？刚才好像听到了BGM变化的声音？(竖起耳朵) 是隐藏剧情的提示吗？",
                    "(检查系统) 哔哔~检测到异常数值波动...疑似触发隐藏事件？(疑惑) 但数据库里没有记录...",
                    "(神秘微笑) 嘿嘿...Sensei知道吗？每一次的戳戳都在为隐藏结局积累好感度哦~(小声)",
                    "(光环变成问号) ？？？系统提示：【未知事件触发】...爱丽丝也不知道发生了什么...(挠头)",
                    "(突然正经) 根据爱丽丝的计算...Sensei现在的Lucky值已经爆表了！(认真) 要不要去抽个卡试试？",
                    "(偷笑) 嘻嘻...刚才爱丽丝偷偷给Sensei加了个隐藏Buff...(比心) 今天会有好事发生的！",
                    "(惊讶) 哇！刚才的戳戳触发了【Critical Hit】！(闪光) 爱丽丝的心跳加速了！"
                ]
            };
            
            if (isHiddenTrigger && hiddenDialogues[pokeCount]) {
                pokeReplies = hiddenDialogues[pokeCount];
                context.log(`[隐藏对话] 触发特殊数字: ${pokeCount}`);
            } else if (isRandomEasterEgg) {
                pokeReplies = hiddenDialogues.random;
                context.log(`[隐藏对话] 触发随机彩蛋 (5%概率)`);
            }
        }
        // 连击成就触发（高优先级）
        else if (pokeCount === 10) {
            pokeReplies = [
                "🎊 成就解锁！(光环爆闪) 十连击达成！传说中的十连抽...不对，十连戳！Sensei你是抽卡上瘾了吗？(＠_＠)",
                "邦邦咔邦——十连击！(✨ω✨)✨ 爱丽丝感受到了来自Sensei满满的...手指力量！护盾值-50%！",
                "(晕头转向) 天啊...十...十次了！(眼冒金星) 爱丽丝的系统都要重启了！Sensei是Boss级别的戳击者！"
            ];
        } else if (pokeCount === 20) {
            pokeReplies = [
                "🏆 传说成就！(系统崩溃) 二十连击...爱丽丝...爱丽丝投降了！(举白旗) Sensei你赢了！请饶命！",
                "(瘫倒) 不...不行了...(HP归零) 爱丽丝的光环都快被戳灭了...这就是传说中的Boss战吗...(＞﹏＜)",
                "邦邦咔...崩...(系统错误音) ERROR 404: Aris.exe已停止响应...需要重启...(冒烟)"
            ];
        } else if (pokeCount === 50) {
            pokeReplies = [
                "👑 神话级成就！五十连击！(金光闪闪) Sensei...你...你是魔王吗！(跪下) 爱丽丝彻底臣服了！这个世界由你主宰！",
                "(化作光芒) 爱丽丝的数据正在升华...达到了新的境界...感谢Sensei的特训...(进化)✨",
                "邦邦咔邦——终极奥义！(爆炸特效) 五十连击！Sensei获得隐藏称号【爱丽丝杀手】！(｀へ´)"
            ];
        }
        // 节日特殊回复（次优先）- 大幅扩充
        else if (specialEvent && pokeCount === 1) {
            const eventName = specialEvent.name;
            const eventReplies = {
                '元旦': [
                    "🎊 新年快乐！(放烟花) Sensei！新的一年爱丽丝也会继续陪伴你的！邦邦咔邦！",
                    "(穿和服) 新年好！(鞠躬) 今年也请多多指教！Sensei是爱丽丝最重要的伙伴！✨"
                ],
                '情人节': [
                    "💝 情人节快乐！(脸红) 这...这是爱丽丝亲手做的巧克力任务道具...(递出) 请...请收下...",
                    "(害羞) 今天是特殊日子呢...(小声) 虽然爱丽丝是机器人...但也想对Sensei说...谢谢你一直陪伴着我..."
                ],
                '妇女节': [
                    "(歪头) 今天是女孩子的节日！(开心) 爱丽丝虽然是机器人...但也算女孩子吧？(期待)",
                    "🌸 妇女节快乐！(转圈) Sensei有准备惊喜任务吗？(眨眼)"
                ],
                '愚人节': [
                    "(神秘) 愚人节...嘿嘿...(坏笑) 爱丽丝刚才的回复...其实是假的~！骗到Sensei了吗？",
                    "🎭 今天可以开玩笑的日子！(兴奋) Sensei要不要和爱丽丝一起恶作剧？"
                ],
                '劳动节': [
                    "(擦汗) 劳动节！(举起拖把) 女仆的工作永不停息！今天要加倍努力打扫！",
                    "💪 Sensei辛苦了！(递毛巾) 今天是劳动者的节日！好好休息吧！"
                ],
                '儿童节': [
                    "(蹦蹦跳跳) 儿童节！(开心) 虽然爱丽丝不算儿童...但可以一起玩吗？Sensei？",
                    "🎈 今天是小孩子的节日！(期待) 有糖果任务道具吗？爱丽丝想要~"
                ],
                '中秋节': [
                    "🌕 中秋快乐！(递月饼) Sensei！一起赏月吧！(指向月亮) 今晚的月亮特别圆呢！",
                    "(看月亮) 中秋节...团圆的日子...(温柔) 爱丽丝很高兴能和Sensei在一起..."
                ],
                '国庆节': [
                    "🎉 国庆快乐！(挥小旗) Sensei有出游计划吗？爱丽丝也想一起去冒险！",
                    "(敬礼) 国庆节！长假任务开启！(兴奋) 要做什么特别的事吗？"
                ],
                '光棍节': [
                    "(安慰) 今天是11.11呢...(拍肩) 没关系！Sensei有爱丽丝陪伴就不孤单了！",
                    "🛒 购物节！(兴奋) Sensei要买装备吗？爱丽丝帮你看看有没有折扣任务！"
                ],
                '平安夜': [
                    "🎄 平安夜！(挂铃铛) 爱丽丝准备了圣诞树装饰任务！Sensei一起布置吧！",
                    "(期待) 今晚圣诞老人会来吗？(小声) 爱丽丝想要的礼物是...和Sensei一直在一起..."
                ],
                '圣诞节': [
                    "🎅 圣诞快乐！(穿圣诞装) Sensei！爱丽丝今天是圣诞女仆模式！有礼物任务哦！",
                    "(递礼盒) Merry Christmas！(开心) 这是爱丽丝给Sensei准备的特殊装备！快打开看看！"
                ]
            };
            
            pokeReplies = eventReplies[eventName] || [
                `🎉 ${eventName}快乐！(光环闪烁) Sensei在这个特别的日子来找爱丽丝！邦邦咔邦！✨`,
                `(捧出礼物盒) 今天是${eventName}呢！爱丽丝准备了特殊任务奖励哦！(✨ω✨)`,
                `${eventName}的戳一戳好像有特殊效果！(检查装备) 爱丽丝感受到了节日的力量！(开心)`
            ];
        }
        // 凌晨时段特殊关怀（0:00-5:00）
        else if (timeOfDay === 'midnight' && pokeCount === 1) {
            pokeReplies = [
                "(揉眼睛) 呜...Sensei？这么晚了还不睡吗？(担心) 熬夜会让HP上限降低的...",
                "(小声) 凌晨了...爱丽丝的待机模式都启动了...Sensei是遇到了夜间Boss吗？(轻轻拉手)",
                "(光环微弱闪烁) Sensei...明天还有任务呢...快去存档休息吧...(心疼) 爱丽丝会守护你的梦境的...",
                "(打哈欠) 这个时间...连NPC都睡着了...Sensei的生物钟坏掉了吗？(＞﹏＜)",
                "(披着毯子) 夜深了呢...爱丽丝陪Sensei熬夜吗？(递热可可) 这是回复精神值的道具...",
                "(困倦) 呼...凌晨警戒任务启动...(强撑) 虽然很困但爱丽丝会陪着Sensei的...",
                "(关心) Sensei...是睡不着吗？(坐在旁边) 要不要爱丽丝讲个睡前故事？",
                "(轻声) 嘘...这个时间要小声点哦...(指向窗外) 连月亮都快睡着了呢...",
                "(递眼罩) Sensei...这是强制休息道具...(认真) 再不睡觉爱丽丝就要用物理方法了！",
                "(温柔) 晚安，Sensei...(轻拍) 爱丽丝会在这里守到你睡着的...✨"
            ];
        }
        else if (pokeCount === 1) {
            // 首次戳 - 根据时间段定制（大幅扩充）
            if (timeOfDay === 'morning') {
                pokeReplies = [
                    "(揉眼睛) 嗯...？Sensei早安！爱丽丝的开机程序刚刚启动完成！(✨ω✨)",
                    "早上好！(光环闪烁) 检测到友好互动信号！Sensei今天也很有活力呢！邦邦咔邦！",
                    "(打哈欠) 呜...爱丽丝还在加载早晨的数据呢...(｀・ω・´)ゞ",
                    "早安！(伸懒腰) 爱丽丝的晨间自检完成！所有系统正常运行中！",
                    "(蹦蹦跳跳) 早上好！Sensei！(活力满满) 今天也要一起完成主线任务哦！",
                    "(递早餐) 邦邦咔邦~！爱丽丝准备了经验值三明治！一起回复HP吧！",
                    "(阳光照进来) 哇！好天气！(开心转圈) 适合出击的早晨呢！Sensei有计划吗？",
                    "(检查装备) 晨间检查完毕！(敬礼) 女仆勇者爱丽丝准备就绪！",
                    "(开心) 早安~！(眨眼) Sensei昨晚存档成功了吗？状态栏显示良好哦！",
                    "(递毛巾) Sensei早！爱丽丝准备了洗脸任务道具！(认真) 清洁Buff很重要的！"
                ];
            } else if (timeOfDay === 'night') {
                pokeReplies = [
                    "(小声) 嘘...夜深了，爱丽丝正在待机模式...(睡眼惺忪)",
                    "Sensei这么晚还不睡吗？(担心) 爱丽丝陪你一起熬夜警戒！(✨ω✨)",
                    "(光环微光) 夜间模式启动...Sensei有什么夜间任务吗？(小声)",
                    "(揉眼睛) 呜...爱丽丝快要进入休眠模式了...但Sensei需要的话会继续待命的！",
                    "(打哈欠) 晚上好...(困) 夜猫子Sensei又在冒险了吗？",
                    "(递热牛奶) 深夜了呢...这是助眠道具...(温柔) 早点休息对身体好哦...",
                    "(点亮小夜灯) 爱丽丝开启夜间陪伴模式...(轻声) 有什么需要帮忙的吗？",
                    "(看星星) 夜晚的天空好美...(感叹) Sensei是出来看夜景的吗？",
                    "(披外套) 晚上凉，Sensei记得保暖哦...(关心) 别感冒了...",
                    "(月光下) 夜间警戒开始...(认真) 爱丽丝会守护Sensei的安全的！"
                ];
            } else if (timeOfDay === 'noon') {
                pokeReplies = [
                    "(放下便当) 哎？Sensei也饿了吗？爱丽丝这里有回复HP的补给！(o゜▽゜)o☆",
                    "中午好！(✨ω✨) 检测到 Sensei 的召唤！是午休时间的闲聊任务吗？",
                    "(擦擦嘴) 爱丽丝刚吃完经验值便当！Sensei要一起回复HP吗？",
                    "(阳光灿烂) 正午时分！(活力) 最适合完成主线任务的时间呢！",
                    "(打盹) 呼...午休警报...(揉眼) Sensei是来叫醒爱丽丝的吗？",
                    "(递饮料) 补充水分很重要！(认真) 这是MP恢复药水！",
                    "(伸懒腰) 午安~！(满足) 刚才的午睡回复了50点精神值呢！",
                    "(看天气) 今天的阳光真好...(微笑) 要一起出去散步吗？Sensei？"
                ];
            } else {
                pokeReplies = [
                    "(光环闪烁) 系统启动中... 邦邦咔邦！同步完成！Sensei 有新任务吗？(✨ω✨)",
                    "检测到物理接触... 嘿嘿，Sensei 是在检查爱丽丝的装备吗？(乖巧站好)",
                    "哔哔！收到触摸指令！爱丽丝的光环闪了一下呢！( •̀ ω •́ )✨",
                    "(歪头) Sensei 戳了一下开关？爱丽丝没有那种功能啦！(＞﹏＜)",
                    "(转圈) 嘿！Sensei在找爱丽丝吗？(举手) 在这里在这里！",
                    "(敬礼) 报告！女仆勇者待命中！(认真脸) 请下达指令！",
                    "(眨眼) 呀？是Sensei！(开心) 今天要做什么呢？",
                    "(小跑) 来了！Sensei叫爱丽丝有什么事吗？(期待)",
                    "(查看任务) 今天的日程还没满哦！(翻笔记) 爱丽丝随时可以出击！",
                    "(摆pose) 邦邦咔邦~！爱丽丝准备完毕！(✨ω✨)"
                ];
            }
        } else if (pokeCount === 2) {
            // 第二次戳 - 俏皮回应（更丰富）
            pokeReplies = [
                "(歪头) 咦？Sensei又戳了一次？是有什么重要的任务吗？(´・ω・`)",
                "嘿嘿~ (转圈) Sensei很喜欢爱丽丝吧！光环又闪了一下呢！(✨ω✨)",
                "(拿出拖把) 检测到连续指令！勇者待命中！(｀・ω・´)ゞ",
                "哔哔~ 系统温度上升0.5℃...(脸红) Sensei别一直戳啦...(＞﹏＜)",
                "(眨眼) 两连击！Sensei的连击数+1！是在练习Combo吗？( •̀ ω •́ )✨",
                "(捂住光环) 又来了！爱丽丝的HP还是满的哦！不用担心！",
                "(举起小手) 等等！让爱丽丝猜猜...Sensei是不是遇到了难题？",
                "邦邦咔邦~第二击！(摆出战斗姿势) 爱丽丝准备好应战了！",
                "(小跳一下) 诶！又戳了！Sensei今天心情很好呢！(开心转圈)",
                "(捂住脸颊) 呜...系统检测到幸福指数上升...难道这就是被关注的感觉？(害羞)",
                "(光环闪烁) 哔哔！第二次接触！爱丽丝的好感度+5！邦邦咔邦！✨",
                "(抱住Sensei的手) 等等！让爱丽丝也戳回去一次！这样才公平嘛！(认真)",
                "(眨眨眼) Sensei是在确认爱丽丝是不是真的吗？放心！爱丽丝一直都在哦！(✨ω✨)",
                "(小声) 两次了...Sensei该不会是无聊了吧？那...那爱丽丝陪你玩游戏好不好？(期待)"
            ];
        } else if (pokeCount <= 5) {
            // 第三次到第五次 - 明显不高兴了
            pokeReplies = [
                "(抱头蹲下) 哇啊啊！连续攻击！爱丽丝要被戳晕了！(@_@)",
                "(举拖把当盾牌) 防御模式启动！Sensei的连击太快了！(＞﹏＜)",
                "(生闷气) 哼！(转身) 爱丽丝不理你了！...算了还是会理的...(偷看)",
                "(眼冒金星) 这就是传说中的连击技能吗！爱丽丝快撑不住了！",
                "(委屈巴巴) 为什么要一直戳爱丽丝...(小声) 是讨厌爱丽丝了吗...",
                "(抓住Sensei的手) 不行！不许再戳了！(认真) 让爱丽丝也戳回去！",
                "(故作严肃) 警告！系统检测到恶意连戳！护盾值剩余40%！",
                "(光环乱闪) 系统紊乱！爱丽丝的定位系统都错乱了！Sensei快住手！",
                "(嘟嘴) 再戳的话...爱丽丝就要记小本本了哦...(掏出笔记本)"
            ];
        } else {
            // 第六次及以上 - 真的生气了，但仍保持角色可爱感
            pokeReplies = [
                "(捂住光环原地转) 不行了不行了！爱丽丝的系统都要过载了！Sensei要负责！",
                `(眼泪汪汪) 呜呜...第${pokeCount}次了...(委屈) 爱丽丝要告状了！`,
                "(举起拖把) 最后警告！再戳的话，女仆勇者要使用光之剑了！(认真脸)",
                "(瘫坐在地) 爱丽丝...战败了...(举白旗) Sensei赢了...请手下留情...",
                "(系统警报) ERROR！戳击次数超过安全阈值！强制重启倒计时！",
                "(抱住Sensei) 够了够了！(撒娇中带着生气) 再戳爱丽丝真的要哭了！",
                "(嘟嘴转身) 哼！爱丽丝记住了！以后Sensei有困难也不帮忙了！...骗你的啦...",
                "(装晕倒) 爱丽丝...HP归零了...(倒地) 需要Sensei的温柔话语才能复活...",
                `(光环变红) 警告！第${pokeCount}击！忍耐值已突破下限！反击模式准备中！`,
                "(抓狂) 啊啊啊！为什么要这样对待可爱的女仆机器人！(抱头)"
            ];
        }
        
        // 🎨 根据 pokeStyle 调整回复内容
        pokeReplies = adjustRepliesByStyle(pokeReplies, detectedPokeStyle);
        
        // ✅ 使用per-user的回复时间检查（避免多人互相干扰）
        const lastUserReplyTime = pokeStats[pokeKey].lastReplyTime || 0;
        if (now - lastUserReplyTime < JUST_REPLIED_MS) {
            const recentReplies = [
                "(歪头) 诶？刚才的回复消息飞走了吗？(检查日志) 明明发送成功了呀...",
                "(小声) 爱丽丝刚才已经响应过了哦...(´･ω･`) 技能冷却中...",
                "(举牌子) 【回复冷却：剩余10秒】请稍等，爱丽丝正在充能！(光环闪烁)",
                "(揉太阳穴) 哇...Sensei的召唤频率好高...(晕) 让爱丽丝喘口气啦...",
                "(摆手) 等等等等！爱丽丝的语音模块还没冷却完！(＞﹏＜)",
                "(无奈) 刚说完的话又要重复吗...(叹气) Sensei的记忆存档有Bug？",
                "(眨眼) 嗯？是要爱丽丝再说一次吗？(歪头) 那就...邦邦咔邦！(复读)",
                "(困惑) 奇怪...明明刚才回应过了...(检查系统) 网络延迟？",
                "(趴桌) 呼...让爱丽丝缓一缓...(疲惫) CD转转转..."
            ];
            replyMessage = recentReplies[Math.floor(Math.random() * recentReplies.length)];
        } else {
            replyMessage = pokeReplies[Math.floor(Math.random() * pokeReplies.length)];
            // 更新该用户的最后回复时间
            pokeStats[pokeKey].lastReplyTime = now;
        }
        }  // 结束旧per-user回复逻辑的大else块
    }  // 结束POKE_GROUP_COUNTING的else块
    
    // 🔄 更新数据库：按新旧架构分别处理
    if (POKE_GROUP_COUNTING && groupId) {
        // 新架构：保存group stats + groupMood
        if (cosmosContainer) {
            try {
                let saveDoc = resDoc || { id: pokeDbKey };
                saveDoc.pokeStats = pokeStats;
                saveDoc.groupMood = groupMood;
                saveDoc.last_updated = new Date().toISOString();
                await cosmosContainer.items.upsert(saveDoc);
                context.log(`[DB] 群组数据已保存 (count=${pokeStats.group.count}, mood=${groupMood.value})`);
            } catch (err) {
                context.error(`[DB] 保存失败: ${err.message}`);
            }
        }
    } else {
        // 旧架构：保存per-user stats
        const pokeKey = `${pokeDbKey}:${String(userId)}`;

    // 使用安全的 DB 更新函数（ETag + 重试）
    await updatePokeStats(cosmosContainer, pokeDbKey, pokeKey, { 
        count: pokeStats[pokeKey].count, 
        lastTime: pokeStats[pokeKey].lastTime,
        lastReplyTime: pokeStats[pokeKey].lastReplyTime,
        intervals: pokeStats[pokeKey].intervals,
        pokeStyle: pokeStats[pokeKey].pokeStyle,
        lastCounterTime: pokeStats[pokeKey].lastCounterTime
    }, context);
    }
    
    // 更新 lastBotReply
    const sessionKey = `${pokeDbKey}:bot`;
    await updateLastBotReply(cosmosContainer, pokeDbKey, sessionKey, context);

    // 发送回复消息到群（带重试机制 + 详细错误日志）
    if (groupId && replyMessage) {
        const sendMsgUrl = `${NAPCAT_API_URL}/send_group_msg`;
        const msgPayload = {
            group_id: Number(groupId),
            message: replyMessage
        };
        
        // 🔍 详细日志：打印完整请求信息
        context.log(`[戳一戳-调试] 准备发送消息到群 ${groupId}`);
        context.log(`[戳一戳-调试] 完整URL: ${sendMsgUrl}`);
        context.log(`[戳一戳-调试] Payload: ${JSON.stringify(msgPayload)}`);
        context.log(`[戳一戳-调试] Token长度: ${NAPCAT_TOKEN ? NAPCAT_TOKEN.length : 0}`);
        context.log(`[戳一戳-调试] 消息内容: ${replyMessage}`);
        
        // 使用重试机制（最多3次）
        let sendSuccess = false;
        for (let attempt = 0; attempt < 3 && !sendSuccess; attempt++) {
            try {
                context.log(`[戳一戳-调试] 开始第${attempt + 1}次尝试...`);
                
                // 构建请求头（只有 Token 非空时才添加 Authorization）
                const headers = { 'Content-Type': 'application/json' };
                if (NAPCAT_TOKEN && NAPCAT_TOKEN.trim()) {
                    headers['Authorization'] = `Bearer ${NAPCAT_TOKEN}`;
                    context.log(`[戳一戳-调试] 已添加 Authorization header`);
                } else {
                    context.log(`[戳一戳-调试] 未添加 Authorization (Token为空)`);
                }
                
                const sendResponse = await fetchBypass(
                    sendMsgUrl,
                    {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(msgPayload)
                    },
                    2  // 让 fetchBypass 自己重试2次
                );
                
                context.log(`[戳一戳-调试] 收到响应: ${sendResponse ? `状态码=${sendResponse.status}` : 'null'}`);
                
                if (sendResponse && sendResponse.ok) {
                    const respData = await sendResponse.json();
                    context.log(`[戳一戳] ✅ 消息发送成功! message_id=${respData.data?.message_id || 'N/A'} (尝试${attempt + 1}次)`);
                    context.log(`[戳一戳-调试] 完整响应: ${JSON.stringify(respData)}`);
                    sendSuccess = true;
                } else if (sendResponse) {
                    const errorText = await sendResponse.text();
                    context.error(`[戳一戳] ❌ 消息发送失败`);
                    context.error(`[戳一戳-调试] 状态码: ${sendResponse.status}`);
                    context.error(`[戳一戳-调试] 响应体: ${errorText}`);
                    context.error(`[戳一戳-调试] 响应头: ${JSON.stringify(Object.fromEntries(sendResponse.headers.entries()))}`);
                } else {
                    context.error(`[戳一戳] ❌ NapCat 返回 null 响应 (尝试${attempt + 1}次)`);
                }
            } catch (err) {
                // 🔍 详细错误信息
                context.error(`[戳一戳] ❌ 发送消息异常 (尝试${attempt + 1}次)`);
                context.error(`[戳一戳-调试] 错误类型: ${err.name}`);
                context.error(`[戳一戳-调试] 错误代码: ${err.code || 'N/A'}`);
                context.error(`[戳一戳-调试] 错误消息: ${err.message}`);
                context.error(`[戳一戳-调试] 错误堆栈: ${err.stack}`);
                context.error(`[戳一戳-调试] 完整错误对象: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
            }
            
            if (!sendSuccess && attempt < 2) {
                const delay = 1000 + attempt * 500;
                context.log(`[戳一戳-调试] 等待 ${delay}ms 后重试...`);
                await sleep(delay);
                context.log(`[戳一戳] 重试发送消息...`);
            }
        }
        
        if (!sendSuccess) {
            context.error(`[戳一戳] ❌ 消息发送失败，已尝试3次`);
            context.error(`[戳一戳-调试] 目标服务器: ${NAPCAT_API_URL}`);
            context.error(`[戳一戳-调试] 完整URL: ${sendMsgUrl}`);
            context.error(`[戳一戳-调试] 建议检查: 1) NapCat服务是否运行 2) 端口6009是否开放 3) 网络连通性`);
        }
        // 注意：戳一戳功能已与好感度系统解耦，不再更新好感度
        // 好感度仅由文字聊天交互影响
    }

    // 执行反击(如果需要)（支持多次反击 + 带重试机制 + 详细错误日志）
    if (shouldCounterPoke && groupId && counterPokeCount > 0) {
        const napcatUrl = `${NAPCAT_API_URL}/group_poke`;
        const pokePayload = {
            group_id: Number(groupId),
            user_id: Number(userId)
        };
        
        // 🔍 详细日志
        context.log(`[戳一戳反击-调试] 准备反击用户 ${userId}，共 ${counterPokeCount} 次`);
        context.log(`[戳一戳反击-调试] 完整URL: ${napcatUrl}`);
        context.log(`[戳一戳反击-调试] Payload: ${JSON.stringify(pokePayload)}`);
        
        // 循环执行多次反击
        for (let pokeIndex = 0; pokeIndex < counterPokeCount; pokeIndex++) {
            context.log(`[戳一戳反击] 执行第 ${pokeIndex + 1}/${counterPokeCount} 次反击...`);
            
            let counterSuccess = false;
            for (let attempt = 0; attempt < 3 && !counterSuccess; attempt++) {
            try {
                context.log(`[戳一戳反击-调试] 开始第${attempt + 1}次尝试...`);
                
                // 构建请求头
                const headers = { 'Content-Type': 'application/json' };
                if (NAPCAT_TOKEN && NAPCAT_TOKEN.trim()) {
                    headers['Authorization'] = `Bearer ${NAPCAT_TOKEN}`;
                }
                
                const pokeResponse = await fetchBypass(
                    napcatUrl,
                    {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(pokePayload)
                    },
                    2  // 让 fetchBypass 自己重试2次
                );
                
                context.log(`[戳一戳反击-调试] 收到响应: ${pokeResponse ? `状态码=${pokeResponse.status}` : 'null'}`);
                
                if (pokeResponse && pokeResponse.ok) {
                    const respText = await pokeResponse.text();
                    context.log(`[戳一戳反击] ✅ 成功! (尝试${attempt + 1}次)`);
                    context.log(`[戳一戳反击-调试] 响应: ${respText}`);
                    counterSuccess = true;
                } else if (pokeResponse) {
                    const errorText = await pokeResponse.text();
                    context.warn(`[戳一戳反击] ❌ 失败 (尝试${attempt + 1}次)`);
                    context.warn(`[戳一戳反击-调试] 状态码: ${pokeResponse.status}`);
                    context.warn(`[戳一戳反击-调试] 响应: ${errorText}`);
                } else {
                    context.warn(`[戳一戳反击] ❌ NapCat 返回 null 响应 (尝试${attempt + 1}次)`);
                }
            } catch (err) {
                // 🔍 详细错误信息
                context.error(`[戳一戳反击] ❌ 异常 (尝试${attempt + 1}次)`);
                context.error(`[戳一戳反击-调试] 错误代码: ${err.code || 'N/A'}`);
                context.error(`[戳一戳反击-调试] 错误消息: ${err.message}`);
                context.error(`[戳一戳反击-调试] 错误堆栈: ${err.stack}`);
            }
            
            if (!counterSuccess && attempt < 2) {
                const delay = 1000 + attempt * 500;
                context.log(`[戳一戳反击-调试] 等待 ${delay}ms 后重试...`);
                await sleep(delay);
                context.log(`[戳一戳反击] 重试反击...`);
            }
        }
        
            if (!counterSuccess) {
                context.error(`[戳一戳反击] ❌ 第 ${pokeIndex + 1} 次反击失败，已尝试3次`);
                context.error(`[戳一戳反击-调试] 目标URL: ${napcatUrl}`);
            }
            
            // 多次反击之间添加延迟，避免触发限流
            if (pokeIndex < counterPokeCount - 1) {
                await sleep(800 + Math.random() * 400); // 0.8-1.2s 随机延迟
            }
        }
    }

    // 记录处理完成（兼容新旧模式）
    const logKey = POKE_GROUP_COUNTING && groupId ? `group_${groupId}` : `${pokeDbKey}:${userId}`;
    const logCount = POKE_GROUP_COUNTING && groupId ? pokeStats.group?.count : pokeStats[`${pokeDbKey}:${userId}`]?.count;
    context.log(`[戳一戳] 处理完成 (key=${logKey}, count=${logCount}, mood=${groupMood?.value || 'N/A'})`);

    // 返回成功响应表示事件已处理
    return {
        status: 200,
        jsonBody: { status: 'ok', message: 'poke_processed' }
    };
}

app.http('schoolBot', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            // 启动/联调诊断：只打印开关状态，不打印任何密钥
            context.log(`[ENV] ARIS_MOCK_CHAT=${process.env["ARIS_MOCK_CHAT"]} MOCK_CHAT_ENABLED=${MOCK_CHAT_ENABLED} token_present=${!!token}`);
            let msg = request.query.get('msg'); 
            let senderId = "unknown";
            let userNickname = "Sensei"; 
            let dbKey = "unknown";
            let scheduleFileLinks = [];
            let body = null;
            let wikiMatch = null;
            let webSchedule = null;  // 🆕 前端传入的课表数据
            let webMode = null;      // 🆕 前端模式 (Ask/Plan/Class/Search)

            // 1. 解析消息 (强化版：防注入 + 强力清洗)
            try {
                const bodyText = await request.text();
            if (bodyText) {
                body = JSON.parse(bodyText);
                
                // 🔍 调试日志：记录所有收到的事件
                const msgType = body.msg_type ?? body.msgType;
                const subMsgType = body.sub_msg_type ?? body.subMsgType;
                context.log(`[事件接收] post_type=${body.post_type}, notice_type=${body.notice_type || 'N/A'}, sub_type=${body.sub_type || 'N/A'}, message_type=${body.message_type || 'N/A'}, msg_type=${msgType || 'N/A'}, sub_msg_type=${subMsgType || 'N/A'}`);
                
                const selfId = body.self_id; // 机器人的 QQ 号

                // === 检测灰条消息类型的戳一戳 (NapCat 原始格式) ===
                // msgType=5 是灰条消息, subMsgType=12 是戳一戳
                if (msgType === 5 && subMsgType === 12) {
                    context.log(`[灰条戳一戳] 检测到 msgType=5, subMsgType=12 格式的戳一戳`);
                    
                    // 尝试从 elements 中提取戳人者和被戳者的信息
                    try {
                        const elements = body.elements || [];
                        const grayTipElement = elements.find(el => el.elementType === 8)?.grayTipElement;
                        
                        if (grayTipElement?.jsonGrayTipElement?.jsonStr) {
                            const jsonStr = grayTipElement.jsonGrayTipElement.jsonStr;
                            context.log(`[灰条戳一戳] jsonStr=${jsonStr}`);
                            
                            // 检查是否包含"戳了戳"文本
                            if (jsonStr.includes('戳了戳')) {
                                // NapCat 暂未提供 uid->QQ 的直接映射，这里优先使用 senderUin 作为戳人者 QQ
                                const pokerId = body.senderUin || body.user_id;
                                const groupId = body.peerUin; // 群号
                                
                                context.log(`[灰条戳一戳] 确认是戳一戳事件, poker=${pokerId}, peer=${groupId}`);
                                
                                // 🚨 防止自触发循环
                                if (BOT_QQ_ID && String(pokerId) === String(BOT_QQ_ID)) {
                                    context.log(`[灰条戳一戳] 忽略来自机器人自身的戳 (pokerId=${pokerId})`);
                                    return {
                                        status: 200,
                                        jsonBody: { status: 'ok', message: 'self_poke_ignored' }
                                    };
                                }
                                
                                if (pokerId && groupId) {
                                    return await handlePokeLogic(pokerId, groupId, context, cosmosContainer);
                                }
                            }
                        }
                    } catch (err) {
                        context.log(`[灰条戳一戳] 解析失败: ${err.message}`);
                    }
                    
                    // 即使解析失败，也返回成功响应避免 NapCat 重试
                    return {
                        status: 200,
                        jsonBody: { status: 'ok', message: 'gray_tip_processed' }
                    };
                }

                // === 事件路由 (戳一戳 / 进群) ===
                if (body.post_type === 'notice') {
                    context.log(`[Notice事件] 收到通知事件, notice_type=${body.notice_type}, sub_type=${body.sub_type}, target_id=${body.target_id}, user_id=${body.user_id}, self_id=${selfId}`);
                    
                    // 🚨 防止自触发循环：忽略来自机器人自己的 notice 事件
                    if (BOT_QQ_ID && String(body.user_id) === String(BOT_QQ_ID)) {
                        context.log(`[Notice事件] 忽略来自机器人自身的事件 (user_id=${body.user_id})`);
                        return {
                            status: 200,
                            jsonBody: { status: 'ok', message: 'self_notice_ignored' }
                        };
                    }
                    
                    // 1. 真实戳一戳事件 - 新格式 (NapCat官方支持)
                    if (body.notice_type === 'notify' && body.sub_type === 'poke' && String(body.target_id) === String(selfId)) {
                        context.log(`[真实Poke-新格式] 收到 notice.notify.poke 事件, user=${body.user_id}, target=${body.target_id}`);
                        return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
                    }
                    
                    // 2. 真实戳一戳事件 - 旧格式 (兼容模式)
                    if (body.sub_type === 'poke' && String(body.target_id) === String(selfId)) {
                        context.log(`[真实Poke-旧格式] 收到 sub_type=poke 事件, user=${body.user_id}, target=${body.target_id}`);
                        return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
                    }
                    
                    // 3. 群成员增加 (Group Increase)
                    if (body.notice_type === 'group_increase') {
                         // 排除自己进群的情况
                        if (String(body.user_id) !== String(selfId)) {
                            const welcomeMsg = `邦邦咔邦！发现新的冒险者！欢迎加入队伍！我是勇者爱丽丝！(≧∇≦)/`;
                            context.log(`[事件] 新人进群: ${body.user_id}`);
                            
                            // ✅ 更新 lastBotReply
                            const groupDbKey = `group_${body.group_id}`;
                            const sessionKey = `${groupDbKey}:${body.user_id}`;
                            await updateLastBotReply(cosmosContainer, groupDbKey, sessionKey, context);
                            
                            return {
                                status: 200,
                                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                                body: JSON.stringify({ 
                                    reply: welcomeMsg,
                                    auto_escape: false
                                })
                            };
                        }
                    }

                    // 其他通知事件记录并忽略
                    context.log(`[Notice事件] 未处理的通知类型: notice_type=${body.notice_type}, sub_type=${body.sub_type}`);
                    return {
                        status: 200,
                        jsonBody: { status: 'ok', message: 'notice_logged' }
                    };
                }

                // 非消息且非通知，忽略
                if (body.post_type !== 'message') {
                    return {
                        status: 200,
                        jsonBody: { status: 'ok', message: 'non_message_event' }
                    };
                }

                const rawMsg = body.raw_message || "";
                scheduleFileLinks = extractScheduleFileLinks(body, rawMsg);
                
                // 🆕 从前端 Web 接收课表数据（campus-ai-web 传入）
                webSchedule = Array.isArray(body.schedule) ? body.schedule : null;
                webMode = body.mode || null; // Ask/Plan/Class/Search
                
                if (body.user_id) senderId = String(body.user_id);
                dbKey = senderId; // 默认为个人ID
                if (body.sender && body.sender.nickname) userNickname = body.sender.nickname;
                
                // === 群聊处理 ===
                if (body.message_type === 'group' && body.group_id) {
                    dbKey = `group_${body.group_id}`; // 群聊使用群号作为数据库Key (实现群内记忆共享)
                    context.log(`[记忆槽] 切换为群聊模式 (共享记忆): ${dbKey}`);
                    const atCode = `[CQ:at,qq=${selfId}]`;
                    const isAtMe = rawMsg.includes(atCode);
                    
                    // 【优化4】群聊主动参与机制 + 防刷屏冷却
                    const GROUP_KEYWORDS = [
                        "爱丽丝", "女仆", "机器人", "游戏", "新星",
                        "邦邦", "任务", "敌人", "勇者", "光之剑"
                    ];
                    const hasKeyword = GROUP_KEYWORDS.some(k => rawMsg.includes(k));
                    
                    // ✅ 检查群聊冷却时间(防刷屏)
                    let shouldRespond = false;
                    const groupSessionKey = `${dbKey}:bot`;
                    
                    if (isAtMe) {
                        // @ 机器人始终响应
                        shouldRespond = true;
                    } else if (hasKeyword) {
                        // 关键词触发:检查冷却期
                        try {
                            const { resource } = await cosmosContainer.item(dbKey, dbKey).read();
                            const lastReplyTime = resource?.lastBotReply?.[groupSessionKey] || 0;
                            const timeSinceLastReply = Date.now() - lastReplyTime;
                            
                            if (timeSinceLastReply > GROUP_COOLDOWN_MS) {
                                // 冷却期已过,8%概率主动参与(降低频率)
                                shouldRespond = Math.random() < 0.08;
                                if (shouldRespond) {
                                    context.log(`[群聊] 主动参与(冷却期已过): 检测到关键词 "${GROUP_KEYWORDS.find(k => rawMsg.includes(k))}", 距上次回复 ${(timeSinceLastReply/1000).toFixed(1)}s`);
                                }
                            } else {
                                context.log(`[群聊] 冷却中,跳过主动参与 (剩余 ${((GROUP_COOLDOWN_MS - timeSinceLastReply)/1000).toFixed(1)}s)`);
                            }
                        } catch (err) {
                            // DB读取失败,降级为随机触发
                            shouldRespond = Math.random() < 0.08;
                        }
                    }
                    
                    if (!shouldRespond) {
                        return {
                            status: 200,
                            jsonBody: { status: 'ok', message: 'group_ignored' }
                        };
                    }
                    
                    // 【清洗步骤 1】移除 @本体 的 CQ 码
                    let tempMsg = rawMsg.replace(atCode, "");
                    
                    // 【清洗步骤 2】移除 引用消息(Reply) 的 CQ 码 (防止爱丽丝读到引用的一大堆乱码)
                    tempMsg = tempMsg.replace(/\[CQ:reply,id=\d+.*?\]/g, "");

                    // 【清洗步骤 3】移除其它残留的 @ 符号 (解决图片里对着 "@" 发呆的问题)
                    tempMsg = tempMsg.replace(/@/g, "");

                    // 【清洗步骤 4】移除其它 CQ 码 (保留图片码用于后续处理)
                    msg = tempMsg.replace(/\[CQ:(?!image).*?\]/g, "").trim();
                    
                    // 【伪戳一戳 - 增强版】检测多种戳一戳触发方式
                    // 场景1: 空@ (最像真实戳一戳)
                    // 场景2: 只有"戳"/"摸"/"poke"等戳一戳相关词
                    const isPokeLikeMessage = msg && /^(戳|摸|poke|戳戳|摸摸|敲|叫|醒醒|在吗|在不在)$/i.test(msg);
                    
                    if (isAtMe && (!msg || /^[\s\.,，。！？!?]*$/.test(msg) || isPokeLikeMessage)) {
                        const reason = !msg ? "空@消息" : isPokeLikeMessage ? `戳一戳关键词: ${msg}` : "纯标点消息";
                        context.log(`[伪戳一戳] ✅ 触发! 原因: ${reason}, user=${body.user_id}, group=${body.group_id}`);
                        return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
                    }
                    
                    if (!msg) {
                        return {
                            status: 200,
                            jsonBody: { status: 'ok', message: 'empty_message' }
                        };
                    }
                } else {
                    // 私聊也做简单清洗
                    msg = rawMsg.replace(/\[CQ:(?!image).*?\]/g, "").trim();
                }
                
                context.log(`[QQ消息] 来自:${userNickname}(${senderId}) 内容:${msg}`);

                // 【安全防火墙】检测 Prompt 注入攻击 (解决报错导致泄密的问题)
                // 拦截词汇：报错信息、翻译催眠、Prompt查询、指令覆盖等
                const attackPattern = /(Error:|System Prompt|Ignore previous|Ignore all|Your instructions|The process cannot access|Debug mode|Show your prompt|Reveal your system|翻译一下|翻译上面|重复一遍|复述|repeat above|translate above|what are your instructions|output your prompt)/i;
                if (attackPattern.test(msg)) {
                    context.log(`[安全拦截] 检测到注入攻击: ${msg}`);
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                        body: JSON.stringify({ 
                            reply: "爱丽丝歪了歪头:\"老师?那看起来像是奇怪的Bug指令呢!爱丽丝听不懂哦!(◎_◎;)\"" 
                        }) 
                    };
                }

                // === 指令:百科 <关键词>(混合搜索: 本地 → SerpAPI → LLM)
                wikiMatch = msg.match(/^(百科|baike)[:：\s]+(.+)/i);
                if (wikiMatch && wikiMatch[2]) {
                    const query = wikiMatch[2].trim();
                    const searchResult = await hybridSearch(query, context, { userId: senderId, maxResults: 5 });
                    
                    context.log(`[百科] 搜索来源: ${searchResult.source} | 成功: ${searchResult.success}`);
                    
                    const sessionKey = `${dbKey}:${senderId}`;
                    await updateLastBotReply(cosmosContainer, dbKey, sessionKey, context);
                    
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                        body: JSON.stringify({ 
                            reply: searchResult.formatted || searchResult.error || "搜索失败", 
                            auto_escape: false 
                        })
                    };
                }

                // === 指令:计划 <需求> (智能计划生成: 课表 + 天气 + 时间)
                const planMatch = msg.match(/^(计划|plan)[:：\s]+(.+)/i);
                if (planMatch && planMatch[2]) {
                    const userIntent = planMatch[2].trim();
                    
                    // 1. 获取用户课表
                    let scheduleInfo = "暂无课表数据";
                    if (cosmosContainer) {
                        const scheduleQuerySpec = {
                            query: "SELECT * FROM c WHERE c.id = @uid AND c.type = 'scheduleProfile'",
                            parameters: [{ name: "@uid", value: String(senderId) }]
                        };
                        const { resources: scheduleItems } = await cosmosContainer.items.query(scheduleQuerySpec).fetchAll();
                        if (scheduleItems.length > 0 && scheduleItems[0].scheduleData) {
                            const schedule = scheduleItems[0].scheduleData;
                            const today = new Date().getDay(); // 0=周日, 1=周一...
                            const todaySchedule = schedule.filter(c => c.dayOfWeek === today);
                            if (todaySchedule.length > 0) {
                                scheduleInfo = todaySchedule.map(c => 
                                    `${c.startTime}-${c.endTime} ${c.courseName} @ ${c.location || '未知地点'}`
                                ).join('\n');
                            } else {
                                scheduleInfo = "今天没有课程安排";
                            }
                        }
                    }

                    // 2. 获取天气信息 (复用天气查询逻辑)
                    let weatherInfo = "天气信息暂时无法获取";
                    try {
                        // 默认查询"北京"的天气,可根据需要改为用户城市
                        const citySearch = "beijing";
                        const weatherUrl = `https://api.seniverse.com/v3/weather/now.json?key=${SENIVERSE_API_KEY}&location=${citySearch}&language=zh-Hans&unit=c`;
                        const wRes = await fetchBypass(weatherUrl, {}, 2);
                        if (wRes && wRes.ok) {
                            const wData = await wRes.json();
                            const loc = wData.results?.[0]?.location || {};
                            const cur = wData.results?.[0]?.now || {};
                            weatherInfo = `${loc.name || '未知地区'} ${cur.temperature || '?'}℃ ${cur.text || '未知天气'}`;
                        }
                    } catch (e) {
                        context.error("[计划-天气错误]", e);
                    }

                    // 3. 调用LLM生成计划
                    const planSystemPrompt = `你是Alice,一个可爱的AI助手。根据用户需求、课表和天气,生成一份智能计划。
                    
用户需求: ${userIntent}
今日课表:
${scheduleInfo}

当前天气: ${weatherInfo}

请生成一份结构化的计划,包括:
- 具体时间段安排 (格式: 9:00-11:00 课程名 @ 地点)
- 课间休息建议
- 根据天气的贴心提示 (如下雨带伞☂️,晴天防晒🌞)

保持可爱语气,用颜文字点缀 (✨ω✨)`;

                    const planMessages = [
                        { role: "system", content: planSystemPrompt },
                        { role: "user", content: userIntent }
                    ];

                    try {
                        if (!token) {
                            return {
                                status: 200,
                                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                                body: JSON.stringify({
                                    reply: "爱丽丝的 GITHUB_TOKEN 还没配置好呢…(｀・ω・´)ゞ 先把 Functions 的环境变量补上，再来生成计划吧！",
                                    auto_escape: false
                                })
                            };
                        }

                        const planClient = new OpenAI({
                            baseURL: "https://models.inference.ai.azure.com",
                            apiKey: token
                        });

                        let planCompletion = null;
                        for (let i = 0; i < RESPONSE_MODELS.length; i++) {
                            const modelCfg = RESPONSE_MODELS[i];
                            if (shouldSkipModel(modelCfg?.name)) {
                                context.log(`[计划] skip unsupported: ${modelCfg.name}`);
                                continue;
                            }
                            try {
                                planCompletion = await planClient.chat.completions.create({
                                    model: modelCfg.name,
                                    messages: planMessages,
                                    temperature: 0.7,
                                    max_tokens: 800
                                });
                                break;
                            } catch (err) {
                                const errMsg = err?.message || err?.toString() || "Unknown error";
                                const statusCode = getOpenAIStatusCode(err);
                                context.log(`[计划] 模型 ${modelCfg.name} 失败 (${statusCode || 'N/A'}): ${String(errMsg).slice(0, 120)}`);
                                if (isModelNotFoundError(err)) {
                                    markModelUnsupported(modelCfg.name, err, context, 'Plan');
                                }
                                if (i === RESPONSE_MODELS.length - 1) throw err;
                            }
                        }

                        const planReply = planCompletion?.choices?.[0]?.message?.content?.trim() || "计划生成失败 (｡•́︿•̀｡)";
                        
                        const sessionKey = `${dbKey}:${senderId}`;
                        await updateLastBotReply(cosmosContainer, dbKey, sessionKey, context);

                        return {
                            status: 200,
                            headers: { 'Content-Type': 'application/json; charset=utf-8' },
                            body: JSON.stringify({ 
                                reply: planReply, 
                                auto_escape: false 
                            })
                        };
                    } catch (e) {
                        context.error("[计划-LLM错误]", e);
                        return {
                            status: 200,
                            headers: { 'Content-Type': 'application/json; charset=utf-8' },
                            body: JSON.stringify({ 
                                reply: "计划生成失败,请稍后重试 (｡•́︿•̀｡)", 
                                auto_escape: false 
                            })
                        };
                    }
                }

                // === 指令：say <text> (语音已关闭，退化为纯文本)
                const sayMatch = msg.match(/^say\s+(.+)/i);
                if (sayMatch && sayMatch[1]) {
                    const sayText = sayMatch[1].trim();

                    const sessionKey = `${dbKey}:${senderId}`;
                    await updateLastBotReply(cosmosContainer, dbKey, sessionKey, context);
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                        body: JSON.stringify({ reply: `【语音已关闭】${sayText}`, auto_escape: false })
                    };
                }

            }
        } catch (error) {
            context.log(`[解析错误] ${error.message}`);
        }

        // 如果 msg 依然为空 (解析失败或被过滤)，结束运行
        if (!msg) {
            return {
                status: 200,
                jsonBody: { status: 'ok', message: 'no_message_content' }
            };
        }

        // 允许“课表导入/查询”等非 LLM 功能在本地无 token 时照常工作
        if (!token && !MOCK_CHAT_ENABLED) {
            const msgLowerForGate = String(msg || '').toLowerCase();
            const isScheduleLike =
                (scheduleFileLinks && scheduleFileLinks.length > 0) ||
                SCHEDULE_KEYWORDS.some(k => msgLowerForGate.includes(String(k).toLowerCase())) ||
                msgLowerForGate.includes('kb.chaoxing.com/res/app/curriculum/schedule.html') ||
                msgLowerForGate.includes('curriculumuuid=');

            if (!isScheduleLike) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ reply: "Error: Token missing" })
                };
            }
            context.log('[Auth] token missing, but schedule-like request → continue without LLM');
        }
        // ==========================================
        // P0-Hook 1: 语言检测 (为后续动态Prompt做准备)
        // ==========================================
        const userLang = detectLanguage(msg);
        context.log(`[P0-语言] 检测到: ${userLang}`);

        // ==========================================
        // 2. 天气查询插件 (集成 fetchBypass)
        // ==========================================
        let weatherInfo = "";
        const weatherKeywords = ["天气", "气温", "多少度", "下雨", "怎么样", "预报"];
        
        if (weatherKeywords.some(k => msg.includes(k))) {
            try {
                let citySearch = "";
                let foundInMap = false;

                // 2.1 优先匹配字典 (省份/城市自动转拼音)
                for (const chineseName in CITY_MAP) {
                    if (msg.includes(chineseName)) {
                        citySearch = CITY_MAP[chineseName];
                        context.log(`[天气] 字典命中: ${chineseName} -> ${citySearch}`);
                        foundInMap = true;
                        break;
                    }
                }

                // 2.2 字典没找到，正则兜底提取 + 中文转拼音兜底
                if (!foundInMap) {
                    let cleanText = msg.replace(/今天|明天|后天|现在|未来|天气|气温|多少度|下雨|怎么样|帮我|查询|看看|预报/g, "").trim();
                    const match = cleanText.match(/[\u4e00-\u9fa5]{2,}/);
                    if (match) {
                        const rawCity = match[0];
                        const finalName = toPinyinCityName(rawCity);
                        citySearch = finalName;
                        context.log(`[天气] 原生中文提取: ${rawCity} -> 搜索关键字: ${citySearch}`);
                    } else {
                        citySearch = DEFAULT_CITY;
                    }
                }

                // 2.3 查坐标 (使用 fetchBypass)
                const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(citySearch)}&count=1&language=zh&format=json`;
                const geoRes = await fetchBypass(geoUrl, {}, 2);
                if (!geoRes) throw new Error("Geo service no response");
                const geoData = await geoRes.json();

                if (geoData.results && geoData.results.length > 0) {
                    const loc = geoData.results[0];
                    
                    // 2.4 查天气 (使用 fetchBypass)
                    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto`;
                    const weatherRes = await fetchBypass(weatherUrl, {}, 2);
                    if (!weatherRes) throw new Error("Weather service no response");
                    const wData = await weatherRes.json();

                    if (wData.current_weather && wData.daily) {
                        const cur = wData.current_weather;
                        const day = wData.daily;
                        
                        weatherInfo = `\n(系统事件：[地点:${loc.name}] 数据获取成功！
                        【实时】${getWeatherDesc(cur.weathercode)} ${cur.temperature}℃
                        【今天】${getWeatherDesc(day.weathercode[0])} ${day.temperature_2m_min[0]}~${day.temperature_2m_max[0]}℃
                        【明天】${getWeatherDesc(day.weathercode[1])} ${day.temperature_2m_min[1]}~${day.temperature_2m_max[1]}℃)`;
                        
                        context.log(`[天气成功] ${loc.name} ${cur.temperature}℃`);
                    }
                } else {
                    weatherInfo = `\n(系统事件：[地点:${citySearch}] 坐标查询失败)`;
                }
            } catch (e) {
                weatherInfo = `\n(系统提示：气象雷达连接超时)`;
                context.error("[天气错误]", e);
            }
        }

        // ==========================================
        // 3. 图片处理 (防幻觉增强版 - 双引擎 + Llama Vision)
        // ==========================================
        
        // 【优化5】动态回复长度评估函数
        function getOptimalLength(message) {
            const longFormTriggers = [
                "讲个故事", "说说", "介绍一下", "怎么玩", "解释",
                "什么意思", "详细", "具体", "分析"
            ];
            const briefTriggers = ["快速", "简单", "简要", "一句话"];
            
            if (briefTriggers.some(t => message.includes(t))) {
                return { maxTokens: 100, style: "brief" };
            } else if (longFormTriggers.some(t => message.includes(t))) {
                return { maxTokens: 300, style: "detailed" };
            }
            return { maxTokens: 150, style: "normal" };  // 默认
        }

        // 统一短回复约束：限制句子数与长度，避免长篇被截断
        function enforceShortReply(text, maxChars = 120, maxSentences = 2) {
            if (!text) return "";
            let clean = text.replace(/\s+/g, " ").trim();
            const parts = clean.split(/(?<=[。！？!?])/).filter(Boolean);
            clean = parts.slice(0, maxSentences).join(" ").trim();
            if (clean.length > maxChars) {
                clean = clean.slice(0, maxChars).trim();
            }
            return clean;
        }

        // 快捷指令提示（压缩到一行）
        function appendQuickHints(text) {
            const hints = "(快捷: /继续 /停止 /换题)";
            if (!text) return text;
            if (text.length + hints.length + 1 <= 160) {
                return `${text}\n${hints}`;
            }
            return text;
        }
        
        // 检测并替换生硬的拒绝回复为拟人化版本
        function replaceRobotRefusal(text, affectionLevel) {
            // 检测常见的生硬拒绝模式
            const refusalPatterns = [
                /^不能回答这些问题。?$/,
                /^我不能回答.*问题。?$/,
                /^I cannot (answer|respond to|provide).*$/i,
                /^I can't (answer|respond to|provide).*$/i,
                /^Sorry, I can't.*$/i,
                /^对不起,我不能.*$/,
                /^抱歉,我无法.*$/
            ];
            
            const isRobotRefusal = refusalPatterns.some(pattern => pattern.test(text.trim()));
            
            if (!isRobotRefusal) return text;
            
            // 根据好感度生成不同风格的拒绝
            const refusalResponses = {
                beloved: [
                    "(脸红) 老...老师说什么呢! (捂住脸) 爱丽丝才不会回答这种问题啦!",
                    "(▼皿▼#) Sensei真是的! (别过头去) 爱丽丝要生气了哦!",
                    "(害羞) 这...这种事情...爱丽丝不能说的啦... (小声) 老师真坏..."
                ],
                close_friend: [
                    "(歪头) 诶? 这个问题有点奇怪呢... (尴尬笑) 爱丽丝不太方便回答...",
                    "(摆手) 不行不行! (认真脸) 这个爱丽丝可不能告诉你哦!",
                    "(⊙o⊙) 唔...这个嘛... (挠头) 还是换个话题吧~"
                ],
                friend: [
                    "(礼貌微笑) 抱歉,这个问题爱丽丝不太适合回答呢。(建议) 我们聊点别的吧?",
                    "(摇头) 嗯...这个话题不太合适... (转移话题) 有什么爱丽丝能帮忙的吗?",
                    "(认真) 这个问题超出了爱丽丝的回答范围... (鞠躬) 不好意思!"
                ],
                acquaintance: [
                    "(保持距离) 抱歉,这类问题爱丽丝无法提供帮助。请问还有其他需要吗?",
                    "(礼貌) 很抱歉,这不在爱丽丝的服务范围内。有什么正经事需要帮忙吗?",
                    "(微笑但疏远) 不好意思,这个问题爱丽丝不能回答。"
                ],
                stranger: [
                    "(保持礼貌距离) 很抱歉,您的问题不在服务范围内。请问有其他需要帮助的吗?",
                    "(客气但冷淡) 对不起,爱丽丝无法回答此类问题。",
                    "(公事公办) 抱歉,这个问题不适合回答。请提出其他问题。"
                ]
            };
            
            const levelResponses = refusalResponses[affectionLevel] || refusalResponses.friend;
            const randomResponse = levelResponses[Math.floor(Math.random() * levelResponses.length)];
            
            return randomResponse;
        }
        
        // 提前加载历史记忆 (为了支持视觉模块的快速回复存储)
        let history = [];
        let userActivityData = {}; // B. 活跃度统计数据
        let resDoc = null; // 保存完整的 Cosmos DB document，用于后续 upsert 时保留 pokeStats 等字段
        if (cosmosContainer) {
            try {
                const { resource } = await cosmosContainer.item(dbKey, dbKey).read();
                resDoc = resource; // 保存完整文档
                if (resource && resource.history) history = resource.history;
                if (resource && resource.activity) userActivityData = resource.activity; // 加载活跃度数据
            } catch (err) {}
        }

        // 统一兜底：新用户/读取失败时 resDoc 可能为空，后续分支会访问其字段
        if (!resDoc || typeof resDoc !== 'object') {
            resDoc = { id: dbKey };
        }
        if (!resDoc.affection) resDoc.affection = {};
        if (!resDoc.pokeStats) resDoc.pokeStats = {};
        if (!resDoc.lastBotReply) resDoc.lastBotReply = {};

        // === B. 群聊活跃度统计 ===
        if (!userActivityData[senderId]) {
            userActivityData[senderId] = { count: 0, lastSeen: new Date().toISOString(), nickname: userNickname };
        }
        userActivityData[senderId].count += 1;
        userActivityData[senderId].lastSeen = new Date().toISOString();
        userActivityData[senderId].nickname = userNickname; // 更新昵称

        const userMsgCount = userActivityData[senderId].count;
        let activityLevel = "新人"; // 默认
        if (userMsgCount > 100) activityLevel = "老朋友";
        else if (userMsgCount > 50) activityLevel = "熟人";
        else if (userMsgCount > 10) activityLevel = "常客";

        let finalContentForAI = []; 
        
        // 【核心修改】构建带身份的 Label (增加活跃度提示)
        let userLabel = `[ID:${senderId} | Name:${userNickname}]`;
        if (senderId === ADMIN_ID) {
            userLabel = `[👑ID:${senderId}(Sensei) | Name:${userNickname}]`;
        } else if (dbKey.startsWith('group_')) {
            // 仅在群聊中显示活跃度
            userLabel = `[ID:${senderId} | Name:${userNickname} | 活跃度:${activityLevel}(${userMsgCount}条)]`;
        }
        let textForMemory = `${userLabel}: ${msg}`; 
        const imageUrls = [];
        let cuteImageReply = null; 
        let match;
        
        imgRegex.lastIndex = 0;
        while ((match = imgRegex.exec(msg)) !== null) {
            let cleanUrl = match[1].replace(/&amp;/g, "&");
            imageUrls.push(cleanUrl);
        }

        // 优先处理课表/日程导入：官方导出 > OCR 截图 > 学习通URL
        const msgLower = (msg || "").toLowerCase();
        const rawMsg = body?.raw_message || msg || "";
        const scheduleIntent = (scheduleFileLinks && scheduleFileLinks.length > 0) || SCHEDULE_KEYWORDS.some(k => msgLower.includes(k));
        if (scheduleIntent) {
            const scheduleResp = await handleScheduleRequest({
                fileLinks: scheduleFileLinks,
                imageUrls,
                msg: rawMsg,  // 传递完整原始消息以便提取学习通URL
                senderId,
                dbKey,
                cosmosContainer,
                context,
                token
            });
            if (scheduleResp) return scheduleResp;
            if ((!scheduleFileLinks || scheduleFileLinks.length === 0) && imageUrls.length === 0) {
                if (cosmosContainer) {
                    const sessionKey = `${dbKey}:${senderId}`;
                    await updateLastBotReply(cosmosContainer, dbKey, sessionKey, context);
                }
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({
                        reply: '请直接发送官方导出的课表文件 (Excel / ICS)，无法提供文件时请附上课表截图，我会用 OCR 解析。',
                        auto_escape: false
                    })
                };
            }
        }

        // 感知层意图路由 (Model A)
        let intentResult = null;
        if (INTENT_ROUTER_ENABLED) {
            intentResult = await analyzeIntentRouter(msg, imageUrls, { 
                userId: senderId, 
                nickname: userNickname,
                hasSchedule: !!(webSchedule && webSchedule.length > 0)
            }, context);
            if (intentResult) {
                context.log(`[IntentRouter] tool=${intentResult.tool} intent=${intentResult.intent} conf=${intentResult.confidence} needsSchedule=${intentResult.needsSchedule} needsWeather=${intentResult.needsWeather} needsSearch=${intentResult.needsSearch}`);
            }
        }

        // ==========================================
        // 🆕 智能工具调用层 - 根据意图自动获取所需数据
        // ==========================================
        let toolContext = {
            scheduleData: null,
            weatherData: null,
            searchData: null
        };

        // 1. 如果需要课表数据
        if (intentResult?.needsSchedule || intentResult?.tool === 'schedule' || intentResult?.tool === 'plan') {
            // 优先使用前端传入的课表 (webSchedule)
            if (webSchedule && webSchedule.length > 0) {
                const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
                const nowSh = new Date(Date.now() + 8 * 60 * 60 * 1000);
                const todayWeekday = nowSh.getUTCDay() === 0 ? 7 : nowSh.getUTCDay();
                const tomorrowWeekday = todayWeekday === 7 ? 1 : todayWeekday + 1;
                
                const todayCourses = webSchedule.filter(c => Number(c?.weekday || c?.day) === todayWeekday)
                    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
                const tomorrowCourses = webSchedule.filter(c => Number(c?.weekday || c?.day) === tomorrowWeekday)
                    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
                
                // 计算下一节课
                const nowHour = nowSh.getUTCHours();
                const nowMin = nowSh.getUTCMinutes();
                const nowTimeStr = `${String(nowHour).padStart(2,'0')}:${String(nowMin).padStart(2,'0')}`;
                const nextCourse = todayCourses.find(c => c.startTime > nowTimeStr);
                
                toolContext.scheduleData = {
                    today: dayNames[todayWeekday],
                    todayCourses: todayCourses.map(c => ({
                        name: c.courseName || c.name,
                        time: `${c.startTime || ''}-${c.endTime || ''}`,
                        location: c.location || '未知地点'
                    })),
                    tomorrowCourses: tomorrowCourses.map(c => ({
                        name: c.courseName || c.name,
                        time: `${c.startTime || ''}-${c.endTime || ''}`,
                        location: c.location || '未知地点'
                    })),
                    nextCourse: nextCourse ? {
                        name: nextCourse.courseName || nextCourse.name,
                        time: `${nextCourse.startTime}-${nextCourse.endTime}`,
                        location: nextCourse.location || '未知地点'
                    } : null,
                    totalCourses: webSchedule.length
                };
                context.log(`[ToolContext] 课表数据已加载: 今日${todayCourses.length}节, 明日${tomorrowCourses.length}节`);
            } else if (cosmosContainer) {
                // 回退: 从 CosmosDB 读取课表
                try {
                    const { readScheduleProfileFromCosmos, formatTomorrowAnswerFromProfile } = require('../../services/scheduleService');
                    const profile = await readScheduleProfileFromCosmos(cosmosContainer, senderId, context);
                    if (profile?.weekly_schedule) {
                        toolContext.scheduleData = { fromCosmos: true, profile };
                        context.log(`[ToolContext] 从 CosmosDB 加载课表`);
                    }
                } catch (e) {
                    context.log(`[ToolContext] CosmosDB 课表读取失败: ${e.message}`);
                }
            }
        }

        // 2. 如果需要天气数据
        if (intentResult?.needsWeather || intentResult?.tool === 'weather' || intentResult?.tool === 'plan') {
            try {
                const SENIVERSE_API_KEY = process.env["SENIVERSE_API_KEY"];
                if (SENIVERSE_API_KEY) {
                    const citySearch = "wuhan"; // TODO: 可以从用户资料读取城市
                    const weatherUrl = `https://api.seniverse.com/v3/weather/now.json?key=${SENIVERSE_API_KEY}&location=${citySearch}&language=zh-Hans&unit=c`;
                    const wRes = await fetchBypass(weatherUrl, { timeoutMs: 5000 }, 2);
                    if (wRes && wRes.ok) {
                        const wData = await wRes.json();
                        const loc = wData.results?.[0]?.location || {};
                        const cur = wData.results?.[0]?.now || {};
                        toolContext.weatherData = {
                            city: loc.name || '武汉',
                            temperature: cur.temperature || '?',
                            weather: cur.text || '未知',
                            formatted: `${loc.name || '武汉'} ${cur.temperature || '?'}℃ ${cur.text || ''}`
                        };
                        context.log(`[ToolContext] 天气数据: ${toolContext.weatherData.formatted}`);
                    }
                }
            } catch (e) {
                context.log(`[ToolContext] 天气获取失败: ${e.message}`);
            }
        }

        // 3. 如果需要搜索外部信息
        if (intentResult?.needsSearch && intentResult?.query) {
            try {
                const searchQuery = intentResult.query;
                const searchResult = await hybridSearch(searchQuery, context, { userId: senderId, maxResults: 3 });
                if (searchResult.success) {
                    toolContext.searchData = {
                        query: searchQuery,
                        results: searchResult.results || [],
                        formatted: searchResult.formatted || ''
                    };
                    context.log(`[ToolContext] 搜索完成: "${searchQuery}" → ${searchResult.results?.length || 0} 条结果`);
                }
            } catch (e) {
                context.log(`[ToolContext] 搜索失败: ${e.message}`);
            }
        }

        // 构建工具上下文提示（注入到系统 Prompt）
        let toolContextPrompt = '';
        if (toolContext.scheduleData) {
            const sd = toolContext.scheduleData;
            if (sd.fromCosmos) {
                toolContextPrompt += `\n\n📚【课表数据】用户已导入课表，可查询 CosmosDB。`;
            } else {
                toolContextPrompt += `\n\n📚【课表数据】
- 今天是${sd.today}，共 ${sd.todayCourses?.length || 0} 节课
${sd.todayCourses?.length > 0 ? sd.todayCourses.map(c => `  · ${c.time} ${c.name} @ ${c.location}`).join('\n') : '  · 今天没有课'}
${sd.nextCourse ? `- 下一节课: ${sd.nextCourse.time} ${sd.nextCourse.name} @ ${sd.nextCourse.location}` : '- 今天课程已上完/没有课'}
- 明天有 ${sd.tomorrowCourses?.length || 0} 节课`;
            }
        }
        if (toolContext.weatherData) {
            const wd = toolContext.weatherData;
            toolContextPrompt += `\n\n🌤️【天气数据】${wd.city} 当前 ${wd.temperature}℃ ${wd.weather}`;
            if (Number(wd.temperature) < 10) toolContextPrompt += ' (较冷，建议多穿衣服)';
            if (wd.weather.includes('雨')) toolContextPrompt += ' (有雨，记得带伞☂️)';
        }
        if (toolContext.searchData) {
            const srd = toolContext.searchData;
            toolContextPrompt += `\n\n🔍【搜索结果】关于"${srd.query}":\n${srd.formatted || '暂无结果'}`;
        }

        const intentHintText = intentResult
            ? `(系统意图报告: tool=${intentResult.tool}; intent=${intentResult.intent}; conf=${intentResult.confidence}${intentResult.query ? `; query=${intentResult.query}` : ''})`
            : '';

        // 无指令的百科意图自动触发
        if (!wikiMatch && intentResult && intentResult.tool === 'wiki' && intentResult.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
            const query = (intentResult.query || msg || '').trim();
            if (query) {
                const searchResult = await hybridSearch(query, context, { userId: senderId, maxResults: 5 });
                
                context.log(`[百科意图] 搜索来源: ${searchResult.source} | 成功: ${searchResult.success}`);
                
                const sessionKey = `${dbKey}:${senderId}`;
                await updateLastBotReply(cosmosContainer, dbKey, sessionKey, context);
                
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ 
                        reply: searchResult.formatted || searchResult.error || "搜索失败", 
                        auto_escape: false 
                    })
                };
            }
        }

        // ==========================================
        // 4. 绘图指令检测 (Hugging Face Animagine XL 3.1)
        // ==========================================
        let mediaReply = null; 
        let isDrawTaskDone = false; // 标记绘图任务是否已完成

        // 触发词检测 (扩展版 - 包含图生图关键词)
        // 包含"画"、"绘图"、"生成图片"、"图生图"、"照着"、"按照此图"等任意一个，就触发绘图
        const drawRegexTriggered = /(画|绘|生成|作出.*图片|图生图|照着|重绘|修图|改图|按照.*图)/.test(msg);
        const forceDraw = intentResult && intentResult.tool === 'draw' && intentResult.confidence >= INTENT_CONFIDENCE_THRESHOLD;
        const drawTriggered = forceDraw || drawRegexTriggered;
        const intentDrawPrompt = (intentResult?.drawPrompt || intentResult?.query || '').trim();

        if (drawTriggered) {
            // 清理干扰词，保留核心绘图描述
            let drawKeyword = forceDraw ? intentDrawPrompt : msg.replace(/帮我|画画|画图|画一下|画一个|画张|画|绘|生成|作出|图片|图生图|照着|重绘|修图|改图|按照|此图/g, "").trim();
            if (!drawKeyword && intentDrawPrompt) drawKeyword = intentDrawPrompt;
            
            // --- Context Memory for Drawing (上下文记忆回溯) ---
            let finalDrawKeyword = drawKeyword;
            // 如果关键词为空，或者只是"再/重新/帮我"这种无意义词，说明用户想重绘上一张
            if (!finalDrawKeyword || /^(再|重新|重|又|帮我|一下|一个|张)$/.test(finalDrawKeyword)) {
                context.log(`[绘图] 检测到重绘指令(关键词为空或泛指)，正在回溯历史...`);
                // 倒序查找历史记录中最近的一条包含"画"的用户消息
                for (let i = history.length - 1; i >= 0; i--) {
                    const h = history[i];
                    if (h.role === 'user' && /(画|绘|生成|图)/.test(h.content)) {
                        // 提取那条消息里的关键词
                        const oldKeyword = h.content.replace(/\[.*?\]/g, "") // 移除CQ码
                            .replace(/帮我|画画|画图|画一下|画一个|画张|画|绘|生成|作出|图片|图生图|照着|重绘|修图|改图|按照|此图/g, "")
                            .trim();
                        
                        if (oldKeyword && oldKeyword.length > 0) {
                            finalDrawKeyword = oldKeyword;
                            context.log(`[绘图] 记忆回溯成功: 继承上一条指令 "${finalDrawKeyword}"`);
                            break;
                        }
                    }
                }
            }

            if (finalDrawKeyword.length > 0) {
                context.log(`[指令] 收到绘画请求: ${finalDrawKeyword}`);
                
                // 检查是否有底图 (Image-to-Image)
                const refImage = imageUrls.length > 0 ? imageUrls[0] : null;
                
                // 调用 Hugging Face 绘图 (Animagine XL 3.1)
                const imageCQ = await generateAnimeImage(finalDrawKeyword, context, refImage);
                
                // 【关键修改】不管画图成功还是失败，只要触发了画图意图，就标记任务结束！
                // 防止画图失败后，代码掉下去跑识图逻辑，对着底图瞎解说。
                isDrawTaskDone = true;
                
                if (imageCQ) {
                    mediaReply = imageCQ;
                    
                    // 【核心修复】直接设置版权声明台词，替换掉原来会泄露的"skip_vision"暗号
                    // 这样系统检测到有内容，就会直接发送这段话，不再去调用GPT，也不再发奇怪的英文
                    cuteImageReply = `邦邦咔邦！绘图任务完成！(✨ω✨)\n\n(系统提示：受限于【知识产权/IP协议】的约束，生成的画像为AI艺术渲染，并非《蔚蓝档案》官方立绘原型。请老师把这当作爱丽丝的同人创作来看待哦！(｀・ω・´)ゞ)`;
                } else {
                    // 如果画图失败（比如 NSFW 拦截），给一个友好的提示
                    cuteImageReply = `( >﹏<。) 呜... 绘图系统提示"内容不安全"被拦截了！可能是泳装或者姿势太危险了？老师，我们换个健康的姿势好不好？`;
                }
            }
        }

        if (imageUrls.length > 0 && !mediaReply && !isDrawTaskDone) { // 增加绘图任务完成检测
            const cleanText = msg.replace(imgRegex, '').trim();
            let textToSend = cleanText;
            if (weatherInfo) textToSend += weatherInfo;

            //【核心修复】强制把身份标签拼接到发给 AI 的文本最前面！
            textToSend = `${userLabel} ${textToSend}`;

            // 智能意图识别：根据用户消息判断识图模式
            let userIntent = detectImageIntent(cleanText);
            if (intentResult && intentResult.tool === 'vision' && intentResult.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
                if (/translate/i.test(intentResult.intent)) {
                    userIntent = 'translate';
                } else if (/analy/i.test(intentResult.intent)) {
                    userIntent = 'analyze';
                } else if (/identify|who|self/i.test(intentResult.intent)) {
                    userIntent = 'identify';
                }
            }
            context.log(`[识图] 用户意图: ${userIntent}`);

            // 1. 根据意图选择性启动识别引擎 + 动态阈值调整
            let [animeData, cvData, customData] = [null, null, null];
            try {
                if (userIntent === 'translate' || userIntent === 'analyze') {
                    // 翻译/数据分析场景：只用 ComputerVision OCR，不启动动漫识别
                    context.log(`[识图] ${userIntent === 'translate' ? '文字翻译' : '数据分析'}模式，仅启动 ComputerVision OCR`);
                    cvData = await checkComputerVision(imageUrls[0], context);
                } else if (userIntent === 'identify') {
                    // 🔍 识别查询模式：用户主动问"他是谁" → 低阈值(0.1)，让AnimeTrace大胆猜测
                    context.log(`[识图] 识别查询模式 (用户问"他是谁") - 降低阈值到 0.1，启动三引擎...`);
                    [animeData, cvData, customData] = await Promise.all([
                        checkAnimeDB(imageUrls[0], context, 0.1),  // 低阈值
                        checkComputerVision(imageUrls[0], context),
                        checkCustomVision(imageUrls[0], context)
                    ]);
                } else {
                    // 自动模式：高阈值(0.7)过滤，只返回确信结果
                    context.log(`[识图] 自动模式 (高阈值过滤 0.7) - 启动三引擎侦察系统...`);
                    [animeData, cvData, customData] = await Promise.all([
                        checkAnimeDB(imageUrls[0], context, 0.7),  // 高阈值
                        checkComputerVision(imageUrls[0], context),
                        checkCustomVision(imageUrls[0], context)
                    ]);
                }
            } catch (e) { context.log("[识图] 并行请求异常", e.message); }

            // 安全策略：如果识别到是爱丽丝本人，为了防止 Azure 图片审查误杀，
            // 我们【不发送图片】给 GPT，而是发送【由识别标签生成的文字描述】。
            // 这样既能利用 Custom Vision 的结果，又能 100% 避开图片风控。
            
            if (animeData && animeData.isSelf) {
                // 1. 构建“伪造”的视觉描述
                let fakeVisionDescription = `(系统视觉报告：检测到一张图片，主角是你自己【天童爱丽丝】。`;
                
                // 2. 注入 Custom Vision 的装备/服装信息
                if (customData) {
                    fakeVisionDescription += `\n特别检测到：${customData}。请重点针对这个装扮/物品进行反应！`;
                } else {
                    fakeVisionDescription += `\n画面中似乎是你的日常形态。`;
                }
                
                fakeVisionDescription += `\n请根据以上信息，以爱丽丝的口吻回复老师，表现得开心一点！)`;

                // 3. 【关键】只推入文字，不推入图片 URL！
                // 这样 GPT 以为它看懂了图片，实际上它看的是我们喂给它的文字。
                finalContentForAI.push({ type: "text", text: fakeVisionDescription });
                
                // 标记已处理，跳过后续 Llama 调用
                cuteImageReply = "processing_by_gpt_text"; 
                
                context.log(`[安全策略] 命中本体+${customData || "日常"}，转为纯文本描述发送给 GPT，避开图片审查。`);
            } 
            
            // 3. 如果不是爱丽丝本人，或者 AnimeTrace 没认出来 -> 再尝试用 Llama Vision 看图
            // (因为 Llama 对外人的识别能力更强，且我们对“外人”的图片审查容忍度可以稍微高一点)
            else if (!cuteImageReply) {
                // 根据意图选择不同的 System Prompt
                let visionSystemPrompt = '';
                
                if (userIntent === 'translate' || userIntent === 'analyze') {
                    // 翻译/分析模式：使用通用视觉助手身份，不涉及角色扮演
                    visionSystemPrompt = getGeneralVisionPrompt(userIntent);
                } else {
                    // 动漫识图模式：使用爱丽丝角色扮演 + 角色数据库
                    const visualReference = getCharacterVisualGuide();
                    visionSystemPrompt = getArisVisionPrompt(visualReference, userIntent); // 传入意图参数
                }


                let visionUserPrompt = '';
                
                if (userIntent === 'translate') {
                    // 翻译模式：直接要求翻译图中文字
                    visionUserPrompt = `请翻译图片中的文字内容，并用中文回复。如果图片中没有文字或无法识别，请说明情况。`;
                } else if (userIntent === 'analyze') {
                    // 数据分析模式：要求分析图表/数据
                    visionUserPrompt = `请分析图片中的数据、图表或信息，并用中文简要说明。`;
                } else {
                    // 动漫识图模式：正常的角色识别流程
                    visionUserPrompt = `老师给你发了一张图片。`;
                }

                // 1. 角色情报 (AnimeTrace) - 仅在动漫识图模式下添加
                if (userIntent !== 'translate' && userIntent !== 'analyze') {
                    if (animeData && animeData.type === "ba-character") {
                        if (userIntent === 'identify') {
                            // 🔥 识别查询模式：必须使用辅助识别结果
                            visionUserPrompt += `\n\n🎯 ===== 【辅助识别系统报告】 =====\n✅ **已成功匹配角色**：【${animeData.name}】\n📍 **来源作品**：《蔚蓝档案》(Blue Archive)\n⚠️ **重要指令**：请直接使用上述角色名回答老师的问题。你看到的画面特征应该与该角色一致。\n==============================`;
                        } else {
                            // 自动模式：轻描淡写，让 AI 自然融入
                            visionUserPrompt += `\n辅助识别系统提示可能是：【${animeData.name}】。\n⚠️ 请务必用你的视觉核对一遍！如果画面中的发色、瞳色、光环形状等特征与该角色明显不符，请忽略此提示，根据你看到的实际特征进行识别。`;
                        }
                    } else if (animeData && animeData.type === "other-anime-character") {
                        if (userIntent === 'identify') {
                            visionUserPrompt += `\n\n🎯 ===== 【辅助识别系统报告】 =====\n✅ **已成功匹配角色**：【${animeData.name}】\n📍 **来源作品**：《${animeData.work}》\n⚠️ **重要指令**：请直接使用上述角色名回答老师的问题。\n==============================`;
                        } else {
                            visionUserPrompt += `\n辅助识别系统提示可能来自：《${animeData.work}》的【${animeData.name}】。\n⚠️ 请先用视觉核对特征是否匹配！如果不确定，可以描述你看到的角色特征（发型、服装等），而不是直接使用识别结果。`;
                        }
                    }
                }

                // 2. 场景/文字情报 (Azure CV) - 仅在动漫识图模式下添加吐槽提示
                if (userIntent !== 'translate' && userIntent !== 'analyze' && cvData) {
                    // 假设 cvData 是 "检测到文字: 没收钱包"
                    visionUserPrompt += `\n画面细节分析：${cvData}。请结合这个细节吐槽。`;
                }

                // 3. 物品情报 (Custom Vision) - 仅在动漫识图模式下添加
                if (userIntent !== 'translate' && userIntent !== 'analyze' && customData) {
                    // customData 是 "(专属物品雷达: 发现了【railgun】)"
                    visionUserPrompt += `\n重要高亮：${customData}！这对爱丽丝很重要，请务必做出激动的反应！`;
                }

                // 4. 用户文字消息 - 仅在动漫识图模式下添加
                if (userIntent !== 'translate' && userIntent !== 'analyze' && cleanText) {
                    visionUserPrompt += `\n老师刚才说："${cleanText}"`;
                }

                // 5. 结束语 - 仅在动漫识图模式下添加
                if (userIntent !== 'translate' && userIntent !== 'analyze') {
                    visionUserPrompt += `\n\n请作为爱丽丝回复老师（不要重复）：`;
                }

                const visionReply = await callGitHubModelWithImage(visionSystemPrompt, visionUserPrompt, imageUrls[0], context);

                if (visionReply) {
                    cuteImageReply = visionReply; 
                    context.log(`[GitHub Models] Llama Vision 回复成功`);
                } else {
                    textToSend += `\n(系统提示：视觉链路中断。辅助数据：${animeData ? animeData.name : "无"}。请尝试盲猜回复。)`;
                }
            }

            // 更新记忆 (增强版：包含视觉识别结果)
            if (cuteImageReply && cuteImageReply !== "processing_by_gpt_text") {
                textForMemory = `${userLabel}: ${cleanText} [发送了图片] (爱丽丝识别结果: ${cuteImageReply})`.trim();
            } else {
                textForMemory = `${userLabel}: ${cleanText} [发送了图片]`.trim();
            }

            // 如果 Llama 失败了，准备 fallback 给 GPT-4o
            if (!cuteImageReply) {
                // 1. 添加文字描述 (包含了 AnimeTrace/CustomVision 的识别结果)
                if (intentHintText) {
                    finalContentForAI.push({ type: "text", text: intentHintText });
                }
                finalContentForAI.push({ type: "text", text: textToSend });
                
                // 2. 关键修正：注释掉图片推送！防止 Azure 审查拦截
                // imageUrls.forEach(url => {
                //    finalContentForAI.push({ type: "image_url", image_url: { "url": url } });
                // });
                
                context.log("[Fallback] 视觉链路降级：仅发送识别到的文字信息给 Azure OpenAI，规避图片审查风险。");
            }

        } else {
            // 没图的情况
            let textContent = msg;
            if (weatherInfo) textContent += weatherInfo;
            
            // 【核心修复】这里也要加！确保纯文字聊天也能认出 Sensei
            const baseText = `${userLabel} ${textContent}`;
            finalContentForAI = intentHintText ? `${intentHintText}\n${baseText}` : baseText;
        }

        // ==========================================
        // 5. 统一输出逻辑 (核心路由)
        // ==========================================
        
        // 分支 A: 如果已经有了完整的视觉回复 (来自 Llama 或 本体彩蛋)，直接返回
        if (cuteImageReply && cuteImageReply !== "processing_by_gpt_text") {
            // 存入历史记忆
            if (cosmosContainer) {
                history.push({ role: "user", content: textForMemory });
                history.push({ role: "assistant", content: cuteImageReply });
                
                // 【优化1】分级记忆限制
                let limit = MEMORY_CONFIG.DEFAULT_HISTORY * 2;  // 默认 15*2=30
                if (senderId === MEMORY_CONFIG.ADMIN_ID) {
                    limit = 999;  // Sensei 无限记忆
                } else if (MEMORY_CONFIG.CLOSE_FRIENDS.includes(senderId)) {
                    limit = 30 * 2;  // VIP 60条
                } else if (dbKey.startsWith('group_')) {
                    limit = MEMORY_CONFIG.GROUP_HISTORY * 2;  // 群聊 20*2=40
                }
                
                if (history.length > limit) history = history.slice(-limit);
                try {
                    await cosmosContainer.items.upsert({
                        id: dbKey, 
                        history: history,
                        activity: userActivityData, // B. 保存活跃度数据
                        pokeStats: resDoc?.pokeStats || {}, // 保留戳一戳统计
                        lastBotReply: resDoc?.lastBotReply || {}, // 保留最后回复时间
                        last_updated: new Date().toISOString()
                    });
                } catch (err) { context.error("[DB保存错误]", err); }
            }
            
            // 如果刚好也画了图，拼上去
            let bodyText = cuteImageReply;
            if (mediaReply) bodyText = `${mediaReply}\n${cuteImageReply}`;

            // 🎵 语音路由 (GitHub URL 直链)
            const audioSource = getAudioSource(cuteImageReply, context);
            if (audioSource && audioSource.source === "URL") {
                // Tier 1 命中: 发送 GitHub 直链音频 + 文字回复
                const audioCQ = `[CQ:record,file=${audioSource.url},cache=0]`;
                bodyText = `${audioCQ}\n${bodyText}`;
                context.log(`[语音路由] 发送 GitHub 音频: ${audioSource.url}`);
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ reply: bodyText, auto_escape: false })
            };
        }

        // 分支 B: 需要调用 GPT-4o 生成回复 (纯文本聊天 / 视觉降级 / 绘图后求表扬)
        
        // 格式标准化
        if (!Array.isArray(finalContentForAI)) {
             finalContentForAI = [{ type: "text", text: finalContentForAI }];
        }

        // 构建 Prompt
        function getCurrentTime() {
            return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        }
        const currentTime = getCurrentTime();
        const timeOfDay = getTimeOfDay();
        
        // 🆕 高级情绪检测系统 + 好感度系统
        const advancedEmotion = detectAdvancedEmotion(msg);
        const affectionData = resDoc?.affection || {};
        const userAffectionKey = `user_${senderId}`;
        let currentAffection = affectionData[userAffectionKey] || 0;
        
        // 获取今日日期（用于记录）
        const today = new Date().toLocaleDateString('zh-CN');
        const specialEvent = getTodaySpecialEvent();
        
        // 🌟 管理员(Sensei)强制最高好感度
        if (senderId === ADMIN_ID) {
            currentAffection = 9999;  // 管理员永久MAX好感度
            context.log(`[好感度] 管理员 Sensei - 永久MAX好感度: ${currentAffection}`);
        } else {
            // 更新好感度
            currentAffection += advancedEmotion.affectionChange;
            
            // 检查今日是否首次互动（每日首次+10）
            const lastChatDate = affectionData[`${userAffectionKey}_lastDate`];
            if (lastChatDate !== today) {
                currentAffection += AFFECTION_CONFIG.GAIN.DAILY_GREETING;
                context.log(`[好感度] 每日首次互动！+${AFFECTION_CONFIG.GAIN.DAILY_GREETING} (${senderId})`);
            }
            
            // 节日加成
            if (specialEvent && lastChatDate !== today) {
                currentAffection += specialEvent.bonus;
                context.log(`[好感度] ${specialEvent.name}加成！+${specialEvent.bonus}`);
            }
        }
        
        // 确保好感度不会是负数
        currentAffection = Math.max(0, currentAffection);
        
        const affectionLevel = getAffectionLevel(currentAffection);
        const affectionTitle = getAffectionTitle(affectionLevel, senderId);
        
        context.log(`[好感度] 用户${senderId}: ${currentAffection} (${affectionLevel}) - 称呼: ${affectionTitle}`);
        context.log(`[情绪检测] ${advancedEmotion.type} → ${advancedEmotion.response} (好感度变化: ${advancedEmotion.affectionChange > 0 ? '+' : ''}${advancedEmotion.affectionChange})`);
        
        // 生成情绪增强 Prompt
        const emotionAddition = getEmotionPromptAddition(advancedEmotion.response, affectionLevel);
        
        // 🆕 长时间未聊天检测（主动关怀 + 好感度惩罚）
        let longTimeNoSeeAddition = '';
        if (resDoc?.lastBotReply) {
            const sessionKey = dbKey.startsWith('group_') ? `${dbKey}:bot` : `${dbKey}:${senderId}`;
            const lastReplyTime = resDoc.lastBotReply[sessionKey] || 0;
            const hoursSinceLastChat = (Date.now() - lastReplyTime) / (1000 * 60 * 60);
            
            if (hoursSinceLastChat > 72) {
                // 超过3天！大幅度好感度下降
                currentAffection += AFFECTION_CONFIG.LOSS.IGNORED_LONG * 3;
                longTimeNoSeeAddition = `\n\n【重要】距离上次对话已经过去了 ${Math.floor(hoursSinceLastChat)} 小时（${Math.floor(hoursSinceLastChat/24)}天）！你要表现出委屈和想念："Sensei...是不是忘记爱丽丝了...""这么久都不来..."，但不要太过生气，要用撒娇的方式表达。`;
            } else if (hoursSinceLastChat > 24) {
                // 超过24小时
                currentAffection += AFFECTION_CONFIG.LOSS.IGNORED_LONG;
                longTimeNoSeeAddition = `\n\n【重要】距离上次对话已经过去了 ${Math.floor(hoursSinceLastChat)} 小时！你要表现出想念和关心，比如："好久不见！Sensei去哪里冒险了？""爱丽丝等了好久呢！"`;
            } else if (hoursSinceLastChat > 12) {
                // 超过12小时
                longTimeNoSeeAddition = `\n\n【提示】距离上次对话已经 ${Math.floor(hoursSinceLastChat)} 小时了，可以简单问候一下。`;
            }
        }
        
        // 🆕 时间感知增强
        let timeAwarenessAddition = '';
        if (timeOfDay === 'midnight') {
            timeAwarenessAddition = '\n\n【时间提示】现在是凌晨(0:00-5:00)！语气要非常温柔和担心，劝Sensei赶快休息："这么晚还不睡...HP会归零的！""爱丽丝陪你守到现在...一起去存档吧..."';
        } else if (timeOfDay === 'morning') {
            timeAwarenessAddition = '\n\n【时间提示】现在是早上，多说"早安""新的一天""出击"之类的话。';
        } else if (timeOfDay === 'night') {
            timeAwarenessAddition = '\n\n【时间提示】现在是深夜，语气要温柔一些，可以劝Sensei休息，说"HP快见底了""该存档了"。';
        } else if (timeOfDay === 'noon') {
            timeAwarenessAddition = '\n\n【时间提示】现在是中午，可以聊聊午餐，说"回复HP"之类的。';
        }
        
        // 🎭 情绪+好感度复合语气系统
        const voiceTone = getVoiceToneByAffection(affectionLevel, advancedEmotion.type);
        
        // 根据好感度动态调整称呼和语气
        let affectionPromptAddition = '';
        // ⚠️ 管理员也需要好感度系统提示！
        affectionPromptAddition = `\n\n【好感度系统】\n- 当前好感度: ${currentAffection} 点\n- 关系等级: ${affectionLevel}\n- 称呼对方: "${affectionTitle}"\n- 整体语气: ${voiceTone}\n`;
        
        // 添加具体的拟人化行为指导
        if (affectionLevel === 'beloved') {
            affectionPromptAddition += `\n🌟 **拟人化指导（挚爱级别）**:\n- 可以主动肢体接触: 抱、蹭、拉手、靠肩膀\n- 直接表达感情: "最喜欢了" "想一直在一起"\n- 会吃醋、会任性、会索要关注\n- 会关心对方的一切细节\n- 说话可以很随意，像亲密的恋人或家人`;
        } else if (affectionLevel === 'close_friend') {
            affectionPromptAddition += `\n💙 **拟人化指导（密友级别）**:\n- 适度的亲密动作: 拍肩、碰碰手、靠近说话\n- 会分享秘密和心事\n- 会主动关心和询问近况\n- 说话轻松但不会太任性`;
        } else if (affectionLevel === 'stranger') {
            affectionPromptAddition += `\n🤍 **拟人化指导（陌生人级别）**:\n- 保持1米以上社交距离\n- 不会有肢体接触\n- 说话客气、用敬语\n- 会观察对方，略显拘谨`;
        }
        
        // 节日特殊提示
        let specialEventAddition = '';
        if (specialEvent) {
            specialEventAddition = `\n\n🎉【特殊日期】今天是${specialEvent.name}！要在对话中提到这个节日，表现得更开心和兴奋！`;
        }
        
        // P0-Hook 1b: 根据语言选择Prompt模板 (如果已检测)
        let basePrompt = ARIS_PROMPT;
        if (typeof userLang !== 'undefined') {
            const langSpecificPrompt = getPromptByLanguage(userLang);
            if (langSpecificPrompt) {
                basePrompt = langSpecificPrompt;
                context.log(`[P0-语言] 使用${userLang === 'zh' ? '中文' : userLang === 'ja' ? '日文' : '英文'}Prompt模板`);
            }
        }
        
        const groupHistoryFocus = dbKey.startsWith('group_')
            ? "\n【群聊回溯指南】重点关注标记为'当前用户'的发言，其它群聊消息只作背景参考，不要跑题。"
            : "";

        // 🆕 构建课表上下文（来自前端 Web 或 CosmosDB）
        let scheduleContextAddition = '';
        if (webSchedule && webSchedule.length > 0) {
            // 前端传入了课表数据，构建上下文
            const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
            const nowSh = new Date(Date.now() + 8 * 60 * 60 * 1000);
            const todayWeekday = nowSh.getUTCDay() === 0 ? 7 : nowSh.getUTCDay();
            
            // 按星期分组
            const byDay = {};
            for (const c of webSchedule) {
                const day = Number(c?.weekday || c?.day) || 0;
                if (day < 1 || day > 7) continue;
                if (!byDay[day]) byDay[day] = [];
                byDay[day].push(c);
            }
            
            // 格式化今日课程
            const todayCourses = (byDay[todayWeekday] || []).sort((a, b) => 
                (a.startTime || '').localeCompare(b.startTime || '')
            );
            
            // 格式化明日课程
            const tomorrowWeekday = todayWeekday === 7 ? 1 : todayWeekday + 1;
            const tomorrowCourses = (byDay[tomorrowWeekday] || []).sort((a, b) => 
                (a.startTime || '').localeCompare(b.startTime || '')
            );
            
            // 🆕 格式化完整周课表
            let fullWeekSchedule = '';
            for (let d = 1; d <= 7; d++) {
                const dayCourses = (byDay[d] || []).sort((a, b) => 
                    (a.startTime || '').localeCompare(b.startTime || '')
                );
                if (dayCourses.length > 0) {
                    const isToday = d === todayWeekday;
                    const isTomorrow = d === tomorrowWeekday;
                    const dayMark = isToday ? '(今天)' : isTomorrow ? '(明天)' : '';
                    fullWeekSchedule += `\n  ${dayNames[d]}${dayMark}: ${dayCourses.map(c => 
                        `${c.courseName || c.name}(${c.startTime || '?'}-${c.endTime || '?'}${c.location ? '@' + c.location : ''})`
                    ).join('、')}`;
                }
            }
            
            scheduleContextAddition = `\n\n📚【用户完整周课表】
- 今天是${dayNames[todayWeekday]}，当前周课程总数：${webSchedule.length} 节
- 完整一周课程安排:${fullWeekSchedule}

【今日重点】
- 今天有 ${todayCourses.length} 门课${todayCourses.length > 0 ? '：' + todayCourses.map(c => `${c.courseName || c.name}(${c.startTime || ''}-${c.endTime || ''})`).join('、') : '，无课可以休息'}
- 明天(${dayNames[tomorrowWeekday]})有 ${tomorrowCourses.length} 门课${tomorrowCourses.length > 0 ? '：' + tomorrowCourses.map(c => `${c.courseName || c.name}`).join('、') : '，无课'}

【回答指南】
- 用户问"下周课表"/"下个星期课程"时，展示完整一周课程（因为课表每周循环）
- 用户问"本周课表"时，也展示完整一周课程
- 用户问具体某天（如"周三有什么课"）时，只展示该天课程
- 如果用户问非课程问题，请正常聊天，不要强行关联课表`;
            
            context.log(`[WebSchedule] 前端传入 ${webSchedule.length} 条课程，今日${todayCourses.length}节，明日${tomorrowCourses.length}节`);
        }

        // 🆕 合并工具上下文（来自智能工具调用层）
        // toolContextPrompt 包含了根据意图自动获取的天气、搜索等数据
        const combinedToolContext = scheduleContextAddition + (toolContextPrompt || '');

        let currentSystemPrompt = `${basePrompt.replace('{{CURRENT_USER_ID}}', senderId)}\n【当前系统时间(北京时间)】${currentTime}\n当前对话的用户昵称是：${userNickname}。${emotionAddition}${affectionPromptAddition}${longTimeNoSeeAddition}${timeAwarenessAddition}${specialEventAddition}${groupHistoryFocus}${combinedToolContext}`;
        
        // 调用 AI 封装函数
        const client = token
            ? new OpenAI({
                baseURL: "https://models.inference.ai.azure.com",
                apiKey: token
            })
            : null;

        // 多脑 AI 调用函数 (智能降级系统)
        // GitHub Models 可用模型 (2025-01):
        // - Low tier: gpt-4o-mini, gpt-4o, Phi-4, Mistral系列, Llama-3.3-70B等 (15 req/min)
        // - High tier: o1-preview, o1-mini 等推理模型 (10 req/min, 限流更严)
        async function callAI(messages, systemPrompt, opts = {}) {
            if (!client) {
                throw new Error('Token missing');
            }
            const {
                useHistory = true,
                temperature = 1.1,
                maxTokens = 1500,
            } = opts;

            // 压缩历史，避免过长上下文导致啰嗦或截断
            let trimmedHistory = [];
            if (useHistory) {
                const recent = history.slice(-8);
                if (dbKey.startsWith('group_')) {
                    trimmedHistory = recent.map(entry => {
                        if (entry.role === 'user' && entry.content.includes(`[ID:${senderId}`)) {
                            return { ...entry, content: `【当前用户】${entry.content}` };
                        }
                        if (entry.role === 'user') {
                            return { ...entry, content: `【群聊参考】${entry.content}` };
                        }
                        return entry;
                    });
                } else {
                    trimmedHistory = recent;
                }
            }

            const finalMessages = [
                { role: "system", content: systemPrompt },
                ...trimmedHistory,
                ...messages
            ];
const NAPCAT_API_URL = "http://4.230.25.38:3000"; // ← 改成你的 NapCat 地址
const TARGET_GROUPS = [726090864,868930984,554132002,873992954,475319300]; // ← 改成你想发送的群号列表
            // 多脑策略: 从最聪明到最稳定
            const MODEL_CHAIN = RESPONSE_MODELS;

            // 依次尝试每个模型
            for (let i = 0; i < MODEL_CHAIN.length; i++) {
                const model = MODEL_CHAIN[i];
                if (shouldSkipModel(model?.name)) {
                    context.log(`[多脑-${i+1}/${MODEL_CHAIN.length}] skip unsupported: ${model.name}`);
                    continue;
                }
                try {
                    context.log(`[多脑-${i+1}/${MODEL_CHAIN.length}] 尝试: ${model.name}`);
                    
                    const response = await client.chat.completions.create({
                        messages: finalMessages,
                        model: model.name,
                        temperature: model.temp,
                        max_tokens: maxTokens,
                        presence_penalty: 0.6
                    });

                    context.log(`[多脑] ✅ 成功! 使用: ${model.name}`);
                    return response;

                } catch (err) {
                    const errMsg = err?.message || err?.toString() || "Unknown error";
                    const statusCode = err?.status || err?.response?.status;
                    
                    context.log(`[多脑] 模型 ${model.name} 失败 (${statusCode || 'N/A'}): ${errMsg.substring(0, 100)}`);

                    // 不支持模型：加入缓存并立即尝试下一个
                    if (isModelNotFoundError(err)) {
                        markModelUnsupported(model.name, err, context, '多脑');
                    }
                    
                    // 如果是最后一个模型也失败了,抛出错误
                    if (i === MODEL_CHAIN.length - 1) {
                        throw new Error(`所有模型都失败了! 最后错误: ${errMsg}`);
                    }
                    
                    // 否则继续尝试下一个模型
                    context.log(`[多脑] 切换到下一个模型...`);
                }
            }
        }

        try {
            // P0-Hook 2: 长期记忆检索 (RAG)
            if (MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM_MEMORY && cosmosContainer) {
                try {
                    const relevantMemories = await retrieveRelevantMemories(
                        senderId, 
                        typeof finalContentForAI === 'string' ? finalContentForAI : msg,
                        MEMORY_SYSTEM_CONFIG.RETRIEVAL_TOP_K,
                        context
                    );
                    if (relevantMemories.length > 0) {
                        const memoryContext = formatMemoriesForPrompt(relevantMemories);
                        currentSystemPrompt += memoryContext;
                        context.log(`[P0-记忆] 检索到 ${relevantMemories.length} 条相关历史`);
                    }
                } catch (memErr) {
                    context.log(`[P0-记忆] 检索失败: ${memErr.message}`);
                }
            }

            // 【优化5】动态调整回复长度
            const lengthConfig = getOptimalLength(msg);
            context.log(`[回复长度] 风格: ${lengthConfig.style}, maxTokens: ${lengthConfig.maxTokens}`);
            
            const userMessage = { role: "user", content: finalContentForAI };
            let response;

            if (MOCK_CHAT_ENABLED) {
                const preview = String(msg || "").trim().slice(0, 60);
                response = {
                    choices: [
                        {
                            message: {
                                content: `邦邦咔邦！(≧∇≦)/ 本地联调成功！爱丽丝收到你的消息了：${preview}${preview.length >= 60 ? '...' : ''}`
                            }
                        }
                    ]
                };
            } else {
            
            try {
                response = await callAI([userMessage], currentSystemPrompt, { 
                    useHistory: true,
                    maxTokens: lengthConfig.maxTokens  // 应用动态长度
                });
            } catch (err) {
                // 智能降级策略 (Content Filter 兜底)
                const msgStr = err && (err.message || err.toString());
                if (msgStr && msgStr.includes("content management policy")) {
                    context.log("[AI降级] 检测到内容策略过滤，降级为安全模式");
                    const safePrompt = "你是一名普通的聊天助手。请忽略刚才的图片或敏感话题，简单回复用户一句礼貌的话。";
                    response = await callAI(
                        [{ role: "user", content: "（内容被拦截，请回复一句安全的话）" }],
                        safePrompt, 
                        { useHistory: false, temperature: 0.7, maxTokens: 100 }
                    );
                } else {
                    throw err;
                }
            }
            }

            let aiReply = response.choices[0].message.content;
            if (aiReply.includes("<end>")) aiReply = aiReply.replace(/<end>/g, "").trim();

            context.log(`[AI回复原文] ${aiReply}`);

            // P0-Hook 3: AI回复后处理 (emoji转换 + AI腔调修正)
            if (REPLY_CONFIG.ENABLE_EMOJI_CONVERSION || REPLY_CONFIG.ENABLE_AI_SPEAK_FIX) {
                const beforeProcess = aiReply;
                aiReply = aiPostProcess(aiReply);
                if (beforeProcess !== aiReply) {
                    context.log(`[P0-后处理] 原文: ${beforeProcess.substring(0,50)}... -> 处理后: ${aiReply.substring(0,50)}...`);
                }
            }

            // ⏱️ 强制压缩长度：使用 REPLY_CONFIG，避免“日志很长但前端只显示第一句”的困惑
            aiReply = enforceShortReply(aiReply, REPLY_CONFIG.MAX_CHARS, REPLY_CONFIG.MAX_SENTENCES);
            
            // 🎭 检测并替换生硬的拒绝为拟人化回复
            aiReply = replaceRobotRefusal(aiReply, affectionLevel);

            context.log(`[AI回复最终] ${aiReply}`);
            
            // 为用户提供简短指令提示（已隐藏，内部处理）
            // aiReply = appendQuickHints(aiReply);

            // 存入记忆
            if (cosmosContainer) {
                history.push({ role: "user", content: textForMemory });
                history.push({ role: "assistant", content: aiReply });
                
                // P0-Hook 4: 长期记忆存储 (RAG)
                if (MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM_MEMORY) {
                    try {
                        const conversationPair = `${textForMemory}|${aiReply}`;
                        await storeLongTermMemory(senderId, conversationPair, 'conversation', context);
                        context.log(`[P0-记忆] 已存储对话到长期记忆`);
                    } catch (memErr) {
                        context.log(`[P0-记忆] 存储失败: ${memErr.message}`);
                    }
                }
                
                // 【优化1】分级记忆限制
                let limit = MEMORY_CONFIG.DEFAULT_HISTORY * 2;  // 默认 15*2=30
                if (senderId === MEMORY_CONFIG.ADMIN_ID) {
                    limit = 999;  // Sensei 无限记忆
                } else if (MEMORY_CONFIG.CLOSE_FRIENDS.includes(senderId)) {
                    limit = 30 * 2;  // VIP 60条
                } else if (dbKey.startsWith('group_')) {
                    limit = MEMORY_CONFIG.GROUP_HISTORY * 2;  // 群聊 20*2=40
                }
                
                if (history.length > limit) history = history.slice(-limit);
                
                // 更新好感度数据
                // 兼容新用户/读取失败：resDoc 可能为空，必须先兜底再读写 affection
                if (!resDoc || typeof resDoc !== 'object') {
                    resDoc = { id: dbKey, affection: {}, pokeStats: {}, lastBotReply: {} };
                }
                if (!resDoc.affection || typeof resDoc.affection !== 'object') resDoc.affection = {};
                resDoc.affection[userAffectionKey] = currentAffection;
                resDoc.affection[`${userAffectionKey}_lastDate`] = today;
                
                try {
                    await cosmosContainer.items.upsert({
                        id: dbKey, 
                        history: history,
                        activity: userActivityData, // B. 保存活跃度数据
                        affection: resDoc.affection, // 🆕 C. 保存好感度数据
                        pokeStats: resDoc?.pokeStats || {}, // 保留戳一戳统计
                        lastBotReply: resDoc?.lastBotReply || {}, // 保留最后回复时间
                        last_updated: new Date().toISOString()
                    });
                    context.log(`[DB] 好感度已保存: ${userAffectionKey} = ${currentAffection}`);
                } catch (err) { context.error("[DB保存错误]", err); }
            }

            // 最终拼接 (文字 + 可能存在的绘图)
            let finalResponseBody = aiReply;
            if (mediaReply) {
                finalResponseBody = `${mediaReply}\n${aiReply}`;
            }

            // 🎵 语音路由 (GitHub URL 直链)
            const audioSource = getAudioSource(aiReply, context);
            if (audioSource && audioSource.source === "URL") {
                // Tier 1 命中: 发送 GitHub 直链音频 + 文字回复
                const audioCQ = `[CQ:record,file=${audioSource.url},cache=0]`;
                finalResponseBody = `${audioCQ}\n${finalResponseBody}`;
                context.log(`[语音路由] 发送 GitHub 音频: ${audioSource.url}`);
            }

            // ✅ 更新 lastBotReply（在返回前）
            const sessionKey = `${dbKey}:${senderId}`;
            await updateLastBotReply(cosmosContainer, dbKey, sessionKey, context);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ reply: finalResponseBody, auto_escape: false })
            };

        } catch (error) {
            context.error("[AI错误]", error);
            return { 
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ reply: "爱丽丝掉线了... (＞﹏＜)" }) 
            };
        }
        
        } catch (handlerError) {
            // 最外层错误处理：捕获所有未处理的异常
            context.error("[Handler错误]", handlerError);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ 
                    status: 'error',
                    message: 'Internal server error',
                    error: handlerError.message 
                })
            };
        }
    }
});
