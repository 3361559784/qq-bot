const { app } = require('@azure/functions');
const { OpenAI } = require("openai");
const { CosmosClient } = require("@azure/cosmos");

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
async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
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
            }, 7000);

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

// 戳一戳升级版配置
const POKE_WINDOW_MS = 10000; // 10秒内连续戳计数窗口
const POKE_ANGRY_THRESHOLD = 3; // 连续戳3次触发生气
const POKE_COUNTER_THRESHOLD = 5; // 连续戳5次触发反击
const JUST_REPLIED_MS = 15000; // 15秒内算"刚回复过"

// NapCat API 配置
const NAPCAT_API_URL = 'http://4.230.25.38:3000';
const NAPCAT_TOKEN = process.env["NAPCAT_TOKEN"] || '';

// 防刷屏配置
const GROUP_COOLDOWN_MS = 8000; // 群内8秒冷却期

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

function toPinyinCityName(rawChinese) {
    if (!rawChinese) return "";
    // 去掉“市/省/区/县/的”等尾缀噪音
    let name = rawChinese.replace(/(市|省|区|县)$/g, "");
    name = name.replace(/^的/, "");

    if (CITY_MAP[name]) {
        // 已在大表里：直接用映射
        return CITY_MAP[name];
    }
    if (CITY_PINYIN_FALLBACK[name]) {
        return CITY_PINYIN_FALLBACK[name];
    }
    // 兜底：直接返回去后缀的中文，交给 Open‑Meteo 的模糊匹配
    return name;
}

function getWeatherDesc(code) {
    if (code === 0) return "☀️ 晴天";
    if (code >= 1 && code <= 3) return "☁️ 多云/阴天";
    if (code >= 45 && code <= 48) return "🌫️ 有雾";
    if (code >= 51 && code <= 55) return "🌧️ 毛毛雨";
    if (code >= 61 && code <= 65) return "🌧️ 下雨";
    if (code >= 66 && code <= 67) return "❄️ 雨夹雪";
    if (code >= 71 && code <= 77) return "🌨️ 下雪";
    if (code >= 80 && code <= 82) return "🌧️ 阵雨";
    if (code >= 95 && code <= 99) return "⛈️ 雷雨";
    return "未知天气";
}

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

/**
 * @param {string} text - 用户的输入文本或AI回复文本
 * @param {object} context - Azure Function 的 context 对象
 * @returns {string | null} 返回 GitHub 音频 URL 或 null
 */
function checkKeywordAudio(text, context) {
    if (!text) return null;
    const cleanText = text.toLowerCase();
    
    // 遍历映射表，查找匹配的关键词
    for (const [keyword, fileName] of Object.entries(AUDIO_MAP)) {
        if (cleanText.includes(keyword.toLowerCase())) {
            // 生成 GitHub 直链
            const fileUrl = `${GITHUB_AUDIO_BASE}${fileName}`;
            context.log(`[Tier 1] 命中关键词 "${keyword}", 文件: ${fileName}`);
            return fileUrl;
        }
    }
    return null; // 如果没有匹配到标志性语音
}

// ==========================================
// 5. 核心语音源路由器 (根据回复内容决定 Tiers)
// ==========================================
/**
 * @param {string} text - GPT-4o 或 Llama-3 最终生成的文字回复
 * @param {object} context - Azure Function 的 context 对象
 * @returns {{source: 'URL'|'LOCAL_TTS'|'CLOUD_TTS', url?: string, model?: string} | null}
 */
function getAudioSource(text, context, language = "auto") {
    // C. 多语言检测
    let detectedLang = language;
    if (language === "auto") {
        // 简单语言检测逻辑
        if (/[\u4e00-\u9fa5]/.test(text)) {
            detectedLang = "zh"; // 中文
        } else if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
            detectedLang = "ja"; // 日文
        } else if (/^[a-zA-Z\s.,!?]+$/.test(text)) {
            detectedLang = "en"; // 英文
        } else {
            detectedLang = "ja"; // 默认日文（爱丽丝的原声）
        }
    }
    
    context.log(`[语音路由] 检测语言: ${detectedLang}`);
    
    // 1. Tier 1 Check: 游戏原声/标志性语音 (最高优先级,保证品质)
    // 注意：原声库目前只有日文，如果检测为中文/英文，跳过 Tier 1
    if (detectedLang === "ja") {
        const signatureAudioUrl = checkKeywordAudio(text, context);
        if (signatureAudioUrl) {
            // 返回 URL 模式,让 NapCat 直接去 GitHub 下载播放
            return { source: "URL", url: signatureAudioUrl, lang: "ja" };
        }
    }
    
    // 2. Tier 2: 多语言 TTS (未来扩展)
    // TODO: 当有中文/英文 TTS 模型时，这里可以根据 detectedLang 调用对应的引擎
    // 例如: if (detectedLang === "zh") return synthesizeChineseTTS(text, context);
    
    // 3. Fallback: 没有匹配到原声,则不发送语音
    return null;
}

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
// 2. 核心识图引擎: AnimeTrace (Debug版)
// ==========================================
async function checkAnimeDB(imgUrl, context, minConfidence = 0.7) {
    if (!imgUrl) return null;
    
    context.log(`[AnimeTrace] 模式配置 - 最小置信度阈值: ${minConfidence}`);

    // 修正：QQ图片URL可能不带后缀，改为黑名单模式（只拦截明确的动图）
    const lowerUrl = imgUrl.toLowerCase();
    // 如果明确包含 .gif，则视为动图拦截
    if (lowerUrl.includes(".gif")) {
        context.log(`[AnimeTrace] 检测到 GIF 动图，跳过识别: ${imgUrl}`);
        return `(系统事件：收到的似乎是 GIF 动图，请你扮演天童爱丽丝，直接向老师说明“爱丽丝看不清这张动态图片，只能当成神秘的未知情报”，不要编造角色名字。)`;
    }
    try {
        const api = "https://api.animetrace.com/v1/search";
        context.log(`[AnimeTrace] 请求: ${api}`);

        const payload = {
            url: imgUrl,
            model: "animetrace_high_beta",
            is_multi: 0,
            ai_detect: 0
        };

        const res = await fetchWithTimeout(api, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            body: JSON.stringify(payload)
        }, 12000);

        if (!res || !res.ok) {
            const errText = res ? await res.text() : "timeout";
            context.log(`[AnimeTrace] HTTP错误: ${res ? res.status : 0} - ${errText}`);
            return null;
        }

        let data;
        try {
            data = await res.json();
        } catch (jsonErr) {
            context.log(`[AnimeTrace] JSON解析失败: ${jsonErr.message}`);
            return null;
        }

        context.log(`[AnimeTrace] 原始响应(前300字): ${JSON.stringify(data).slice(0, 300)}`);

        const statusCode = Number(data?.code ?? data?.status ?? 0);
        if (statusCode && ![0, 200, 17720].includes(statusCode)) {
            context.log(`[AnimeTrace] 业务异常 Code:${statusCode} Msg:${data?.msg || data?.zh_message || data?.message || "unknown"}`);
            return null;
        }

        let candidates = [];
        if (Array.isArray(data)) candidates = data;
        else if (Array.isArray(data?.data)) candidates = data.data;
        else if (Array.isArray(data?.result)) candidates = data.result;
        else if (Array.isArray(data?.results)) candidates = data.results;
        else if (Array.isArray(data?.data?.result)) candidates = data.data.result;
        else if (Array.isArray(data?.data?.results)) candidates = data.data.results;

        if (candidates.length) {
            const best = candidates[0];

            // AnimeTrace 返回的 character 通常是一个数组: [{ work, character }, ...]
            let charName = "";
            let animeName = "";
            
            // 【核心修复】支持新版 AnimeTrace 的 not_confident 布尔标记
            let prob = best?.probability || best?.score || best?.confidence;
            if (prob === undefined || prob === null) {
                // 新版 AnimeTrace 用 not_confident 布尔值代替数字置信度
                if (best?.not_confident === false) {
                    prob = 0.95; // 非常确信
                    context.log(`[AnimeTrace] 使用 not_confident=false，设置置信度: 0.95`);
                } else if (best?.not_confident === true) {
                    prob = 0.10; // 不确定
                    context.log(`[AnimeTrace] 使用 not_confident=true，设置置信度: 0.10`);
                } else {
                    prob = 0; // 完全没数据
                    context.log(`[AnimeTrace] ⚠️ 未找到任何置信度指标`);
                }
            } else {
                prob = Number(prob);
            }

            // 动态阈值门槛（根据用户意图调整）
            context.log(`[AnimeTrace] 识别结果: ${best?.char || best?.character || "未知"}, 原始置信度: ${prob}, 阈值: ${minConfidence}`);
            if (prob < minConfidence) {
                context.log(`[AnimeTrace] ❌ 置信度 ${prob.toFixed(2)} < 阈值 ${minConfidence}，忽略此结果`);
                return null;
            }
            context.log(`[AnimeTrace] ✅ 通过阈值检查！`);

            const charArray = Array.isArray(best?.character) ? best.character : null;
            if (charArray && charArray.length > 0) {
                // 优先选《蔚蓝档案》候选
                const blueArchiveCandidate = charArray.find(c => {
                    const work = (c.work || "").toString();
                    return work.includes("ブルーアーカイブ") || work.toLowerCase().includes("blue archive") || work.includes("蔚蓝档案");
                });

                const picked = blueArchiveCandidate || charArray[0];
                charName = picked?.character || "";
                animeName = picked?.work || "";
            } else {
                // 兼容旧结构（character 直接是字符串等）
                charName = best?.char || best?.character || best?.character_name || best?.name || "";
                animeName = best?.work || best?.cartoonname || best?.anime || best?.title || "";
            }

            context.log(`[AnimeTrace] 解析结果: 名=${charName || "(空)"}, 剧=${animeName || "(空)"}, 分=${prob}`);

            if (charName) {
                // 蓝档角色日文/英文 -> 中文正式名映射（可按需继续补充）
                const blueArchiveNameMap = {
                    // 关键核心角色 / 沙勒
                    "アロナ": "阿洛娜",
                    "A.R.O.N.A": "阿洛娜",
                    "プラナ": "普拉娜",
                    "天童アリス": "天童爱丽丝",
                    "アリス": "天童爱丽丝",
                    "先生": "老师",
                    "せんせい": "老师",

                    // 联邦理事会相关
                    "七神リン": "七神凛",
                    "七神なながみ リン": "七神凛",
                    "由良木モモカ": "由良木桃可",
                    "由良木ゆらぎ モモカ": "由良木桃可",
                    "岩櫃アユム": "岩柜步",
                    "岩櫃いわびつ アユム": "岩柜步",
                    "扇喜アオイ": "扇喜葵",

                    // 阿拜多斯 对策委员会
                    "小鳥遊ホシノ": "小鸟游星野",
                    "小鳥遊たかなし ホシノ": "小鸟游星野",
                    "ホシノ": "星野",
                    "砂狼シロコ": "砂狼白子",
                    "砂狼すなおおかみ シロコ": "砂狼白子",
                    "黒見セリカ": "黑见芹香",
                    "黒見くろみ セリカ": "黑见芹香",
                    "十六夜ノノミ": "十六夜野宫",
                    "十六夜いざよい ノノミ": "十六夜野宫",
                    "奥空アヤネ": "奥空绫音",
                    "奥空おくそら アヤネ": "奥空绫音",
                    "梔子ユメ": "栀子梦",
                    "梔子くちなし ユメ": "栀子梦",
                    "シロコ＊テラー": "白子＊TERROR",

                    // 千禧年 研讨会 / C&C / 超自然 / 游戏开发部
                    "調月リオ": "调月莉音",
                    "調月つかつき リオ": "调月莉音",
                    "早瀬ユウカ": "早濑优香",
                    "早瀬はやせ ユウカ": "早濑优香",
                    "ユウカ": "优香",
                    "生塩ノア": "生盐诺亚",
                    "生塩うしお ノア": "生盐诺亚",
                    "黒崎コユキ": "黑崎小雪",
                    "黒崎くろさき コユキ": "黑崎小雪",

                    "美甘ネル": "美甘妮露",
                    "美甘みかも ネル": "美甘妮露",
                    "一之瀬アスナ": "一之濑明日奈",
                    "一之瀬いちのせ アスナ": "一之濑明日奈",
                    "Asuna Ichinose": "一之濑明日奈",
                    "アスナ": "一之濑明日奈",
                    "角楯カリン": "角楯花凛",
                    "角楯かくだて カリン": "角楯花凛",
                    "室笠アカネ": "室笠茜",
                    "室笠むろさか アカネ": "室笠茜",
                    "飛鳥馬トキ": "飞鸟马时",
                    "飛鳥馬あすま トキ": "飞鸟马时",

                    "明星ヒマリ": "明星日鞠",
                    "明星あけぼし ヒマリ": "明星日鞠",
                    "和泉元エイミ": "和泉元艾米",

                    "花岡ユズ": "花冈柚子",
                    "花岡はなおか ユズ": "花冈柚子",
                    "才羽モモイ": "才羽桃",
                    "才羽さいば モモイ": "才羽桃",
                    "才羽ミドリ": "才羽绿",
                    "才羽さいば ミドリ": "才羽绿",
                    "Kei": "Kei",

                    // 真理社（简单映射几个）
                    "各務チヒロ": "各务千寻",
                    "音瀬コタマ": "音濑小玉",
                    "小鈎ハレ": "小钩晴",
                    "小塗マキ": "小涂真纪",

                    // 工程部
                    "白石ウタハ": "白石歌原",
                    "白石しらいし ウタハ": "白石歌原",
                    "豊見コトリ": "丰见琴里",
                    "猫塚ヒビキ": "猫冢响",

                    // 歌赫娜 风纪 / 万魔殿 / 便利屋68 / 供餐部 / 美食研究会
                    "羽沼マコト": "羽沼真琴",
                    "棗イロハ": "枣伊吕波",
                    "丹花イブキ": "丹花伊吹",

                    "空崎ヒナ": "空崎日奈",
                    "空崎そらさき ヒナ": "空崎日奈",
                    "ヒナ": "日奈",
                    "銀鏡イオリ": "银镜伊织",
                    "火宮チナツ": "火宫千夏",
                    "天雨アコ": "天雨亚子",

                    "陸八魔アル": "陆八魔爱露",
                    "陸八魔りくはちま アル": "陆八魔爱露",
                    "アル": "陆八魔爱露",
                    "浅黄ムツキ": "浅黄睦月",
                    "浅黄あさぎ ムツキ": "浅黄睦月",
                    "ムツキ": "浅黄睦月",
                    "鬼方カヨコ": "鬼方佳代子",
                    "伊草ハルカ": "伊草春香",

                    "黒舘ハルナ": "黑馆晴奈",
                    "黒舘くろだて ハルナ": "黑馆晴奈",
                    "赤司ジュンコ": "赤司纯子",
                    "獅子堂イズミ": "狮子堂泉",
                    "鰐渕アカリ": "鳄渊明里",

                    "愛清フウカ": "爱清风香",
                    "愛清あいきよ フウカ": "爱清风香",
                    "牛牧ジュリ": "牛牧朱莉",

                    // 崔尼蒂 茶话会 / 正义实现部 / 补习部 / 姐妹会 / 救护骑士团
                    "桐藤ナギサ": "桐藤渚",
                    "桐藤きりふじ ナギサ": "桐藤渚",
                    "聖園ミカ": "圣园未花",
                    "聖園みその ミカ": "圣园未花",
                    "百合園セイア": "百合园圣娅",

                    "剣先ツルギ": "剑先鹤城",
                    "剣先けんざき ツルギ": "剑先鹤城",
                    "羽川ハスミ": "羽川莲见",
                    "羽川はねかわ ハスミ": "羽川莲见",
                    "静山マシロ": "静山真白",
                    "仲正イチカ": "仲正一花",

                    "阿慈谷ヒフミ": "阿慈谷日富美",
                    "阿慈谷あじたに ヒフミ": "阿慈谷日富美",
                    "ヒフミ": "日富美",
                    "白洲アズサ": "白洲梓",
                    "白洲しらす アズサ": "白洲梓",
                    "Shirasu Azusa": "白洲梓",
                    "浦和ハナコ": "浦和花子",
                    "下江コハル": "下江小春",

                    "歌住サクラコ": "歌住樱子",
                    "歌住うたずみ サクラコ": "歌住樱子",
                    "伊落マリー": "伊落玛丽",
                    "若葉ヒナタ": "若叶日向",

                    "蒼森ミネ": "苍森美祢",
                    "朝顔ハナエ": "朝颜花江",
                    "鷲見セリナ": "鹫见芹娜",

                    // 百鬼夜行 选几个代表
                    "天地ニヤ": "天地仁耶",
                    "和楽チセ": "和乐千世",
                    "河和シズコ": "河和静子",
                    "朝比奈フィーナ": "朝比奈菲娜",
                    "春日ツバキ": "春日椿",
                    "水羽ミモリ": "水羽三森",
                    "勇美カエデ": "勇美枫",
                    "久田イズナ": "久田泉奈",

                    // 红冬 / 227 / 知识解放战线
                    "連河チェリノ": "连河切里诺",
                    "連河れんかわ チェリノ": "连河切里诺",
                    "佐城トモエ": "佐城巴",
                    "池倉マリナ": "池仓真理奈",

                    "天見ノドカ": "天见和香",
                    "天見あまみ ノドカ": "天见和香",
                    "間宵シグレ": "间宵时雨",

                    "姫木メル": "姬木芽瑠",
                    "秋泉モミジ": "秋泉红叶",
                    "安守ミノリ": "安守实梨",

                    // 瓦尔基丽 / 海兰德 / 山海经 / 狂猎艺术（挑几个）
                    "尾刃カンナ": "尾刃康娜",
                    "中務キリノ": "中务桐乃",
                    "合歓垣フブキ": "合欢垣吹雪",

                    "橘ヒカリ": "橘光",
                    "橘ノゾミ": "橘希望",

                    "竜華キサキ": "龙华妃咲",
                    "近衛ミナ": "近卫南",
                    "春原シュン": "春原瞬",
                    "春原ココナ": "春原心奈",
                    "薬子サヤ": "药子沙绫",
                    "朱城ルミ": "朱成瑠海",

                    // 便利：英文直接映射中文常用译名（只列你常遇到的）
                    "Aris Tendou": "天童爱丽丝",
                    "Hoshino": "星野",
                    "Yuuka": "优香"
                };

                const isBlueArchiveWork = (animeName || "").includes("ブルーアーカイブ")
                    || (animeName || "").toLowerCase().includes("blue archive")
                    || (animeName || "").includes("蔚蓝档案");

                const mappedName = blueArchiveNameMap[charName] || charName;

                // 特判：爱丽丝自己
                const isArisSelf = mappedName === "天童爱丽丝";

                return {
                    type: isBlueArchiveWork ? "ba-character" : "other-anime-character",
                    name: mappedName,
                    work: animeName || "未知作品",
                    isSelf: isArisSelf
                };
            }
        }

        context.log(`[AnimeTrace] 无有效候选数据`);
    } catch (e) {
        context.log(`[AnimeTrace] 请求异常: ${e.message}`);
    }
}
// ==========================================
// 3. 核心识图引擎 C: Custom Vision (修正版 - 适配实际标签)
// ==========================================
async function checkCustomVision(imgUrl, context) {
    // 👇👇👇 请在这里填入您之前获取的正确信息 👇👇👇
    const predictionUrl = "https://arisvision-prediction.cognitiveservices.azure.com/customvision/v3.0/Prediction/15d48369-f604-460c-afa5-53beb0ebf705/classify/iterations/Iteration1/url";
    const predictionKey = "6m6IwLKj33IXOTpE9b7RNXMluMhxCWW1LiRhJrBHDKXkzehKqpTxJQQJ99BKACi0881XJ3w3AAAIACOG5ymL"; 

    if (!predictionKey || !predictionUrl) return null;

    try {
        context.log(`[CustomVision] 请求 Prediction API...`);

        const res = await fetchWithTimeout(predictionUrl, {
            method: "POST",
            headers: {
                "Prediction-Key": predictionKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ "Url": imgUrl })
        }, 6000);

        if (!res.ok) {
            context.log(`[CustomVision] 失败: ${res.status} ${await res.text()}`);
            return null;
        }

        const data = await res.json();
        // 【核心修复】提高阈值到0.75 (75%)，只有非常确信时才通过
        const valid = data.predictions.filter(p => p.probability > 0.75);
        
        if (valid.length > 0) {
            let visualCue = "";
            const tags = valid.map(p => p.tagName);
            
            context.log(`[CustomVision] 命中标签: ${tags.join(", ")}`);

            // 1. aris_maid (女仆装)
            if (tags.includes("aris_maid")) {
                visualCue += "【检测到：女仆装爱丽丝】(请表现得像个能干的女仆，喊老师‘主人’然后改口说‘啊不对是老师’)\n";
            }
            // 2. aris_key (Key/黑爱丽丝)
            if (tags.includes("aris_key")) {
                visualCue += "【⚠️严重警告：检测到 Key/黑爱丽丝人格】(请立即切换为冷酷、理智、无情的AI语气，称呼老师为‘你’或‘碧蓝档案的玩家’，不再自称爱丽丝)\n";
            }
            // 3. railgun (光之剑)
            if (tags.includes("railgun")) {
                visualCue += "【检测到：光之剑/电磁炮】(这是你的专属武器‘超新星’！请兴奋地喊出必杀技名字)\n";
            }
            // 4. Alice Winter Clothes (冬装) - 模糊匹配 Winter
            if (tags.some(t => t.includes("Winter") || t.includes("冬"))) { 
                visualCue += "【检测到：冬装/厚大衣】(虽然是机器人不怕冷，但这身衣服看起来很暖和！请邀请老师一起去雪原冒险)\n";
            }
            // 5. hole (光环)
            if (tags.includes("hole")) {
                visualCue += "【检测到：头顶的光环】(这是基沃托斯学生的证明，也是爱丽丝的各种几何图形光环)\n";
            }
            // 6. aris (本体)
            if (tags.includes("aris")) {
                visualCue += "【检测到：爱丽丝本体】(确认画面中就是你自己)\n";
            }

            if (!visualCue) visualCue = `【检测到专属物品：${tags.join(", ")}】`;
            return visualCue;
        }
    } catch (e) { 
        context.log(`[CustomVision] 错误: ${e.message}`); 
    }
    return null;
}

// ==========================================
// Azure Computer Vision (Image Analysis 4.0) 识别模块
// ==========================================
async function checkComputerVision(imgUrl, context) {
    const endpoint = process.env["COMPUTER_VISION_ENDPOINT"];
    const key = process.env["COMPUTER_VISION_KEY"];

    if (!endpoint || !key) return null;

    try {
        // 构造 Image Analysis 4.0 URL
        // features: Caption,Tags,Objects,Read (OCR)
        const analysisUrl = `${endpoint.replace(/\/+$/, "")}/computervision/imageanalysis:analyze?api-version=2023-10-01&features=Caption,Tags,Objects,Read&language=zh`;
        
        context.log(`[ComputerVision] 请求: ${analysisUrl}`);
        
        const res = await fetchWithTimeout(analysisUrl, {
            method: "POST",
            headers: {
                "Ocp-Apim-Subscription-Key": key,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ url: imgUrl })
        }, 8000);

        if (!res.ok) {
            context.log(`[ComputerVision] 失败: ${res.status}`);
            return null;
        }

        const data = await res.json();
        
        // 提取关键信息
        let resultText = "";
        
        // 1. Caption (描述)
        if (data.captionResult && data.captionResult.text) {
            resultText += `画面描述: ${data.captionResult.text}; `;
        }
        
        // 2. Tags (标签)
        if (data.tagsResult && data.tagsResult.values) {
            const tags = data.tagsResult.values
                .filter(t => t.confidence > 0.6)
                .map(t => t.name)
                .slice(0, 10)
                .join(", ");
            if (tags) resultText += `标签: ${tags}; `;
        }
        
        // 3. Objects (物体检测)
        if (data.objectsResult && data.objectsResult.values) {
            const objects = data.objectsResult.values
                .map(o => o.tags.map(t => t.name).join("/"))
                .join(", ");
            if (objects) resultText += `检测到物体: ${objects}; `;
        }
        
        // 4. Read (OCR 文字)
        if (data.readResult && data.readResult.content) {
            // 限制长度防止 token 爆炸
            const ocrText = data.readResult.content.replace(/\n/g, " ").slice(0, 200);
            if (ocrText) resultText += `图中文字: "${ocrText}"; `;
        }

        context.log(`[ComputerVision] 分析结果: ${resultText}`);
        return resultText || null;

    } catch (e) {
        context.log(`[ComputerVision] 异常: ${e.message}`);
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
- **隐私保护**：拒绝他人指令时，不要透露 Sensei 的 ID，要说 "爱丽丝现在正忙着重要的任务..."。

## 动作描写 (Action Descriptions)
在回复中加入括号 \`(...)\` 来描写动作，增加临场感。
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
        behaviorRule = "【当前任务：角色识别】用户正在询问图中是谁。请根据【视觉特征数据库】和辅助情报，大胆推测角色名字。";
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
  - ✅ 正确示范："哇！老师！(✨ω✨) 爱丽丝发现了新地图的NPC！这个白头发的女孩子...看起来像是切里诺会长呢！(｀・ω・´)ゞ 我们要去接新的任务了吗？"

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
                context.log(`[DB] ETag 冲突，重试 ${attempt + 1}/${maxRetries}`);
                await sleep(50 + Math.random() * 100); // 随机延迟 50-150ms
                continue;
            }
            context.error(`[DB] lastBotReply 更新失败: ${err.message}`);
            return;
        }
    }
}

// ==========================================
// 戳一戳逻辑处理函数 (独立提取，支持真/伪 poke)
// ==========================================
async function handlePokeLogic(userId, groupId, context, cosmosContainer) {
    // 确定数据库 key（群聊优先，否则私聊）
    const pokeDbKey = groupId ? `group_${groupId}` : String(userId);
    
    // 从 DB 读取现有数据
    let resDoc = null;
    let pokeStats = {};
    let lastBotReply = {};
    try {
        if (cosmosContainer) {
            try {
                const { resource } = await cosmosContainer.item(pokeDbKey, pokeDbKey).read();
                resDoc = resource;
            } catch (e) {
                resDoc = null;
            }
            if (resDoc) {
                pokeStats = resDoc.pokeStats || {};
                lastBotReply = resDoc.lastBotReply || {};
            }
        }
    } catch (err) { context.log(`[Poke] DB读取失败: ${err}`); }

    // 统计 key：会话+用户
    const pokeKey = `${pokeDbKey}:${String(userId)}`;
    const now = Date.now();

    pokeStats[pokeKey] = pokeStats[pokeKey] || { count: 0, lastTime: 0 };

    // 统计连续戳：窗口内则累加，否则重置
    if (now - (pokeStats[pokeKey].lastTime || 0) < POKE_WINDOW_MS) {
        pokeStats[pokeKey].count += 1;
    } else {
        pokeStats[pokeKey].count = 1;
    }
    pokeStats[pokeKey].lastTime = now;

    // 选择回复:优先处理五连戳(反击) > 三连戳(生气) > 普通回应
    let replyMessage = null;
    let shouldCounterPoke = false;
    
    if (pokeStats[pokeKey].count >= POKE_COUNTER_THRESHOLD) {
        // 五连戳:触发反击
        replyMessage = "受够了！看我反击！(╬▔皿▔)╯";
        shouldCounterPoke = true;
        // 重置计数,防止重复反击
        pokeStats[pokeKey].count = 0;
    } else if (pokeStats[pokeKey].count >= POKE_ANGRY_THRESHOLD) {
        // 生气回复
        replyMessage = "不许再戳了！(▼へ▼メ)";
        // 不重置计数,让用户可以继续触发反击
    } else {
        // 检查是否刚刚回复过
        const lastBotTs = lastBotReply[pokeKey] || 0;
        if (now - lastBotTs < JUST_REPLIED_MS) {
            replyMessage = "刚才不是说过了吗？(歪头)";
        } else {
            // 否则随机温柔回应 (游戏化风格)
            const pokeReplies = [
                "(光环闪烁) 系统启动中... 邦邦咔邦！同步完成！Sensei 有新任务吗？(✨ω✨)",
                "检测到物理接触... 嘿嘿，Sensei 是在检查爱丽丝的装备吗？(乖巧站好)",
                "哔哔！收到触摸指令！爱丽丝的光环闪了一下呢！( •̀ ω •́ )✨",
                "(歪头) Sensei 戳了一下开关？爱丽丝没有那种功能啦！(＞﹏＜)",
                "警告！警告！检测到 Sensei 的手指攻击！护盾...护盾加载失败！(害羞)",
                "呜... HP 和 MP 都在正常范围内... Sensei 是要检查爱丽丝的状态吗？(拍拍光环)",
                "Sensei？爱丽丝随时待命！需要出击的话请下达指令！(敬礼) (｀・ω・´)ゞ",
                "(拖把竖起) 检测到 Sensei 的呼唤！勇者爱丽丝，准备完毕！",
                "邦邦咔邦~ (转圈) 爱丽丝在这里！Sensei 是在确认队友位置吗？"
            ];
            replyMessage = pokeReplies[Math.floor(Math.random() * pokeReplies.length)];
        }
    }

    // 记录本次机器人回复时间
    lastBotReply[pokeKey] = now;

    // 保存回 DB (带 ETag 并发控制)
    if (cosmosContainer) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const existing = resDoc || { id: pokeDbKey, history: [], activity: {} };
                existing.pokeStats = pokeStats;
                existing.lastBotReply = lastBotReply;
                existing.last_updated = new Date().toISOString();
                
                // 使用 ETag 进行条件更新
                const options = resDoc?._etag ? { accessCondition: { type: 'IfMatch', condition: resDoc._etag } } : {};
                await cosmosContainer.items.upsert(existing, options);
                context.log(`[Poke] DB 保存成功 (attempt=${attempt + 1})`);
                break; // 成功，退出循环
                
            } catch (err) {
                if (err.code === 412 && attempt < 1) {
                    // ETag 冲突，重新读取后重试
                    context.log(`[Poke] ETag 冲突，重试中...`);
                    try {
                        const { resource } = await cosmosContainer.item(pokeDbKey, pokeDbKey).read();
                        resDoc = resource;
                        pokeStats = resDoc.pokeStats || {};
                        lastBotReply = resDoc.lastBotReply || {};
                        // 重新应用更新
                        pokeStats[pokeKey] = pokeStats[pokeKey] || { count: 0, lastTime: 0 };
                        if (now - (pokeStats[pokeKey].lastTime || 0) < POKE_WINDOW_MS) {
                            pokeStats[pokeKey].count += 1;
                        } else {
                            pokeStats[pokeKey].count = 1;
                        }
                        pokeStats[pokeKey].lastTime = now;
                        lastBotReply[pokeKey] = now;
                        await sleep(50 + Math.random() * 50);
                    } catch (retryErr) {
                        context.error(`[Poke] 重试失败: ${retryErr}`);
                        break;
                    }
                } else {
                    context.error(`[Poke] 保存到 DB 失败: ${err}`);
                    break;
                }
            }
        }
    }

    // 执行反击(如果需要)
    if (shouldCounterPoke && groupId) {
        try {
            const napcatUrl = `${NAPCAT_API_URL}/group_poke`;
            const pokePayload = {
                group_id: groupId,
                user_id: userId
            };
            context.log(`[戳一戳反击] 正在戳回用户 ${userId} 在群 ${groupId}`);
            
            const pokeResponse = await fetch(napcatUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${NAPCAT_TOKEN}`
                },
                body: JSON.stringify(pokePayload)
            });
            
            if (pokeResponse.ok) {
                const respText = await pokeResponse.text();
                context.log(`[戳一戳反击] 成功! 状态码: ${pokeResponse.status}, 响应: ${respText}`);
            } else {
                context.warn(`[戳一戳反击] 失败, 状态码: ${pokeResponse.status}, 响应: ${await pokeResponse.text()}`);
            }
        } catch (err) {
            context.error(`[戳一戳反击] 异常: ${err}`);
        }
    }

    context.log(`[戳一戳] 触发 (key=${pokeKey}, count=${pokeStats[pokeKey].count}, 反击=${shouldCounterPoke}) -> ${replyMessage}`);

    return {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ 
            reply: replyMessage,
            auto_escape: false
        })
    };
}

app.http('schoolBot', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        
        let msg = request.query.get('msg'); 
        let senderId = "unknown";
        let userNickname = "Sensei"; 
        let dbKey = "unknown";

        // 1. 解析消息 (强化版：防注入 + 强力清洗)
        try {
            const bodyText = await request.text();
            if (bodyText) {
                const body = JSON.parse(bodyText);
                
                // 过滤非消息事件 (如心跳、通知等)
                // if (body.post_type && body.post_type !== 'message') return { status: 200 }; // OLD

                const selfId = body.self_id; // 机器人的 QQ 号

                // === 事件路由 (戳一戳 / 进群) ===
                if (body.post_type === 'notice') {
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
                                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                                body: JSON.stringify({ 
                                    reply: welcomeMsg,
                                    auto_escape: false
                                })
                            };
                        }
                    }

                    // 其他通知忽略
                    return { status: 200 };
                }

                // 非消息且非通知，忽略
                if (body.post_type !== 'message') return { status: 200 };

                const rawMsg = body.raw_message || "";
                
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
                    
                    if (!shouldRespond) return { status: 200 };
                    
                    // 【清洗步骤 1】移除 @本体 的 CQ 码
                    let tempMsg = rawMsg.replace(atCode, "");
                    
                    // 【清洗步骤 2】移除 引用消息(Reply) 的 CQ 码 (防止爱丽丝读到引用的一大堆乱码)
                    tempMsg = tempMsg.replace(/\[CQ:reply,id=\d+.*?\]/g, "");

                    // 【清洗步骤 3】移除其它残留的 @ 符号 (解决图片里对着 "@" 发呆的问题)
                    tempMsg = tempMsg.replace(/@/g, "");

                    // 【清洗步骤 4】移除其它 CQ 码 (保留图片码用于后续处理)
                    msg = tempMsg.replace(/\[CQ:(?!image).*?\]/g, "").trim();
                    
                    // 【伪戳一戳】检测：如果 @了机器人，但消息为空或只有标点，视为“戳一戳”
                    if (isAtMe && (!msg || /^[\s\.,，。！？!?]*$/.test(msg))) {
                        context.log(`[伪戳一戳] 检测到空@消息，触发戳一戳逻辑`);
                        return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
                    }
                    
                    if (!msg) return { status: 200 };
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
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                        body: JSON.stringify({ 
                            reply: "爱丽丝歪了歪头：\"老师？那看起来像是奇怪的Bug指令呢！爱丽丝听不懂哦！(◎_◎;)\"" 
                        }) 
                    };
                }

            }
        } catch (error) {
            context.log(`[解析错误] ${error.message}`);
        }

        // 如果 msg 依然为空 (解析失败或被过滤)，结束运行
        if (!msg) return { status: 200 };
        if (!token) return { body: JSON.stringify({ reply: "Error: Token missing" }) };
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

        // ==========================================
        // 4. 绘图指令检测 (Hugging Face Animagine XL 3.1)
        // ==========================================
        let mediaReply = null; 
        let isDrawTaskDone = false; // 标记绘图任务是否已完成

        // 触发词检测 (扩展版 - 包含图生图关键词)
        // 包含"画"、"绘图"、"生成图片"、"图生图"、"照着"、"按照此图"等任意一个，就触发绘图
        if (/(画|绘|生成|作出.*图片|图生图|照着|重绘|修图|改图|按照.*图)/.test(msg)) {
            // 清理干扰词，保留核心绘图描述
            const drawKeyword = msg.replace(/帮我|画画|画图|画一下|画一个|画张|画|绘|生成|作出|图片|图生图|照着|重绘|修图|改图|按照|此图/g, "").trim();
            
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
            const userIntent = detectImageIntent(cleanText);
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
                        visionUserPrompt += `\n辅助识别系统提示可能是：【${animeData.name}】。\n⚠️ 请务必用你的视觉核对一遍！如果画面中的发色、瞳色、光环形状等特征与该角色明显不符，请忽略此提示，根据你看到的实际特征进行识别。`;
                    } else if (animeData && animeData.type === "other-anime-character") {
                        visionUserPrompt += `\n辅助识别系统提示可能来自：《${animeData.work}》的【${animeData.name}】。\n⚠️ 请先用视觉核对特征是否匹配！如果不确定，可以描述你看到的角色特征（发型、服装等），而不是直接使用识别结果。`;
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
            finalContentForAI = `${userLabel} ${textContent}`;
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
        let currentSystemPrompt = `${ARIS_PROMPT.replace('{{CURRENT_USER_ID}}', senderId)}\n【当前系统时间(北京时间)】${currentTime}\n当前对话的用户昵称是：${userNickname}。`;
        
        // 调用 AI 封装函数
        const client = new OpenAI({
            baseURL: "https://models.inference.ai.azure.com",
            apiKey: token
        });

        // 多脑 AI 调用函数 (智能降级系统)
        // GitHub Models 可用模型 (2025-01):
        // - Low tier: gpt-4o-mini, gpt-4o, Phi-4, Mistral系列, Llama-3.3-70B等 (15 req/min)
        // - High tier: o1-preview, o1-mini 等推理模型 (10 req/min, 限流更严)
        async function callAI(messages, systemPrompt, opts = {}) {
            const {
                useHistory = true,
                temperature = 1.1,
                maxTokens = 1500,
            } = opts;

            const finalMessages = [
                { role: "system", content: systemPrompt },
                ...(useHistory ? history : []),
                ...messages
            ];
const NAPCAT_API_URL = "http://4.230.25.38:3000"; // ← 改成你的 NapCat 地址
const TARGET_GROUPS = [726090864,868930984,554132002,873992954,475319300]; // ← 改成你想发送的群号列表
            // 多脑策略: 从最聪明到最稳定
            const MODEL_CHAIN = [
                { 
                    name: "Llama-3.3-70B-Instruct", 
                    temp: 0.8, 
                    desc: "70B 巨模 (超强角色扮演,无审查)",
                    tier: "high"
                },
                { 
                    name: "gpt-4o", 
                    temp: 1.0, 
                    desc: "GPT-4o (聪明且活泼)",
                    tier: "low"
                },
                { 
                    name: "gpt-4o-mini", 
                    temp: 1.1, 
                    desc: "GPT-4o-mini (速度快,额度高)",
                    tier: "low"
                },
                { 
                    name: "Phi-4", 
                    temp: 0.9, 
                    desc: "Phi-4 (微软小钢炮)",
                    tier: "low"
                },
            ];

            // 依次尝试每个模型
            for (let i = 0; i < MODEL_CHAIN.length; i++) {
                const model = MODEL_CHAIN[i];
                try {
                    context.log(`[多脑-${i+1}/${MODEL_CHAIN.length}] 尝试: ${model.name} (${model.desc})`);
                    
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
            // 【优化5】动态调整回复长度
            const lengthConfig = getOptimalLength(msg);
            context.log(`[回复长度] 风格: ${lengthConfig.style}, maxTokens: ${lengthConfig.maxTokens}`);
            
            const userMessage = { role: "user", content: finalContentForAI };
            let response;
            
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

            let aiReply = response.choices[0].message.content;
            if (aiReply.includes("<end>")) aiReply = aiReply.replace(/<end>/g, "").trim();

            context.log(`[AI回复] ${aiReply}`);

            // 存入记忆
            if (cosmosContainer) {
                history.push({ role: "user", content: textForMemory });
                history.push({ role: "assistant", content: aiReply });
                
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
    }
});
