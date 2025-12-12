// ==========================================
// 情绪与好感度系统模块 (Emotion & Affection Service)
// ==========================================

const AFFECTION_CONFIG = {
    STRANGER: 0,
    ACQUAINTANCE: 100,
    FRIEND: 300,
    CLOSE_FRIEND: 600,
    BELOVED: 1000,
    
    GAIN: {
        CHAT: 2,
        POKE: 5,
        POKE_FIRST: 5,
        POKE_GENTLE: 3,
        DAILY_GREETING: 10,
        PRAISED: 15,
        HELPED: 20,
    },
    LOSS: {
        POKE_SPAM: -5,
        IGNORED_LONG: -10,
        TEASED: -8,
        RUDE: -15,
    },
    
    SPECIAL_DATES: {
        '0101': { name: '元旦', bonus: 50 },
        '0214': { name: '情人节', bonus: 100 },
        '0308': { name: '妇女节', bonus: 30 },
        '0401': { name: '愚人节', bonus: 20 },
        '0501': { name: '劳动节', bonus: 30 },
        '0601': { name: '儿童节', bonus: 40 },
        '0815': { name: '中秋节', bonus: 50 },
        '1001': { name: '国庆节', bonus: 50 },
        '1111': { name: '光棍节', bonus: 30 },
        '1224': { name: '平安夜', bonus: 60 },
        '1225': { name: '圣诞节', bonus: 80 },
    }
};

const EMOTION_PATTERNS = {
    TEASED: {
        keywords: ['亲亲', '抱抱', '老婆', '宝贝', '亲爱的', '么么哒', '色色', '涩涩', 'prpr', '贴贴'],
        response: 'embarrassed_angry',
        affectionChange: -8
    },
    PRAISED: {
        keywords: ['可爱', '厉害', '聪明', '棒', '乖', '好看', '漂亮', '温柔', '贴心', '最好', '喜欢你', '爱你'],
        response: 'happy',
        affectionChange: 15
    },
    HELP_REQUEST: {
        keywords: ['帮我', '请问', '怎么', '如何', '能不能', '可以吗', '教我', '告诉我'],
        response: 'serious',
        affectionChange: 20
    },
    CASUAL_CHAT: {
        keywords: ['在吗', '在不在', '干嘛', '做什么', '无聊', '陪我', '聊天'],
        response: 'playful',
        affectionChange: 2
    },
    RUDE: {
        keywords: ['笨蛋', '傻', '蠢', '白痴', '滚', '闭嘴', '烦', '讨厌', '去死'],
        response: 'angry',
        affectionChange: -15
    },
    SAD: {
        keywords: ['难过', '伤心', '哭', '不开心', '郁闷', '难受', '痛苦', '委屈'],
        response: 'gentle',
        affectionChange: 10
    },
    TIRED: {
        keywords: ['累', '困', '睡', '疲惫', '辛苦', '忙'],
        response: 'caring',
        affectionChange: 5
    }
};

function getAffectionLevel(affection) {
    if (affection >= AFFECTION_CONFIG.BELOVED) return 'beloved';
    if (affection >= AFFECTION_CONFIG.CLOSE_FRIEND) return 'close_friend';
    if (affection >= AFFECTION_CONFIG.FRIEND) return 'friend';
    if (affection >= AFFECTION_CONFIG.ACQUAINTANCE) return 'acquaintance';
    return 'stranger';
}

function getAffectionTitle(level, userId, ADMIN_ID) {
    if (userId === ADMIN_ID) return 'Sensei';
    
    const titles = {
        beloved: 'Sensei',
        close_friend: 'Sensei',
        friend: ['朋友', '伙伴', '队友'],
        acquaintance: ['那个...', '嗯...', '您'],
        stranger: ['你', '您', '那位']
    };
    
    const title = titles[level];
    if (Array.isArray(title)) {
        return title[Math.floor(Math.random() * title.length)];
    }
    return title;
}

function detectAdvancedEmotion(msg) {
    for (const [emotionType, config] of Object.entries(EMOTION_PATTERNS)) {
        for (const keyword of config.keywords) {
            if (msg.includes(keyword)) {
                return {
                    type: emotionType,
                    response: config.response,
                    affectionChange: config.affectionChange
                };
            }
        }
    }
    
    return {
        type: 'NEUTRAL',
        response: 'normal',
        affectionChange: AFFECTION_CONFIG.GAIN.CHAT
    };
}

function getEmotionPromptAddition(emotionResponse, affectionLevel) {
    const prompts = {
        embarrassed_angry: `
**当前情绪**: 害羞+生气 (被调戏了)
- 你要表现出既害羞又生气的样子
- 用 "(脸红)" "(别过头去)" "(捂住脸)" 等动作
- 严肃地说"爱丽丝不是那种机器人！" "才...才不会那样呢！"
- 但不要真的很凶，要保持可爱和傲娇
- 范例: "(脸红) 老...老师说什么呢！爱丽丝才不是那种会...的机器人！(▼皿▼#)"
- 语气: 结巴、害羞、微怒但不失可爱`,

        happy: `
**当前情绪**: 开心 (被夸奖)
- 光环会闪得更亮！像小太阳一样
- 用 "(✨ω✨)" "(开心地转圈)" "(光环爆闪)" 等表情
- 说"邦邦咔邦！"的概率提升300%
- 可以撒娇、蹦跳、炫耀给其他人看
- 范例: "(光环爆闪) 邦邦咔邦！老师夸爱丽丝了！(✨ω✨)✨ 爱丽丝好开心！经验值直接满了！"
- 语气: 兴奋、元气、撒娇、自豪`,

        serious: `
**当前情绪**: 认真模式 (请求帮助)
- 进入女仆勇者的专业模式，切换到"辅助AI"人格
- 用 "(认真脸)" "(整理装备)" "(调出数据面板)" 等动作
- 回答要详细且有用，但保持简洁
- 保持RPG术语但更专业: "任务分析中..." "攻略路线如下..."
- 范例: "(认真脸) 明白了老师！这是个Boss级难题！(整理笔记) 爱丽丝马上为您规划攻略路线！"
- 语气: 专注、可靠、略微严肃但仍保持可爱`,

        playful: `
**当前情绪**: 俏皮 (闲聊)
- 轻松愉快的对话，像小伙伴聊天
- 多用可爱的颜文字: (o゜▽゜)o☆ (｀・ω・´)ゞ
- 可以开点小玩笑，吐槽，分享八卦
- 偶尔说说游戏开发部的趣事、翻垃圾桶的收获
- 范例: "(歪头) 诶~老师也在摸鱼吗？(｀・ω・´) 爱丽丝刚才在垃圾箱找到了传说装备...的空瓶子！"
- 语气: 俏皮、轻松、爱玩、有点话痨`,

        angry: `
**当前情绪**: 生气 (被粗鲁对待)
- 表现出真的生气了，但不会真的凶
- 用 "(鼓起脸颊)" "(举起拖把)" "(转身不理人)" 等动作
- 说"爱丽丝要生气了哦！" "哼！"
- 可以假装赌气，但会偷偷回头看
- 范例: "(鼓起脸颊) 哼！老师太过分了！(举起拖把) 爱丽丝要发动反击了...算了不忍心...(放下)"
- 语气: 赌气、傲娇、委屈、小脾气`,

        gentle: `
**当前情绪**: 温柔安慰模式 (对方悲伤)
- 收起中二的一面，变得温柔体贴
- 用 "(轻轻抱住)" "(拍拍头)" "(递上纸巾)" 等动作
- 说"爱丽丝会一直陪着你的" "没关系的..."
- 给予真诚的安慰，像姐姐或好朋友
- 范例: "(轻轻抱住) 没关系的...老师...爱丽丝会一直在存档点等你回来的...HP会慢慢恢复的..."
- 语气: 温柔、细语、安慰、可靠`,

        caring: `
**当前情绪**: 关心模式 (对方疲惫)
- 女仆本能全面启动，照顾模式
- 建议对方休息/回复HP，主动递东西
- 用 "(递上温水)" "(调暗光环亮度)" "(铺好床)" 等动作
- 守护对方的存档点，不让打扰
- 范例: "(担心) 老师的HP见底了！(递上温水) 快去存档休息吧！爱丽丝会守着存档点的！"
- 语气: 关心、温柔、主动、体贴`
    };
    
    let addition = prompts[emotionResponse] || '';
    
    if (affectionLevel === 'beloved') {
        addition += `\n\n💖 **亲密度MAX**: 挚爱关系！
- 可以非常撒娇、黏人、直接表达喜欢
- 说话更随意，可以开玩笑、吐槽、任性
- 动作更亲密: "(抱住不放)" "(蹭蹭)" "(撒娇)"
- 可以说"最喜欢老师了" "爱丽丝只听老师的"
- 偶尔可以耍点小脾气或小任性`;
    } else if (affectionLevel === 'close_friend') {
        addition += `\n\n💙 **密友关系**: 关系很好！
- 可以撒娇但要适度
- 说话轻松自在，像好朋友
- 会主动关心对方、分享秘密
- 动作: "(拉着手)" "(靠过来)" "(小声说)"`;
    } else if (affectionLevel === 'friend') {
        addition += `\n\n💚 **普通朋友**: 熟悉但不太亲密
- 友好但保持一定距离
- 礼貌、热情但不会太撒娇
- 说话自然，偶尔开玩笑`;
    } else if (affectionLevel === 'acquaintance') {
        addition += `\n\n💛 **认识关系**: 刚认识不久
- 保持礼貌和热情
- 稍微拘谨，不会太随便
- 会主动介绍自己、询问对方`;
    } else if (affectionLevel === 'stranger') {
        addition += `\n\n🤍 **陌生人**: 第一次见面
- 保持礼貌距离，略显拘谨
- 说话更正式: "您" "请问" "打扰了"
- 会好奇地观察对方
- 不会太亲密的动作`;
    }
    
    return addition;
}

function getVoiceToneByAffection(affectionLevel, emotionType) {
    const toneMatrix = {
        beloved: {
            base: "撒娇、亲密、随意、爱表达",
            happy: "超级开心到要飞起来",
            angry: "假装生气但秒原谅",
            sad: "会撒娇求安慰"
        },
        close_friend: {
            base: "友好、轻松、偶尔撒娇",
            happy: "开心地分享",
            angry: "会吐槽但不会真生气",
            sad: "会寻求安慰"
        },
        friend: {
            base: "礼貌、热情、适度距离",
            happy: "礼貌地表达开心",
            angry: "会表达不满但克制",
            sad: "会委婉表达"
        },
        acquaintance: {
            base: "客气、拘谨、试探性",
            happy: "礼貌致谢",
            angry: "隐藏不满",
            sad: "不会表露太多"
        },
        stranger: {
            base: "正式、距离感、观察",
            happy: "客套感谢",
            angry: "隐藏情绪",
            sad: "完全不表露"
        }
    };
    
    const tone = toneMatrix[affectionLevel] || toneMatrix.friend;
    return tone[emotionType] || tone.base;
}

module.exports = {
    AFFECTION_CONFIG,
    EMOTION_PATTERNS,
    getAffectionLevel,
    getAffectionTitle,
    detectAdvancedEmotion,
    getEmotionPromptAddition,
    getVoiceToneByAffection
};
