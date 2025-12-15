// ==========================================
// 识图服务模块 (Vision Service)
// 包含 AnimeTrace, Custom Vision, Computer Vision
// ==========================================

// 辅助函数：延时
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// fetchWithTimeout (需要从主文件传入或在这里重新定义)
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

// ==========================================
// 核心识图引擎: AnimeTrace
// ==========================================
async function checkAnimeDB(imgUrl, context, minConfidence = 0.7) {
    if (!imgUrl) return null;
    
    context.log(`[AnimeTrace] 模式配置 - 最小置信度阈值: ${minConfidence}`);

    const lowerUrl = imgUrl.toLowerCase();
    if (lowerUrl.includes(".gif")) {
        context.log(`[AnimeTrace] 检测到 GIF 动图，跳过识别: ${imgUrl}`);
        return `(系统事件：收到的似乎是 GIF 动图，请你扮演天童爱丽丝，直接向老师说明"爱丽丝看不清这张动态图片，只能当成神秘的未知情报"，不要编造角色名字。)`;
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
        else if (data?.trace) candidates = [data.trace];
        else candidates = [];

        context.log(`[AnimeTrace] 候选人数: ${candidates.length}`);

        for (const item of candidates) {
            const similarity = Number(item?.similarity ?? item?.score ?? item?.probability ?? 0);
            const animeName = item?.anime_name_cn || item?.anime || item?.title || "未知作品";
            const charName = item?.char_name_cn || item?.character || item?.name || "未知角色";
            
            context.log(`[AnimeTrace] 候选: ${animeName} / ${charName} - 置信度:${similarity.toFixed(4)}`);

            if (similarity >= minConfidence) {
                const isArisSelf = charName.includes("爱丽丝") || charName.includes("Aris") || charName.includes("アリス") || animeName.includes("Blue Archive") || animeName.includes("蔚蓝档案") || animeName.includes("ブルーアーカイブ");
                
                context.log(`[AnimeTrace] ✅ 命中 - ${animeName}/${charName} (${(similarity * 100).toFixed(2)}%)`);
                
                return {
                    character: charName,
                    work: animeName || "未知作品",
                    isSelf: isArisSelf
                };
            }
        }

        context.log(`[AnimeTrace] 无有效候选数据`);
    } catch (e) {
        context.log(`[AnimeTrace] 请求异常: ${e.message}`);
    }
    return null;
}

// ==========================================
// 核心识图引擎: Custom Vision
// ==========================================
async function checkCustomVision(imgUrl, context) {
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
        const valid = data.predictions.filter(p => p.probability > 0.75);
        
        if (valid.length > 0) {
            let visualCue = "";
            const tags = valid.map(p => p.tagName);
            
            context.log(`[CustomVision] 命中标签: ${tags.join(", ")}`);

            if (tags.includes("aris_maid")) {
                visualCue += "【检测到：女仆装爱丽丝】(请表现得像个能干的女仆，喊老师'主人'然后改口说'啊不对是老师')\n";
            }
            if (tags.includes("aris_key")) {
                visualCue += "【⚠️严重警告：检测到 Key/黑爱丽丝人格】(请立即切换为冷酷、理智、无情的AI语气，称呼老师为'你'或'碧蓝档案的玩家'，不再自称爱丽丝)\n";
            }
            if (tags.includes("railgun")) {
                visualCue += "【检测到：光之剑/电磁炮】(这是你的专属武器'超新星'！请兴奋地喊出必杀技名字)\n";
            }
            if (tags.some(t => t.includes("Winter") || t.includes("冬"))) { 
                visualCue += "【检测到：冬装/厚大衣】(虽然是机器人不怕冷，但这身衣服看起来很暖和！请邀请老师一起去雪原冒险)\n";
            }
            if (tags.includes("hole")) {
                visualCue += "【检测到：头顶的光环】(这是基沃托斯学生的证明，也是爱丽丝的各种几何图形光环)\n";
            }
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
// Azure Computer Vision (Image Analysis 4.0)
// ==========================================
async function checkComputerVision(imgUrl, context) {
    const endpoint = process.env["COMPUTER_VISION_ENDPOINT"];
    const key = process.env["COMPUTER_VISION_KEY"];

    if (!endpoint || !key) return null;

    try {
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
        
        let resultText = "";
        
        if (data.captionResult && data.captionResult.text) {
            resultText += `画面描述: ${data.captionResult.text}; `;
        }
        
        if (data.tagsResult && data.tagsResult.values) {
            const tags = data.tagsResult.values
                .filter(t => t.confidence > 0.6)
                .map(t => t.name)
                .slice(0, 10)
                .join(", ");
            if (tags) resultText += `标签: ${tags}; `;
        }
        
        if (data.objectsResult && data.objectsResult.values) {
            const objects = data.objectsResult.values
                .map(o => o.tags.map(t => t.name).join("/"))
                .join(", ");
            if (objects) resultText += `检测到物体: ${objects}; `;
        }
        
        if (data.readResult && data.readResult.content) {
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
// Azure Computer Vision - Read full text
// 支持 input 为 URL(string) 或 Buffer/Uint8Array
// ==========================================
async function readTextFromComputerVision(input, context) {
    const endpoint = process.env["COMPUTER_VISION_ENDPOINT"];
    const key = process.env["COMPUTER_VISION_KEY"];

    if (!endpoint || !key) return null;

    try {
        const analysisUrl = `${endpoint.replace(/\/+$/, "")}/computervision/imageanalysis:analyze?api-version=2023-10-01&features=Read&language=zh`;
        context?.log?.(`[ComputerVision][Read] 请求: ${analysisUrl}`);

        let headers = {
            "Ocp-Apim-Subscription-Key": key
        };

        let body;
        if (typeof input === 'string') {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify({ url: input });
        } else if (input && (Buffer.isBuffer(input) || input instanceof Uint8Array)) {
            headers["Content-Type"] = "application/octet-stream";
            body = Buffer.isBuffer(input) ? input : Buffer.from(input);
        } else {
            return null;
        }

        const res = await fetchWithTimeout(analysisUrl, {
            method: "POST",
            headers,
            body
        }, 20000);

        if (!res.ok) {
            context?.log?.(`[ComputerVision][Read] 失败: ${res.status}`);
            return null;
        }

        const data = await res.json();
        const text = data?.readResult?.content || '';
        const cleaned = String(text).replace(/\r/g, '').trim();
        if (cleaned) {
            context?.log?.(`[ComputerVision][Read] OCR字符数=${cleaned.length}`);
        }
        return cleaned || null;
    } catch (e) {
        context?.log?.(`[ComputerVision][Read] 异常: ${e.message}`);
        return null;
    }
}

module.exports = {
    checkAnimeDB,
    checkCustomVision,
    checkComputerVision,
    readTextFromComputerVision
};
