// ==========================================
// 语音服务模块 (Voice Service)
// ==========================================

const GITHUB_AUDIO_BASE = "https://raw.githubusercontent.com/3361559784/aris-assets-video/main/";

const AUDIO_MAP = {
    // 核心招牌台词
    "邦邦咔邦": "CH0200_EventShop_Buy_1.wav",
    "panpaka": "ST0001_MiniGame_Start_1.wav",
    
    // Sensei 相关
    "先生": "Aris_Tactic_In_2.wav",
    "老师": "Aris_LogIn_1.wav",
    "SenSei": "Aris_LogIn_1.wav",
    "欢迎回来": "CH0200_LogIn_1.wav",
    
    // 战斗口头禅
    "光啊": "Aris_ExSkill_Level_1.wav",
    "光よ": "CH0200_ExSkill_Level_1.wav",
    "出击": "CH0200_LogIn_2.wav",
    "行きます": "Aris_Battle_Move_2.wav",
    
    // 日常互动
    "爱丽丝": "Aris_Battle_In_1.wav",
    "アリス": "CH0200_Formation_In_1.wav",
    "明白了": "Aris_Battle_Defense_1.wav",
    "没问题": "Aris_Battle_Defense_1.wav",
    
    // 任务相关
    "任务完成": "Aris_Tactic_Victory_2.wav",
    "ミッション": "CH0200_Battle_Victory_2.wav",
    "准备完了": "Aris_Formation_Select.wav",
    "準備": "CH0200_MemorialLobby_5.wav",
    
    // 女仆形态特色
    "メイド": "CH0200_Lobby_1.wav",
    "女仆": "CH0200_Battle_In_1.wav",
    "打扫": "CH0200_Tactic_Victory_2.wav",
    
    // 情感表达
    "幸せ": "Aris_Relationship_Up_4.wav",
    "开心": "CH0200_Relationship_Up_2.wav",
    "ありがとう": "CH0200_ExWeapon_Get.wav",
    
    // 战斗状态
    "レベル": "Aris_Growup_1.wav",
    "升级": "CH0200_Growup_1.wav",
    "回血": "Aris_Battle_Recovery_1.wav",
    "HP": "CH0200_Battle_Recovery_1.wav"
};

function checkKeywordAudio(text, context) {
    if (!text) return null;
    const cleanText = text.toLowerCase();
    
    for (const [keyword, fileName] of Object.entries(AUDIO_MAP)) {
        if (cleanText.includes(keyword.toLowerCase())) {
            const fileUrl = `${GITHUB_AUDIO_BASE}${fileName}`;
            context.log(`[Tier 1] 命中关键词 "${keyword}", 文件: ${fileName}`);
            return fileUrl;
        }
    }
    return null;
}

function getAudioSource(text, context, language = "auto") {
    let detectedLang = language;
    if (language === "auto") {
        if (/[\u4e00-\u9fa5]/.test(text)) {
            detectedLang = "zh";
        } else if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
            detectedLang = "ja";
        } else if (/^[a-zA-Z\s.,!?]+$/.test(text)) {
            detectedLang = "en";
        } else {
            detectedLang = "ja";
        }
    }
    
    context.log(`[语音路由] 检测语言: ${detectedLang}`);
    
    if (detectedLang === "ja") {
        const signatureAudioUrl = checkKeywordAudio(text, context);
        if (signatureAudioUrl) {
            return { source: "URL", url: signatureAudioUrl, lang: "ja" };
        }
    }
    
    return null;
}

module.exports = {
    GITHUB_AUDIO_BASE,
    AUDIO_MAP,
    checkKeywordAudio,
    getAudioSource
};
