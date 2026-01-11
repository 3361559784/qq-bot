/**
 * Stage 0: Normalize - 输入标准化
 * 
 * 职责：
 * - trim、语言检测、时间/时区
 * - source（QQ/Web）、userId、requestId
 * 
 * 输出：RequestContext
 */

const crypto = require('crypto');

/**
 * 支持的语言
 */
const SUPPORTED_LANGS = ['zh', 'en', 'ja'];
const DEFAULT_LANG = 'zh';

/**
 * 语言检测（基于字符特征）
 */
function detectLanguage(text) {
    if (!text || typeof text !== 'string') return DEFAULT_LANG;
    
    const str = text.trim();
    if (!str) return DEFAULT_LANG;
    
    // 统计字符类型
    let cjkCount = 0;
    let japaneseCount = 0;
    let latinCount = 0;
    
    for (const char of str) {
        const code = char.charCodeAt(0);
        // CJK 统一汉字
        if (code >= 0x4E00 && code <= 0x9FFF) cjkCount++;
        // 平假名
        else if (code >= 0x3040 && code <= 0x309F) japaneseCount++;
        // 片假名
        else if (code >= 0x30A0 && code <= 0x30FF) japaneseCount++;
        // 拉丁字母
        else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) latinCount++;
    }
    
    const total = cjkCount + japaneseCount + latinCount;
    if (total === 0) return DEFAULT_LANG;
    
    // 有日文假名 → 日语
    if (japaneseCount > 0 && japaneseCount / total > 0.1) return 'ja';
    // 拉丁字母占多数 → 英语
    if (latinCount > total * 0.6) return 'en';
    // 默认中文
    return 'zh';
}

/**
 * 检测来源（QQ/Web）
 */
function detectSource(input, request) {
    // 显式指定
    if (input.source) return input.source.toLowerCase();
    
    // 从请求头检测
    if (request) {
        const ua = request.headers?.['user-agent'] || '';
        const origin = request.headers?.['origin'] || '';
        
        if (ua.includes('QQ') || origin.includes('qq.com')) return 'qq';
        if (origin.includes('localhost') || origin.includes('campus-ai')) return 'web';
    }
    
    // 从 body 检测
    if (input.group_id || input.user_id?.toString().match(/^\d{5,12}$/)) return 'qq';
    
    return 'web';
}

/**
 * 获取北京时间
 */
function getBeijingTime() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utc + 8 * 3600000);
}

/**
 * 获取时间段
 */
function getTimeOfDay(date) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 9) return 'morning';
    if (hour >= 9 && hour < 12) return 'forenoon';
    if (hour >= 12 && hour < 14) return 'noon';
    if (hour >= 14 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 22) return 'evening';
    return 'night';
}

/**
 * 获取星期几
 */
function getDayOfWeek(date) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[date.getDay()];
}

/**
 * 生成请求ID
 */
function generateRequestId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `req_${timestamp}_${random}`;
}

/**
 * 选择策略配置（Policy Profile）
 */
function selectPolicyProfile(source, requestId) {
    // 默认配置
    const profiles = {
        qq: {
            client: 'qq',
            version: 'qq-v1',
            allowedIntents: ['schedule_query', 'plan', 'weather_query', 'identity', 'search', 'wiki', 'vision', 'draw', 'chat'],
            allowChitchat: true,
            requireScheduleForTimeClaims: true,
            maxSearchCalls: 3,
            memory: { allow: true, requireUserConfirm: false },
            refusalStyle: 'soft',
            eligibilityThresholds: { refuse: 0.65, degrade: 0.45 }
        },
        web: {
            client: 'web',
            version: 'web-v1',
            allowedIntents: ['schedule_query', 'plan', 'weather_query', 'identity', 'search', 'wiki', 'vision', 'draw', 'chat'],
            allowChitchat: true,
            requireScheduleForTimeClaims: true,
            maxSearchCalls: 2,
            memory: { allow: true, requireUserConfirm: true },
            refusalStyle: 'strict',
            eligibilityThresholds: { refuse: 0.55, degrade: 0.35 }
        }
    };
    
    return profiles[source] || profiles.web;
}

/**
 * @typedef {Object} RequestContext
 * @property {string} requestId - 请求ID
 * @property {string} message - 标准化后的消息
 * @property {string} rawMessage - 原始消息
 * @property {string} userId - 用户ID
 * @property {string} groupId - 群组ID（QQ）
 * @property {string} source - 来源 (qq|web)
 * @property {string} lang - 检测到的语言
 * @property {Date} timestamp - 请求时间（北京时间）
 * @property {string} timeOfDay - 时间段
 * @property {string} dayOfWeek - 星期几
 * @property {Object} policyProfile - 策略配置
 * @property {Object} metadata - 额外元数据
 */

/**
 * 标准化请求输入
 * @param {Object} input - 原始输入
 * @param {Object} context - Azure Functions context
 * @returns {RequestContext}
 */
function normalizeRequest(input, context) {
    const requestId = generateRequestId();
    const rawMessage = input.message || input.msg || input.text || '';
    const message = String(rawMessage).trim();
    
    const source = detectSource(input, context?.req);
    const lang = input.lang || detectLanguage(message);
    
    const beijingTime = getBeijingTime();
    const timeOfDay = getTimeOfDay(beijingTime);
    const dayOfWeek = getDayOfWeek(beijingTime);
    
    const policyProfile = selectPolicyProfile(source, requestId);
    
    // 用户ID处理
    let userId = input.userId || input.user_id || input.senderId || 'anonymous';
    if (typeof userId === 'number') userId = userId.toString();
    
    // 群组ID（QQ专用）
    let groupId = input.groupId || input.group_id || null;
    if (typeof groupId === 'number') groupId = groupId.toString();
    
    const requestContext = {
        requestId,
        message,
        rawMessage,
        userId,
        groupId,
        source,
        lang,
        timestamp: beijingTime,
        timeOfDay,
        dayOfWeek,
        policyProfile,
        metadata: {
            hasImage: !!(input.images?.length || input.imageUrl),
            imageUrls: input.images || (input.imageUrl ? [input.imageUrl] : []),
            hasFile: !!(input.files?.length || input.fileUrl),
            fileUrls: input.files || (input.fileUrl ? [input.fileUrl] : []),
            isAtBot: input.isAtBot ?? true,
            messageType: input.messageType || 'text',
            originalInput: input
        },
        // 澄清状态（从输入中恢复）
        clarificationState: input.clarificationState || null
    };
    
    context?.log?.(`[Stage0] Normalized: rid=${requestId} src=${source} lang=${lang} msgLen=${message.length}`);
    
    return requestContext;
}

module.exports = {
    normalizeRequest,
    detectLanguage,
    detectSource,
    getBeijingTime,
    getTimeOfDay,
    getDayOfWeek,
    generateRequestId,
    selectPolicyProfile,
    SUPPORTED_LANGS,
    DEFAULT_LANG
};
