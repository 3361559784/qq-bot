// ==========================================
// P0 新增功能模块 - schoolBot 增强
// ==========================================
// 本文件包含需要集成到 schoolBot.js 的新功能代码
// 请按照下面的说明将这些代码段添加到相应位置

// ==========================================
// 1. 环境变量配置（添加到文件顶部，GROUP_COOLDOWN_MS 之后）
// ==========================================

const REPLY_CONFIG = {
    MAX_SENTENCES: Number(process.env["ARIS_MAX_SENTENCES"] || 4),
    MIN_SENTENCES: Number(process.env["ARIS_MIN_SENTENCES"] || 3),
    MAX_CHARS: Number(process.env["ARIS_MAX_CHARS"] || 150),
    MIN_CHARS: Number(process.env["ARIS_MIN_CHARS"] || 120),
    ENABLE_SMART_SPLIT: process.env["ARIS_SMART_SPLIT"] !== "false",
    EMOJI_TO_KAOMOJI: process.env["ARIS_EMOJI_CONVERT"] !== "false"
};

const LANG_CONFIG = {
    DEFAULT_LANG: process.env["ARIS_DEFAULT_LANG"] || "zh",
    SUPPORTED_LANGS: ["zh", "ja", "en"],
    AUTO_DETECT: process.env["ARIS_AUTO_DETECT_LANG"] !== "false"
};

const MEMORY_SYSTEM_CONFIG = {
    ENABLE_LONG_TERM: process.env["ARIS_LONG_TERM_MEMORY"] === "true",
    MAX_LONG_TERM: Number(process.env["ARIS_MAX_LONG_TERM"] || 50),
    MEMORY_RETENTION_DAYS: Number(process.env["ARIS_MEMORY_DAYS"] || 30),
    SIMILARITY_THRESHOLD: Number(process.env["ARIS_SIMILARITY_THRESHOLD"] || 0.7),
    TOP_K_MEMORIES: Number(process.env["ARIS_TOP_K_MEMORIES"] || 3)
};

// ==========================================
// 2. Emoji 到颜文字映射表
// ==========================================

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

// ==========================================
// 3. 智能后处理函数（添加到现有辅助函数区域）
// ==========================================

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
// 4. 语言检测与多语言支持
// ==========================================

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
// 5. 记忆系统核心函数
// ==========================================

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

function formatMemoriesForPrompt(memories) {
    if (!memories || memories.length === 0) return '';
    
    const memoryText = memories
        .map((mem, idx) => `${idx + 1}. ${mem.content} (${new Date(mem.createdAt).toLocaleDateString()})`)
        .join('\n');
    
    return `\n## 📝 相关记忆 (Relevant Memories)\n以下是你与该用户的历史互动记录，请参考但不要直接复述：\n${memoryText}\n`;
}

// ==========================================
// 6. 修改 ARIS_PROMPT 使其参数化
// ==========================================
// 找到原来的 ARIS_PROMPT 定义，在其中修改硬编码的数字为配置变量：
// - 将 "每次回复 3-4 句话" 改为: `每次回复 ${REPLY_CONFIG.MIN_SENTENCES}-${REPLY_CONFIG.MAX_SENTENCES} 句话`
// - 将 "建议总字数 120-150 字" 改为: `建议总字数 ${REPLY_CONFIG.MIN_CHARS}-${REPLY_CONFIG.MAX_CHARS} 字`

module.exports = {
    // 导出供其他模块使用
    REPLY_CONFIG,
    LANG_CONFIG,
    MEMORY_SYSTEM_CONFIG,
    aiPostProcess,
    smartSplitMessage,
    detectLanguage,
    getPromptByLanguage,
    storeLongTermMemory,
    retrieveRelevantMemories,
    formatMemoriesForPrompt
};
