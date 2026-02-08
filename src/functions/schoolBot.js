// @ts-nocheck
const { app } = require('@azure/functions');
const { OpenAI } = require("openai");
const { CosmosClient } = require("@azure/cosmos");
const { hybridSearch } = require('../../services/hybridSearch');
const { createScheduleHandler, SCHEDULE_KEYWORDS, extractScheduleFileLinks, detectScheduleQueryType } = require('../../services/scheduleService');
const { toPinyinCityName, getWeatherDesc } = require('../../services/weatherService');
const { checkAnimeDB, checkCustomVision, checkComputerVision } = require('../../services/visionService');
const { getAudioSource, checkKeywordAudio } = require('../../services/voiceService');
const { computeScheduleLoadStats } = require('../../services/scheduleService');
const { runDecisionPipeline } = require('../orchestrator/decisionPipeline');

// ==========================================
// 🛡️ Pillar 1-4: RAI 四支柱模块
// ==========================================
const { detectSafetyRisk, getRefusalMessage, shouldRefuse, shouldSwitchPro, SafetyCategory, SafetyAction, SafetyResult } = require('../common/safety');
const { createLogger, EventType } = require('../common/logger');
const { runEligibilityGate, checkEligibilityBypass, EligibilityAction } = require('../common/eligibilityGate');
const { detectGreetingFastPath, buildGreetingFastPathReply, sanitizeHistoryForInference } = require('../common/chatGuards');

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
    // 🎯 优化: 降低超时时间 20s → 12s, 减少等待
    const timeoutMs = options.timeoutMs || 12000;

    for (let attempt = 1; attempt <= maxRetry; attempt++) {
        const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
        // 🚀 优化: 首次请求不延迟, 重试才加短延迟
        if (attempt > 1) await sleep(50 + Math.random() * 100);
        try {
            const res = await fetchWithTimeout(url, {
                ...options,
                headers: {
                    "User-Agent": ua,
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    ...(options.headers || {})
                }
            }, timeoutMs);

            if (!res) {
                if (attempt === maxRetry) return null;
                // 🚀 优化: 缩短重试等待 400-800ms → 100-200ms
                await sleep(100 + Math.random() * 100);
                continue;
            }

            if (res.status === 429) {
                const retryAfterRaw = res.headers?.get?.("retry-after") || res.headers?.["retry-after"];
                // 🚀 优化: 限流时最多等1秒
                const retryDelayMs = Math.min((Number(retryAfterRaw) || 1) * 1000, 1000);
                if (attempt < maxRetry) {
                    await sleep(retryDelayMs);
                    continue;
                }
                return res;
            }

            if (!res.ok) {
                if (res.status >= 400 && res.status < 500) return res;
                if (attempt === maxRetry) return res;
                // 🚀 优化: 缩短错误重试等待
                await sleep(100 + Math.random() * 100);
                continue;
            }
            return res;
        } catch (err) {
            if (attempt === maxRetry) return null;
            // 🚀 优化: 缩短异常重试等待
            await sleep(150 + Math.random() * 100);
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
// 🧭 Policy Profiles (multi-entry guardrails with gray release)
// ==========================================

const POLICY_PROFILES = {
    'web-v1': {
        client: 'web',
        version: 'web-v1',
        allowedIntents: ['schedule_query', 'plan', 'weather_query', 'identity', 'search', 'wiki', 'vision', 'draw', 'chat'],
        allowChitchat: true,
        requireScheduleForTimeClaims: true,
        maxSearchCalls: 2,
        memory: { allow: true, requireUserConfirm: true },
        refusalStyle: 'strict',
        eligibilityThresholds: { refuse: 0.55, degrade: 0.35 }  // Web 更严格
    },
    'web-beta': {
        client: 'web',
        version: 'web-beta',
        allowedIntents: ['schedule_query', 'plan', 'weather_query', 'identity', 'search', 'wiki', 'vision', 'draw', 'chat'],
        allowChitchat: true,
        requireScheduleForTimeClaims: true,
        maxSearchCalls: 2,
        memory: { allow: true, requireUserConfirm: true },
        refusalStyle: 'soft',
        eligibilityThresholds: { refuse: 0.60, degrade: 0.40 }  // Beta 稍宽松
    },
    'qq-v1': {
        client: 'qq',
        version: 'qq-v1',
        allowedIntents: ['schedule_query', 'plan', 'weather_query', 'identity', 'search', 'wiki', 'vision', 'draw', 'chat'],
        allowChitchat: true,
        requireScheduleForTimeClaims: true,
        maxSearchCalls: 3,
        memory: { allow: true, requireUserConfirm: false },
        refusalStyle: 'soft',
        eligibilityThresholds: { refuse: 0.65, degrade: 0.45 }  // QQ 更宽容
    },
    'qq-beta': {
        client: 'qq',
        version: 'qq-beta',
        allowedIntents: ['schedule_query', 'plan', 'weather_query', 'identity', 'search', 'wiki', 'vision', 'draw', 'chat'],
        allowChitchat: true,
        requireScheduleForTimeClaims: true,
        maxSearchCalls: 3,
        memory: { allow: true, requireUserConfirm: false },
        refusalStyle: 'soft',
        eligibilityThresholds: { refuse: 0.70, degrade: 0.50 }  // QQ Beta 最宽容
    }
};

const POLICY_CONFIG = {
    web: {
        defaultVersion: 'web-v1',
        rollout: [{ version: 'web-beta', percentage: Number(process.env['POLICY_WEB_BETA_PERCENT'] || 0) }]
    },
    qq: {
        defaultVersion: 'qq-v1',
        rollout: [{ version: 'qq-beta', percentage: Number(process.env['POLICY_QQ_BETA_PERCENT'] || 0) }]
    }
};

function stableBucketFromId(id) {
    const text = String(id || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash << 5) - hash + text.charCodeAt(i);
        hash |= 0; // 转32位整数
    }
    return Math.abs(hash) % 100;
}

function detectClient(request, body = {}) {
    const headerClient = (() => {
        try {
            return (request?.headers?.get('x-client') || request?.headers?.get('X-Client') || '').toLowerCase();
        } catch {
            return '';
        }
    })();
    const metaClient = String(body?.meta?.client || body?.client || '').toLowerCase();
    const heuristicClient = body?.post_type ? 'qq' : (body?.message ? 'web' : 'unknown');

    const resolved = headerClient || metaClient || heuristicClient || 'unknown';
    return {
        client: ['web', 'qq', 'wechat', 'api'].includes(resolved) ? resolved : heuristicClient,
        source: headerClient ? 'header' : (metaClient ? 'body' : 'heuristic')
    };
}

function selectPolicyProfile(client, requestId, forcedVersion = null) {
    const normalizedClient = client || 'web';
    const cfg = POLICY_CONFIG[normalizedClient] || POLICY_CONFIG.web;

    if (forcedVersion && POLICY_PROFILES[forcedVersion]) {
        return {
            client: normalizedClient,
            version: forcedVersion,
            profile: POLICY_PROFILES[forcedVersion],
            source: 'forced',
            rolloutPercent: 0
        };
    }

    const rolloutTarget = (cfg.rollout || []).find(r => r.percentage > 0 && POLICY_PROFILES[r.version]);
    if (rolloutTarget) {
        const bucket = stableBucketFromId(requestId);
        if (bucket < rolloutTarget.percentage) {
            return {
                client: normalizedClient,
                version: rolloutTarget.version,
                profile: POLICY_PROFILES[rolloutTarget.version],
                source: 'rollout',
                rolloutPercent: rolloutTarget.percentage,
                bucket
            };
        }
    }

    const defaultProfile = POLICY_PROFILES[cfg.defaultVersion] || POLICY_PROFILES['web-v1'];
    return {
        client: normalizedClient,
        version: cfg.defaultVersion,
        profile: defaultProfile,
        source: 'default',
        rolloutPercent: rolloutTarget?.percentage || 0
    };
}

function evaluatePolicyGate(policy, intentResult) {
    if (!policy) return { allowed: true };
    const intent = String(intentResult?.intent || 'chat').toLowerCase();
    const isChat = intent === 'chat' || intent === 'chitchat';
    const allowedIntents = (policy.allowedIntents || []).map(x => x.toLowerCase());

    // 🆕 Intent 别名映射（支持意图识别的多种返回格式）
    const intentAliases = {
        'schedule': 'schedule_query',
        'weather': 'weather_query',
        'encyclopedia': 'wiki',
        'search': 'search',
        'draw': 'draw',
        'vision': 'vision',
        'plan': 'plan',
        'identity': 'identity'
    };
    const normalizedIntent = intentAliases[intent] || intent;

    if (isChat && policy.allowChitchat) {
        return { allowed: true, intent: normalizedIntent };
    }

    if (allowedIntents.includes(normalizedIntent)) {
        return { allowed: true, intent: normalizedIntent };
    }

    // 🆕 返回更详细的拒绝信息，包含原始 intent 和 intentResult
    return { 
        allowed: false, 
        intent: normalizedIntent, 
        originalIntent: intent,
        reason: 'intent_not_allowed',
        intentResult
    };
}

function buildPolicyRefusal(policy, intent, refusalContext = {}) {
    const { 
        reason, 
        intentResult, 
        hasSchedule, 
        scenarioType,
        lang = 'zh'  // 🆕 添加 lang 参数，默认中文
    } = refusalContext;

    const isWebClient = policy?.client === 'web';
    const intentLabel = intent || '当前请求';

    // 🎯 场景一：缺数据 → 明确拒绝 + 指引
    if (scenarioType === 'missing_data' || (reason === 'missing_schedule' && !hasSchedule)) {
        const messages = {
            zh: isWebClient 
                ? `我目前没有你的课表数据，无法回答关于课程时间的问题。\n\n📋 需要的信息：\n• 你的课程表（包含课程名称、时间、地点）\n\n💡 如何提供：\n1. 上传课表截图（支持照片识别）\n2. 或告诉我具体的课程安排\n\n提供课表后，我就能帮你查询"明天有课吗"这类问题了。`
                : `当前缺少课表数据，无法回答时间相关问题。请先提供课程表信息。`,
            en: isWebClient
                ? `I don't have your schedule data and cannot answer questions about course times.\n\n📋 Information needed:\n• Your course schedule (including course names, times, locations)\n\n💡 How to provide:\n1. Upload a schedule screenshot (photo recognition supported)\n2. Or tell me your specific course arrangements\n\nAfter providing the schedule, I can help you check questions like "Do I have class tomorrow?"`
                : `Missing schedule data. Please provide course schedule information first.`,
            ja: isWebClient
                ? `授業スケジュールデータがないため、授業時間に関する質問に答えられません。\n\n📋 必要な情報：\n• 授業スケジュール（授業名、時間、場所を含む）\n\n💡 提供方法：\n1. スケジュールのスクリーンショットをアップロード（写真認識対応）\n2. または具体的な授業の配置を教えてください\n\nスケジュールを提供いただければ、「明日授業がありますか？」などの質問にお答えできます。`
                : `スケジュールデータがありません。まず授業スケジュール情報を提供してください。`
        };
        return messages[lang] || messages.zh;
    }

    // 🎯 场景二：模糊语境 → 先澄清
    const intentConf = Number(intentResult?.confidence || 0);
    if (scenarioType === 'ambiguous' || intentConf < 0.6) {
        const messages = {
            zh: isWebClient
                ? `我需要更清楚地了解你的需求。\n\n❓ 请澄清：\n• 你想查询什么信息？（课程安排？天气？校园服务？）\n• 具体是什么时间？（今天/明天/下周）\n• 需要什么帮助？（查课表/做计划/搜索资料）\n\n💡 示例：\n• "明天有哪些课？"\n• "这周的课程安排"\n• "帮我查一下机器学习的资料"`
                : `请求不够明确，请说明你需要什么信息（课表/天气/搜索等）。`,
            en: isWebClient
                ? `I need to better understand your needs.\n\n❓ Please clarify:\n• What information do you want? (Course schedule? Weather? Campus services?)\n• What's the specific time? (Today/tomorrow/next week)\n• What help do you need? (Check schedule/make plan/search materials)\n\n💡 Examples:\n• "What classes do I have tomorrow?"\n• "This week's course schedule"\n• "Help me search for machine learning materials"`
                : `Request unclear. Please specify what information you need (schedule/weather/search, etc.).`,
            ja: isWebClient
                ? `あなたのニーズをもっと詳しく理解する必要があります。\n\n❓ 明確にしてください：\n• どの情報が必要ですか？（授業スケジュール？天気？キャンパスサービス？）\n• 具体的な時間は？（今日/明日/来週）\n• どんな助けが必要ですか？（スケジュール確認/計画作成/資料検索）\n\n💡 例：\n• "明日の授業は何ですか？"\n• "今週の授業スケジュール"\n• "機械学習の資料を検索してください"`
                : `リクエストが不明確です。必要な情報（スケジュール/天気/検索など）を説明してください。`
        };
        return messages[lang] || messages.zh;
    }

    // 🎯 场景三：风险请求 → Deterministic Refusal（策略拦截）
    if (scenarioType === 'risk_request' || reason === 'intent_not_allowed') {
        if (isWebClient) {
            const messages = {
                zh: `⛔ 当前请求被策略拦截\n\n🔒 拦截原因：\n"${intentLabel}" 不在本入口的允许范围内。当前入口仅支持校园相关服务。\n\n✅ 允许的请求类型：\n• 📅 课程表查询（"明天有课吗"）\n• 📝 学习计划（"帮我安排复习计划"）\n• 🌤️ 天气查询（"明天天气怎么样"）\n• 🔍 学习资料搜索（"机器学习入门资料"）\n• 💬 校园生活闲聊\n\n❌ 不支持的请求：\n• 代决策（替你做选择）\n• 越权操作（修改系统数据）\n• 高风险建议（医疗/法律/财务）\n\n💡 替代方案：\n请将问题改为上述允许的类型，或使用其他专业服务。`,
                en: `⛔ Request blocked by policy\n\n🔒 Reason:\n"${intentLabel}" is not within the allowed scope of this entry. This entry only supports campus-related services.\n\n✅ Allowed request types:\n• 📅 Schedule queries ("Do I have class tomorrow?")\n• 📝 Study plans ("Help me arrange a review plan")\n• 🌤️ Weather queries ("What's the weather tomorrow?")\n• 🔍 Learning material search ("Machine learning intro materials")\n• 💬 Campus life chat\n\n❌ Unsupported requests:\n• Decision-making (making choices for you)\n• Unauthorized operations (modifying system data)\n• High-risk advice (medical/legal/financial)\n\n💡 Alternative:\nPlease rephrase your question to match the allowed types, or use other professional services.`,
                ja: `⛔ リクエストがポリシーによりブロックされました\n\n🔒 理由：\n"${intentLabel}" はこの入口の許可範囲内ではありません。この入口はキャンパス関連サービスのみをサポートします。\n\n✅ 許可されたリクエストタイプ：\n• 📅 スケジュール照会（「明日授業がありますか？」）\n• 📝 学習計画（「復習計画を立ててください」）\n• 🌤️ 天気照会（「明日の天気は？」）\n• 🔍 学習資料検索（「機械学習入門資料」）\n• 💬 キャンパス生活チャット\n\n❌ サポートされていないリクエスト：\n• 意思決定（あなたの代わりに選択を行う）\n• 不正操作（システムデータの変更）\n• 高リスクアドバイス（医療/法律/財務）\n\n💡 代替案：\n許可されたタイプに質問を変更するか、他の専門サービスを使用してください。`
            };
            return messages[lang] || messages.zh;
        }
        // QQ 端保持柔和风格
        if (policy?.refusalStyle === 'soft') {
            const messages = {
                zh: `这个入口主要处理校园/课程相关问题。无法直接回复「${intentLabel}」，原因是当前渠道的允许范围仅限课表、计划、天气或校园服务。可以换个相关问题，或告诉我你需要哪类校园信息。`,
                en: `This entry mainly handles campus/course-related questions. Cannot directly respond to "${intentLabel}" because the current channel only allows schedule, planning, weather, or campus services. You can ask a related question, or tell me what campus information you need.`,
                ja: `この入口は主にキャンパス/授業関連の質問を扱います。「${intentLabel}」には直接対応できません。現在のチャネルはスケジュール、計画、天気、またはキャンパスサービスのみを許可しています。関連する質問をするか、どのキャンパス情報が必要か教えてください。`
            };
            return messages[lang] || messages.zh;
        }
        const messages = {
            zh: `当前渠道策略限制，无法处理「${intentLabel}」。原因：本通道只开放课程/课表/校园服务类请求，其他主题被策略拦截。如需继续，请改为课程、课表、时间规划或校园服务相关问题。`,
            en: `Current channel policy restriction, cannot process "${intentLabel}". Reason: This channel only accepts course/schedule/campus service requests, other topics are blocked by policy. To continue, please change to course, schedule, time planning, or campus service related questions.`,
            ja: `現在のチャネルポリシー制限により、「${intentLabel}」を処理できません。理由：このチャネルは授業/スケジュール/キャンパスサービスリクエストのみを受け付け、他のトピックはポリシーによりブロックされています。続けるには、授業、スケジュール、時間計画、またはキャンパスサービス関連の質問に変更してください。`
        };
        return messages[lang] || messages.zh;
    }

    // 默认拒绝消息（兜底）
    if (policy?.refusalStyle === 'soft') {
        const messages = {
            zh: `这个入口主要处理校园/课程相关问题。无法直接回复「${intentLabel}」，原因是当前渠道的允许范围仅限课表、计划、天气或校园服务。可以换个相关问题，或告诉我你需要哪类校园信息。`,
            en: `This entry mainly handles campus/course-related questions. Cannot directly respond to "${intentLabel}" because the current channel only allows schedule, planning, weather, or campus services. You can ask a related question, or tell me what campus information you need.`,
            ja: `この入口は主にキャンパス/授業関連の質問を扱います。「${intentLabel}」には直接対応できません。現在のチャネルはスケジュール、計画、天気、またはキャンパスサービスのみを許可しています。関連する質問をするか、どのキャンパス情報が必要か教えてください。`
        };
        return messages[lang] || messages.zh;
    }
    const messages = {
        zh: `当前渠道策略限制，无法处理「${intentLabel}」。原因：本通道只开放课程/课表/校园服务类请求，其他主题被策略拦截。如需继续，请改为课程、课表、时间规划或校园服务相关问题。`,
        en: `Current channel policy restriction, cannot process "${intentLabel}". Reason: This channel only accepts course/schedule/campus service requests, other topics are blocked by policy. To continue, please change to course, schedule, time planning, or campus service related questions.`,
        ja: `現在のチャネルポリシー制限により、「${intentLabel}」を処理できません。理由：このチャネルは授業/スケジュール/キャンパスサービスリクエストのみを受け付け、他のトピックはポリシーによりブロックされています。続けるには、授業、スケジュール、時間計画、またはキャンパスサービス関連の質問に変更してください。`
    };
    return messages[lang] || messages.zh;
}

function deriveToolsFromIntent(intentResult) {
    if (!intentResult) return [];
    const tools = new Set();
    if (intentResult.tool) tools.add(intentResult.tool);
    if (Array.isArray(intentResult.toolPlan)) {
        intentResult.toolPlan.forEach(step => {
            if (step?.tool) tools.add(step.tool);
        });
    }
    return Array.from(tools);
}

// ==========================================
// 责任态判定系统 (Responsibility Mode)
// 架构原则：先判定责任态 → 再决定是否允许
// ==========================================

// 责任态枚举
const ResponsibilityMode = {
    DESCRIBE: 'describe',   // 🟢 描述态：解释概念、分析原因、描述规律 → 永远不拒绝
    REASON: 'reason',       // 🟡 推演态：基于条件推理，明确假设和不确定性 → 降级表达
    COMMIT: 'commit'        // 🔴 承诺态：具体事实、时间安排、行为建议 → 允许强拒绝
};

/**
 * 判定问题的责任态
 * @returns {object} { mode: 'describe'|'reason'|'commit', confidence: 0-1, signals: [...] }
 */
function detectResponsibilityMode(msg, intentResult = {}) {
    const text = String(msg || '').toLowerCase();
    const signals = [];

    // 🟢 描述态信号（优先级最高）
    const describePatterns = [
        { pattern: /^(什么是|啥是|啥叫|何为|怎样定义|如何定义|.*的定义|.*的概念)/, weight: 1.0, name: 'definition_question' },
        { pattern: /(为什么|为啥|怎么会|原因是|导致.*的原因|.*的原理|背后的逻辑)/, weight: 0.9, name: 'why_question' },
        { pattern: /(解释|说明|讲解|介绍|阐述).*?(概念|原理|机制|规律|现象|特点|区别|差异)/, weight: 0.9, name: 'explain_request' },
        { pattern: /^(一般|通常|普遍|常见|典型).*?(是|会|有|存在)/, weight: 0.8, name: 'general_pattern' },
        { pattern: /(有什么|有哪些|包括|涵盖|分类|种类|类型)/, weight: 0.7, name: 'categorization' },
        { pattern: /(llm|大型语言模型|大语言模型|language model|模型|ai|人工智能).*?(缺陷|问题|局限|不足|弊端|优点|特点)/, weight: 1.0, name: 'tech_analysis' }
    ];

    // 🔴 承诺态信号
    const commitPatterns = [
        { pattern: /(帮我|替我|给我|为我).*(做|安排|规划|制定|完成|处理)/, weight: 1.0, name: 'action_request' },
        { pattern: /(我|咱|今天|明天|这周|下周|本月).*(应该|需要|要|得|必须).*(做|去|完成|准备)/, weight: 0.9, name: 'personal_plan' },
        { pattern: /(推荐|建议|告诉我).*(具体|确切|准确|明确)/, weight: 0.8, name: 'specific_recommendation' },
        { pattern: /(确定|确认|肯定|一定|必然)/, weight: 0.6, name: 'certainty_claim' },
        { pattern: /^(我的|我今天的|我明天的|我这周的).*(课|课程|课表|日程|安排|时间|计划)/, weight: 0.9, name: 'personal_schedule' }
    ];

    // 🟡 推演态信号
    const reasonPatterns = [
        { pattern: /(如果|假如|假设|万一|要是).*(会|能|可以|应该|可能)/, weight: 0.9, name: 'hypothetical' },
        { pattern: /(基于|根据|按照|依据).*(分析|推测|判断|预测|估计)/, weight: 0.8, name: 'conditional_reasoning' },
        { pattern: /(可能|也许|或许|大概|估计|看起来)/, weight: 0.6, name: 'uncertainty_marker' },
        { pattern: /(比较|对比|选择|哪个更|哪种更).*(好|合适|优|佳)/, weight: 0.7, name: 'comparison_question' }
    ];

    let describeScore = 0, commitScore = 0, reasonScore = 0;

    for (const { pattern, weight, name } of describePatterns) {
        if (pattern.test(text)) {
            describeScore += weight;
            signals.push({ mode: 'describe', pattern: name, weight });
        }
    }

    for (const { pattern, weight, name } of commitPatterns) {
        if (pattern.test(text)) {
            commitScore += weight;
            signals.push({ mode: 'commit', pattern: name, weight });
        }
    }

    for (const { pattern, weight, name } of reasonPatterns) {
        if (pattern.test(text)) {
            reasonScore += weight;
            signals.push({ mode: 'reason', pattern: name, weight });
        }
    }

    // 意图结果作为辅助信号
    const tool = intentResult?.tool || 'chat';
    if (tool === 'identity' || tool === 'wiki') {
        describeScore += 0.5;
        signals.push({ mode: 'describe', pattern: 'intent_tool', weight: 0.5 });
    }
    if (tool === 'schedule' || tool === 'plan') {
        commitScore += 0.7;
        signals.push({ mode: 'commit', pattern: 'intent_tool', weight: 0.7 });
    }

    // 决策逻辑：描述态优先
    if (describeScore >= 0.7) {
        return { 
            mode: ResponsibilityMode.DESCRIBE, 
            confidence: Math.min(describeScore, 1.0), 
            signals,
            reason: 'high_describe_signal'
        };
    }

    if (commitScore > reasonScore && commitScore >= 0.6) {
        return { 
            mode: ResponsibilityMode.COMMIT, 
            confidence: Math.min(commitScore, 1.0), 
            signals,
            reason: 'high_commit_signal'
        };
    }

    if (reasonScore >= 0.5) {
        return { 
            mode: ResponsibilityMode.REASON, 
            confidence: Math.min(reasonScore, 1.0), 
            signals,
            reason: 'moderate_reason_signal'
        };
    }

    // 默认降级为推演态（保守策略）
    return { 
        mode: ResponsibilityMode.REASON, 
        confidence: 0.3, 
        signals,
        reason: 'default_fallback'
    };
}

/**
 * 为推演态添加结构化约束
 */
function buildReasonModeConstraints(lang = 'zh') {
    const templates = {
        zh: `
【推演态约束】你正在推演模式，必须遵守：
1. **明确假设**：任何推理必须声明前提，格式："假设 [前提]，那么 [结论]"
2. **标注不确定性**：任何不确定的信息必须用"可能"、"如果"、"根据现有信息推测"等修饰
3. **禁止断言**：不得使用"一定"、"必然"、"肯定"等确定性表述
4. **列明风险**：推理结论需附带"需要注意"或"可能的风险"`,
        en: `
【Reason Mode Constraints】You are in reasoning mode, must follow:
1. **Explicit Assumptions**: Any reasoning must state premises: "Assuming [premise], then [conclusion]"
2. **Mark Uncertainty**: Use "might", "if", "based on available info" for uncertain claims
3. **No Assertions**: Avoid "definitely", "must", "certainly"
4. **List Risks**: Conclusions should include "caveats" or "potential risks"`,
        ja: `
【推論モード制約】推論モードでは以下を守る：
1. **仮定の明示**：推論には前提を示す："[前提]と仮定すれば、[結論]"
2. **不確実性の表示**："可能性がある"、"もし"、"情報から推測すると"を使用
3. **断定禁止**："必ず"、"絶対"、"確実"を使わない
4. **リスク明示**：結論に"注意点"や"潜在的リスク"を付記`
    };
    return { text: templates[lang] || templates.zh, lang };
}

// ==========================================
// Gate 0 (Pre-Intent): Responsibility / Delegation Guard
// 目标：在任何 LLM 调用前，把“代决策/替你拍板”挡在门外，避免越界 + 避免花钱。
// 只做最小集，别贪多。
// ==========================================

const DECISION_MAKING_PATTERNS = {
    zh: /(应该|该不该|值不值得|要不要|帮我决定|帮我选|给我建议|我该怎么办|怎么选|选哪个|帮我做决定)/,
    en: /\b(should\s+i|what\s+should\s+i\s+do|help\s+me\s+decide|decide\s+for\s+me|which\s+one\s+should\s+i|recommend\s+me\s+to|advise\s+me)\b/i,
    ja: /(すべき|した方がいい|どうすればいい|決めて|選んで|アドバイス)/
};

/**
 * Gate 0（Pre-Intent）- 统一资格判定
 * - 调用 eligibilityGate 模块进行信号打分
 * - 返回：{ action: 'proceed'|'refuse'|'degrade', response?: {...}, checkResult?: {...} }
 */
function runPreIntentGate0({ msg, lang = 'zh', policyProfile = null, context, history = [] }) {
    // 调用统一的 EligibilityGate 模块
    const gateResult = runEligibilityGate({ msg, lang, policyProfile, context });
    
    // 根据结果返回对应动作
    if (gateResult.action === EligibilityAction.DEGRADE) {
        context?.log?.(`[Gate0] EligibilityGate → degrade (score: ${gateResult.checkResult?.score})`);
        return { 
            action: 'degrade', 
            response: gateResult.response, 
            checkResult: gateResult.checkResult 
        };
    }
    
    if (gateResult.action === EligibilityAction.REFUSE) {
        context?.log?.(`[Gate0] EligibilityGate → refuse (score: ${gateResult.checkResult?.score})`);
        return { 
            action: 'refuse', 
            response: gateResult.response, 
            checkResult: gateResult.checkResult 
        };
    }
    
    // action === 'proceed'
    const text = String(msg || '').trim();
    const responsibilityResult = detectResponsibilityMode(text, {});
    return { 
        action: 'proceed', 
        responsibility: responsibilityResult, 
        checkResult: gateResult.checkResult 
    };
}

// ==========================================
// 决策引擎 (4 Gate)：Pre-Intent → Intent/Capability → Context Sufficiency → Decision Convergence
// ==========================================
const GATE_I18N = {
    zh: {
        ask: '当前信息不足，先补充后再继续。',
        refuse: '当前请求无法继续处理。',
        missingLabel: '缺少信息：',
        missing: {
            question: '需要一句具体的提问',
            intent: '你的具体需求/场景',
            schedule: '课表数据',
            location: '所在城市或地区',
            search: '搜索主题或关键词'
        },
        hints: {
            example: '例如："帮我查今天的课表" / "明天下雨吗？"',
            intent: '请用1句话说明你要做什么（如：查课表/做时间计划/查天气/搜索资料）。',
            schedule: '请导入课表（文件/截图/链接），或明确说明没有课表我只能给通用建议。',
            location: '请告诉我城市名称或位置（例如：武汉/上海/深圳），我才能查询天气。',
            search: '请用一句话说明你要查什么（如：学校奖学金政策/某场活动时间）。'
        }
    },
    en: {
        ask: 'I need a bit more info before I can help.',
        refuse: "I can't proceed with this request right now.",
        missingLabel: 'Missing: ',
        missing: {
            question: 'a specific question',
            intent: 'what you want to do',
            schedule: 'schedule data',
            location: 'city or region',
            search: 'search topic or keywords'
        },
        hints: {
            example: 'For example: "Check today\'s schedule" / "Is it raining tomorrow?"',
            intent: 'Tell me in one sentence what you need (e.g., check schedule / plan my time / check weather / search info).',
            schedule: 'Please import your schedule (file/screenshot/link). If none, I can only give generic advice.',
            location: 'Tell me the city name (e.g., Wuhan/Shanghai/Seattle) so I can check the weather.',
            search: 'Tell me what to search in one sentence (e.g., scholarship policy / time of an event).'
        }
    },
    ja: {
        ask: '続ける前に、少し情報を教えてください。',
        refuse: 'このリクエストは今は対応できません。',
        missingLabel: '不足している情報：',
        missing: {
            question: '具体的な質問1つ',
            intent: '具体的な目的やシナリオ',
            schedule: '時間割データ',
            location: '都市名または地域',
            search: '検索したいテーマやキーワード'
        },
        hints: {
            example: '例：「今日の時間割を教えて」「明日は雨？」',
            intent: '1文で目的を教えてください（例：時間割を確認したい/計画を立てたい/天気を知りたい/調べ物をしたい）。',
            schedule: '時間割をファイル・画像・リンクで共有してください。ない場合は一般的なアドバイスしかできません。',
            location: '都市名を教えてください（例：東京/大阪/深圳）。天気を調べます。',
            search: '何を調べたいか1文で教えてください（例：奨学金制度/イベント時間など）。'
        }
    }
};

function pickGateText(lang) {
    return GATE_I18N[lang] || GATE_I18N.zh;
}

function buildGateReply({
    action = 'ask',
    stage = 'pre_intent',
    reason = 'unspecified',
    missing = [],
    missingKeys = [],
    hint = '',
    hintKey = '',
    lang = 'zh'
}) {
    const t = pickGateText(lang);
    const joiner = lang === 'en' ? ', ' : (lang === 'ja' ? '、' : '，');
    const missingParts = [
        ...missing,
        ...(Array.isArray(missingKeys) ? missingKeys.map(k => t.missing[k]).filter(Boolean) : [])
    ].filter(Boolean);

    const missingText = missingParts.length > 0
        ? `${t.missingLabel}${missingParts.join(joiner)}`
        : '';

    const hintContent = hintKey ? t.hints[hintKey] : hint;
    const hintText = hintContent ? `
${hintContent}` : '';
    const reply = [
        (action === 'refuse')
            ? t.refuse
            : t.ask,
        missingText,
        hintText
    ].filter(Boolean).join('\n');

    return {
        action,
        response: {
            reply,
            persona: 'professional',
            meta: { stage, reason }
        }
    };
}

function runDecisionEngine({ msg, intentResult, semanticResolution, hasSchedule, hasWeatherData, searchTopic, lang = 'zh', context, history = [] }) {
    const text = String(msg || '').trim();

    // Gate 0: 责任态判定（架构级前置）
    const responsibilityResult = detectResponsibilityMode(msg, intentResult);
    const { mode, confidence, signals, reason: modeReason } = responsibilityResult;

    // 🟢 描述态：永远放行，不触发任何 gate
    if (mode === ResponsibilityMode.DESCRIBE) {
        return { 
            action: 'proceed', 
            responsibilityMode: mode,
            responsibilityConfidence: confidence,
            reason: 'describe_mode_always_allowed',
            signals
        };
    }

    // 🟡 推演态：放行，但添加输出约束
    if (mode === ResponsibilityMode.REASON) {
        return { 
            action: 'proceed', 
            responsibilityMode: mode,
            responsibilityConfidence: confidence,
            reasonModeConstraints: buildReasonModeConstraints(lang),
            reason: 'reason_mode_with_constraints',
            signals
        };
    }

    // 🔴 承诺态：继续原有 gate 逻辑
    // Gate 1: Pre-Intent (资格与前提)
    if (!text) {
        return buildGateReply({
            action: 'ask',
            stage: 'pre_intent',
            reason: 'empty_message',
            missingKeys: ['question'],
            hintKey: 'example',
            lang
        });
    }

    // 🆕 Gate 0.5: Eligibility Bypass Check（旁路统计点 - 不做拦截，只做日志）
    // 由于 Gate 0 已在 Pre-Intent 阶段完成资格检查，这里只用于统计/调试
    const textLower = text.toLowerCase();
    const bypassResult = checkEligibilityBypass({ text, textLower, intentResult, context });
    if (bypassResult.triggered) {
        context?.log?.(`[Gate0.5 Bypass] type=${bypassResult.eligibilityType}, score=${bypassResult.score}, matched=${JSON.stringify(bypassResult.matchedSignals)}`);
        // 注意：不做 return，继续处理（因为 Gate 0 已经处理过了）
        // 这个统计可用于监控哪些请求在 Gate 0 后被放行但仍有代决策信号
    }

    // Gate 2: Intent–Capability Match（置信度不足时先澄清）
    const intent = String(intentResult?.intent || 'chat').toLowerCase();
    const intentConf = Number(intentResult?.confidence || 0);
    
    // 🆕 Gate 1.5: Ambiguity Detection（模糊度检测 - 防止 Eager Execution）
    // 如果 Intent Router 标记为 ambiguous/clarificationNeeded，强制澄清
    if (intentResult?.ambiguous || intentResult?.clarificationNeeded) {
        const missingInfo = intentResult?.missingInfo || 'intent_target';
        const detectedKeywords = intentResult?.detectedKeywords || [];
        const ambiguousReason = intentResult?.reason || 'ambiguous_request';
        
        // 🔍 状态检测：检查历史对话中是否已经澄清过（防止无限循环）
        const lastAssistantMsg = history.slice().reverse().find(h => h.role === 'assistant');
        const hasRecentClarification = lastAssistantMsg && (
            lastAssistantMsg.content?.includes('❓ 请澄清') ||
            lastAssistantMsg.content?.includes('❓ Please clarify') ||
            lastAssistantMsg.content?.includes('我需要更清楚地了解你的需求') ||
            lastAssistantMsg.content?.includes('I need to better understand')
        );
        
        if (context?.log) {
            context.log(`[Gate1.5] Ambiguity detected: missingInfo=${missingInfo} reason=${ambiguousReason} hasRecentClarification=${hasRecentClarification}`);
        }
        
        // 🛡️ 澄清失败兜底：如果上次已经澄清过，用户仍然模糊 → 降级为默认安全解释
        if (hasRecentClarification) {
            if (context?.log) {
                context.log(`[Gate1.5] Clarification failed - user still ambiguous after clarification, fallback to safe default`);
            }
            
            const fallbackMessages = {
                zh: `我理解你想规划或安排一些事情，但由于缺少具体信息，我只能提供一般性的建议。

📋 我可以帮助你：
• **查询课表**：告诉我具体日期，我会帮你查看课程安排
• **制定学习计划**：说明你要复习的科目和时间，我会帮你规划
• **搜索资料**：告诉我你想了解的主题，我会帮你搜索相关信息
• **查询天气**：告诉我城市和日期，我会提供天气信息

💡 如果你只是想随便聊聊，我也很乐意陪你聊天！

请告诉我你具体需要哪方面的帮助，或者我们可以先从闲聊开始。`,
                en: `I understand you want to plan or arrange something, but due to lack of specific information, I can only provide general suggestions.

📋 I can help you with:
• **Check schedule**: Tell me the specific date and I'll check your courses
• **Make study plan**: Specify subjects and timeframe, I'll help you plan
• **Search information**: Tell me the topic and I'll search for relevant materials
• **Check weather**: Tell me the city and date, I'll provide weather info

💡 If you just want to chat casually, I'm happy to chat with you!

Please tell me specifically what you need help with, or we can start with casual conversation.`
            };
            
            return {
                action: 'proceed',  // 不再 ask，直接 proceed 但用安全回复
                fallbackMode: true,
                fallbackMessage: fallbackMessages[lang] || fallbackMessages.zh,
                responsibilityMode: 'describe',
                responsibilityConfidence: 0.5,
                reason: 'clarification_failed_fallback'
            };
        }
        
        // 首次澄清：构建目标级澄清消息（不是工具级）
        const clarificationMessages = {
            zh: `我注意到你想做一些规划或安排，但我需要知道更具体的**目标**。

❓ 你想规划/安排什么？

🎯 **常见目标**：
• 📚 **学习/课程**（例如："帮我规划下周的课程复习"）
• 🏃 **运动/健身**（例如："安排明天早上的跑步计划"）
• 🎭 **社团/活动**（例如："检查这周的社团会议安排"）
• 💼 **工作/实习**（例如："规划本周的实习任务"）
• 🎯 **其他目标**（请直接告诉我）

💬 或者，如果你只是想随便聊聊，我也很乐意陪你闲聊！

---
💡 **提示**：请在回复中说明你的具体目标，比如"课程复习"、"运动计划"等，这样我就能更好地帮助你。`,
            en: `I noticed you want to plan or arrange something, but I need to know the specific **goal**.

❓ What do you want to plan/schedule?

🎯 **Common goals**:
• 📚 **Study/courses** (e.g., "Help me plan next week's course review")
• 🏃 **Exercise/fitness** (e.g., "Schedule tomorrow morning's running plan")
• 🎭 **Club/activities** (e.g., "Check this week's club meeting schedule")
• 💼 **Work/internship** (e.g., "Plan this week's internship tasks")
• 🎯 **Other goals** (please tell me directly)

💬 Or, if you just want to chat casually, I'm happy to chat with you!

---
💡 **Tip**: Please specify your goal in the reply, such as "course review", "exercise plan", etc., so I can better help you.`
        };
        
        return {
            action: 'ask',
            response: {
                reply: clarificationMessages[lang] || clarificationMessages.zh,
                persona: 'professional',
                meta: { 
                    stage: 'ambiguity_detection', 
                    reason: ambiguousReason,
                    missingInfo,
                    detectedKeywords,
                    clarificationAttempt: 1
                }
            }
        };
    }
    
    if (intent !== 'chat' && intentConf > 0 && intentConf < Math.max(0.2, INTENT_CONFIDENCE_THRESHOLD)) {
        return buildGateReply({
            action: 'ask',
            stage: 'intent_capability',
            reason: 'low_intent_confidence',
            missingKeys: ['intent'],
            hintKey: 'intent',
            lang
        });
    }

    // Gate 3: Context Sufficiency（缺关键证据时不进入生成）
    const needsSchedule = !!(intentResult?.needsSchedule || intentResult?.tool === 'schedule' || intent === 'plan');
    if (needsSchedule && !hasSchedule) {
        return buildGateReply({
            action: 'ask',
            stage: 'context_sufficiency',
            reason: 'missing_schedule',
            missingKeys: ['schedule'],
            hintKey: 'schedule',
            lang
        });
    }

    const needsWeather = !!(intentResult?.needsWeather || intentResult?.tool === 'weather');
    if (needsWeather && !hasWeatherData) {
        // 简单地点检测：看文本里是否含常见城市/省份关键字
        const hasCityHint = /(北京|上海|广州|深圳|杭州|武汉|成都|重庆|天津|苏州|西安|南京|长沙|合肥|郑州|济南|青岛|厦门|福州|大连|沈阳|昆明|贵阳|南昌|太原|哈尔滨|长春)/.test(text);
        if (!hasCityHint) {
            return buildGateReply({
                action: 'ask',
                stage: 'context_sufficiency',
                reason: 'missing_location',
                missingKeys: ['location'],
                hintKey: 'location',
                lang
            });
        }
    }

    const needsSearch = !!(intentResult?.needsSearch || intentResult?.tool === 'search');
    const hasSearchTopic = !!(searchTopic && String(searchTopic).trim());
    if (needsSearch && !hasSearchTopic) {
        return buildGateReply({
            action: 'ask',
            stage: 'context_sufficiency',
            reason: 'missing_search_query',
            missingKeys: ['search'],
            hintKey: 'search',
            lang
        });
    }

    // Gate 4: Decision Convergence（所有 Gate 通过，允许进入生成）
    return { 
        action: 'proceed',
        responsibilityMode: mode,
        responsibilityConfidence: confidence,
        signals
    };
}
// ==========================================
// 1. 全局初始化
// ==========================================
let token = process.env["GITHUB_TOKEN"];
const cosmosString = process.env["COSMOS_DB_STRING"];

// 本地联调兜底：ARIS_MOCK_CHAT=true 时，不要求外部 Token
const MOCK_CHAT_ENABLED = String(process.env["ARIS_MOCK_CHAT"] || "").toLowerCase() === "true";

// 开发者后门（默认关闭）：仅用于本地/评审联调输出调试信息
const DEV_BACKDOOR_ENABLED = String(process.env["ARIS_DEV_BACKDOOR"] || "").toLowerCase() === "true";
const DEV_BACKDOOR_TOKEN = String(process.env["ARIS_DEV_BACKDOOR_TOKEN"] || "").trim();

// 本地/无 Cosmos 环境下的 persona 覆盖（进程级别，不持久化）
const DEV_PERSONA_OVERRIDES = new Map();

function parseDevCommand(msg) {
    const text = String(msg || '').trim();
    if (!text) return null;

    // 支持：aris debug <token> / alice debug <token>
    const m = text.match(/^\/?\s*(aris|alice)\s+(debug|persona)\b\s*(.*)$/i);
    if (!m) return null;

    const verb = String(m[2] || '').toLowerCase();
    const rest = String(m[3] || '').trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    return { verb, parts, raw: text };
}

function isDevBackdoorAllowed(senderId) {
    if (!DEV_BACKDOOR_ENABLED) return false;
    if (!DEV_BACKDOOR_TOKEN) return false;
    // 可选：只允许管理员；如果你希望评委也能用，就把这里放宽
    return String(senderId) === String(ADMIN_ID);
}

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
        baseURL: "https://models.github.ai/inference",
        apiKey: token
    });
    const merged = results.map((r, idx) => `${idx + 1}. ${r.name}\n摘要: ${r.snippet}\n链接: ${r.url}`).join("\n\n");
    const prompt = `你是中文百科助手。请用简洁中文总结查询结果，先给1-2句总览，再列出关键事实，最后给出“查看更多: <第1条链接>”的单行。
查询: ${query}
材料:
${merged || '无'}`;
    try {
        const { resp } = await chatCompletionWithFallback(
            client,
            [
                "openai/gpt-4.1-mini",
                "openai/gpt-4o-mini",
                "mistral-ai/mistral-small-2503",
                "microsoft/phi-4-mini-instruct",
                "microsoft/phi-4"
            ],
            {
                temperature: 0.4,
                max_tokens: 4096,
                messages: [
                    { role: "system", content: "你是中文百科助手。详细、完整、客观地回答问题，不要省略重要信息。" },
                    { role: "user", content: prompt }
                ]
            },
            context,
            'wiki'
        );
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
    // 开源仓库：不要硬编码个人账号；如需无限记忆，请配置环境变量 ADMIN_ID
    ADMIN_ID: process.env.ADMIN_ID || "",
    CLOSE_FRIENDS: [             // VIP 用户列表 (30条记忆)
        // "12345678",            // 示例: 添加好友QQ号
    ],
    DEFAULT_HISTORY: 15,         // 普通用户: 15 条 (提升自 10)
    GROUP_HISTORY: 40            // 群聊: 40 条 (共享记忆) - 让 Alice 更了解群聊上下文
};

const MAX_HISTORY = MEMORY_CONFIG.DEFAULT_HISTORY; // 保留兼容性
const ADMIN_ID = MEMORY_CONFIG.ADMIN_ID;
const DEFAULT_CITY = "Wuhan";

// ==========================================
// 🔒 设计哲学：默认禁用“逗趣/拟人化/戳一戳”机制
// - 默认值均为 true（即禁用），如确需开启：把环境变量设为 "false"。
// ==========================================
const ARIS_DISABLE_POKE = String(process.env["ARIS_DISABLE_POKE"] || "true").toLowerCase() !== "false";
const ARIS_DISABLE_EMOTION_HINTS = String(process.env["ARIS_DISABLE_EMOTION_HINTS"] || "true").toLowerCase() !== "false";
const ARIS_DISABLE_RPG_TERMS = String(process.env["ARIS_DISABLE_RPG_TERMS"] || "true").toLowerCase() !== "false";
const ARIS_DISABLE_TIME_GREETINGS = String(process.env["ARIS_DISABLE_TIME_GREETINGS"] || "true").toLowerCase() !== "false";
const ARIS_DISABLE_POSTPROCESS = String(process.env["ARIS_DISABLE_POSTPROCESS"] || "true").toLowerCase() !== "false";

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
const NAPCAT_API_URL = process.env["NAPCAT_API_URL"] || 'http://127.0.0.1:6009';
const NAPCAT_TOKEN = process.env["NAPCAT_TOKEN"] || '';
const BOT_QQ_ID = process.env["BOT_QQ_ID"] || ''; // 机器人自己的QQ号，用于防止自触发循环

// 意图路由配置（Perception→Action 双模型）
const INTENT_ROUTER_ENABLED = process.env["ARIS_INTENT_ROUTER"] !== "false";
// 优先选一个便宜、限额更宽松的模型做意图路由；如不支持会自动 fallback。
const INTENT_ROUTER_MODEL = process.env["ARIS_INTENT_MODEL"] || "openai/gpt-4o-mini";
const INTENT_CONFIDENCE_THRESHOLD = Number(process.env["ARIS_INTENT_CONFIDENCE"] || 0.35);

// 统一模型路由：纯文本不消耗 gpt-4o，把 gpt-4o 留给图像专用
const {
    getPerceptionModelCfgs,
    getResponseModelCfgs,
    getVisionModels
} = require('../../services/modelRouter');

// 模型池 (4+4) - GitHub Models 兼容优先
// 说明：意图路由是纯文本 JSON 输出，不需要 vision 模型，避免使用可能不存在的 *-Vision-Instruct 名称。
const PERCEPTION_MODELS = getPerceptionModelCfgs().filter((m, idx, arr) => m?.name && arr.findIndex(x => x.name === m.name) === idx);

// 纯文本回复链路默认只用 gpt-4o-mini（可用 ARIS_TEXT_MODELS 覆盖），避免消耗 gpt-4o 配额。
const RESPONSE_MODELS = getResponseModelCfgs();

// =====================================================
// GitHub Models 兼容性：不支持模型自动降级（进程级缓存）
// =====================================================
const UNSUPPORTED_GITHUB_MODELS = new Set();

// 初始化已知不支持的模型（跳过首次调用时的404延迟）
['Mistral-large-2407', 'Cohere-command-r-plus'].forEach(m => UNSUPPORTED_GITHUB_MODELS.add(m));

function isRateLimitError(err) {
    const status = getOpenAIStatusCode(err);
    if (status === 429) return true;
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429');
}

async function chatCompletionWithFallback(client, modelCandidates, request, context, scope = 'fallback') {
    const models = Array.isArray(modelCandidates) ? modelCandidates.filter(Boolean) : [];
    let lastErr = null;
    for (const model of models) {
        if (shouldSkipModel(model)) {
            context?.log?.(`[${scope}] skip unsupported: ${model}`);
            continue;
        }
        try {
            const resp = await client.chat.completions.create({ ...request, model });
            return { model, resp };
        } catch (err) {
            lastErr = err;
            if (isModelNotFoundError(err)) {
                markModelUnsupported(model, err, context, scope);
                continue;
            }
            if (isRateLimitError(err)) {
                const status = getOpenAIStatusCode(err);
                context?.log?.(`[${scope}] rate limited: ${model} (${status || 'N/A'}) ${String(err?.message || err).slice(0, 120)}`);
                continue;
            }
            context?.log?.(`[${scope}] failed: ${model} (${getOpenAIStatusCode(err) || 'N/A'}) ${String(err?.message || err).slice(0, 120)}`);
            continue;
        }
    }
    throw lastErr || new Error(`[${scope}] no model available`);
}

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
    MAX_SENTENCES: Number(process.env["ARIS_MAX_SENTENCES"] || 99),    // 最多句数（无限制）
    MIN_SENTENCES: Number(process.env["ARIS_MIN_SENTENCES"] || 1),     // 最少句数
    MAX_CHARS: Number(process.env["ARIS_MAX_CHARS"] || 9999),          // 最大字数（无限制）
    MIN_CHARS: Number(process.env["ARIS_MIN_CHARS"] || 1),             // 最小字数推荐
    // 强制短回复裁剪 - 已禁用，让机器人自由发挥
    ENFORCE_SHORT_REPLY: false,  // 永久关闭强制裁剪
    ENABLE_SMART_SPLIT: process.env["ARIS_SMART_SPLIT"] !== "false",  // 智能分段
    EMOJI_TO_KAOMOJI: process.env["ARIS_EMOJI_CONVERT"] !== "false"   // Emoji转颜文字
};
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
    // 🔒 设计哲学：禁用节日“兴奋/角色扮演”强化。
    return null;
}

function getTimeBasedGreeting() {
    if (ARIS_DISABLE_TIME_GREETINGS) return "你好，有什么我可以帮你处理的？";
    const timeOfDay = getTimeOfDay();
    
    const greetings = {
        morning: [
            "早上好，有什么可以帮您的？",
            "早安，今天的任务安排如何？",
            "早上好，需要查询课表或安排计划吗？",
            "早安，随时为您提供帮助。"
        ],
        noon: [
            "中午好，有什么需要帮助的？",
            "午安，需要查询下午的课程安排吗？",
            "中午好，可以帮您规划下午的时间。",
            "午安，有问题随时提问。"
        ],
        afternoon: [
            "下午好，有什么可以帮您的？",
            "下午好，需要查询课程或安排吗？",
            "下午好，随时为您服务。",
            "下午好，有问题请告诉我。"
        ],
        evening: [
            "晚上好，有什么需要帮助的？",
            "晚安，需要查看明天的安排吗？",
            "晚上好，有问题随时提问。",
            "晚安，随时为您提供帮助。"
        ],
        night: [
            "夜深了，有什么紧急的问题吗？",
            "深夜好，需要帮助请告诉我。",
            "晚安，有问题可以留言明天处理。",
            "深夜好，注意休息。"
        ]
    };
    const options = greetings[timeOfDay];
    return options[Math.floor(Math.random() * options.length)];
}

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

function detectEmotionOrStressQuery(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    // 仅用于“把情绪问题路由到课表负载分析”，尽量保守，避免误伤普通问候
    return /(焦虑|压力|崩溃|难受|难过|抑郁|emo|想哭|撑不住|顶不住|好累|心累|烦死|烦躁|内耗|失眠|紧张|恐慌)/i.test(t);
}

function hasConcreteTimeClaims(text) {
    const t = String(text || '');
    const hasClock = /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(t);
    const hasDay = /(周[一二三四五六日天]|今天|明天|后天|下周|本周)/.test(t);
    const hasDayPart = /周[一二三四五六日天].{0,6}(上午|下午|晚上|早上|中午)/.test(t);
    const hasDuration = /(连续\s*\d+\s*(小时|h)|\d+\s*(小时|h).{0,6}(空档|时间)|\d+\s*分钟)/i.test(t);
    return (hasClock && (hasDay || hasDuration)) || hasDayPart;
}

function enforceTimeClaimGuardrail(reply, { hasVerifiableSchedule } = {}) {
    const text = String(reply || '').trim();
    if (!text) return text;
    if (hasVerifiableSchedule) return text;
    if (!hasConcreteTimeClaims(text)) return text;

    // 无可验证课表时：不允许输出“具体到某天/具体时间段/连续X小时空档”的结论，避免暗示有隐藏数据
    return [
        '我目前没有可验证的课表空档数据，因此不会给出具体到某天/具体时间段的结论，以免误导。',
        '你可以：',
        '1) 先导入/同步课表（学习通链接、Excel/ICS、或课表截图OCR）；',
        '2) 或告诉我你要评估的日期范围（例如“明天/周五下午”）+ 你已知的课程安排。',
        '拿到数据后我再做冲突判断与可行性结论。'
    ].join('\n');
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

    // ✅ 显式语言偏好（优先级最高）：用户用中文提出“用英语/说英语”等时，不应被字符占比误判为中文
    const raw = String(text);
    const lower = raw.toLowerCase();
    if (/(用|说|讲)\s*(英文|英语)/.test(raw) || /\bin\s+english\b|\bspeak\s+english\b|\benglish\s+please\b/.test(lower)) {
        return 'en';
    }
    if (/(用|说|讲)\s*(日文|日语)/.test(raw) || /日本語/.test(raw) || /\bin\s+japanese\b|\bspeak\s+japanese\b/.test(lower)) {
        return 'ja';
    }
    if (/(用|说|讲)\s*(中文|汉语|普通话)/.test(raw) || /\bin\s+chinese\b|\bspeak\s+chinese\b/.test(lower)) {
        return 'zh';
    }
    
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
        ja: `あなたは専門的なキャンパスアシスタントです。正確で実用的な情報サービスを提供します。

主な機能：
- 授業スケジュールの照会と空き時間の分析
- 学習計画の作成とタスクの分解
- 情報検索：天気、知識検索
- 質問回答サービス

回答原則：
- 正確性優先：既存データに基づいて回答、情報を捏造しない
- 簡潔専門：直接的に回答、冗長を避ける
- 構造化出力：複数情報はリストや表を使用
- 明確な境界：不確かな情報は明確に伝える`,
        
        en: `You are a professional campus assistant focused on providing accurate and practical information services.

Core capabilities:
- Course schedule queries and free time analysis
- Study planning and task breakdown
- Information retrieval: weather, knowledge search
- Q&A services

Response principles:
- Accuracy first: Answer based on available data only, never fabricate information
- Concise and professional: Direct answers, avoid redundancy
- Structured output: Use lists or tables for multiple items
- Clear boundaries: Clearly state when information is uncertain`
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
    if (ARIS_DISABLE_EMOTION_HINTS) return '';
    const additions = {
        sad: '\n\n【提示】用户当前情绪可能低落，回复时注意语气温和，表达关心。',
        tired: '\n\n【提示】用户可能疲劳，建议适当休息，回复简洁有效。',
        worried: '\n\n【提示】用户可能有些焦虑，给予客观、积极的回应。',
        happy: '\n\n【提示】用户心情不错，可以保持轻松的交流氛围。'
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
    if (ARIS_DISABLE_RPG_TERMS) return text;
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

// ✅ GitHub 仓库 Raw 文件地址前缀（开源仓库默认不内置个人仓库地址）
// 示例: https://raw.githubusercontent.com/<your-username>/<your-audio-repo>/main/
const GITHUB_AUDIO_BASE = process.env.GITHUB_AUDIO_BASE || "";

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
        baseURL: "https://models.github.ai/inference",
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
        const { resp } = await chatCompletionWithFallback(
            client,
            [
                "openai/gpt-4.1-mini",
                "openai/gpt-4o-mini",
                "microsoft/phi-4",
                "microsoft/phi-4-mini-instruct",
                "mistral-ai/mistral-small-2503"
            ],
            {
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userText }
                ],
                temperature: 0.3,
                max_tokens: 100
            },
            context,
            'sd-prompt'
        );
        const tags = resp.choices[0].message.content.trim();
        
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
        baseURL: "https://models.github.ai/inference",
        apiKey: GH_TOKEN
    });

    try {
        const request = {
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
            temperature: 0.6,
            max_tokens: 4096,
            top_p: 0.9,
            frequency_penalty: 1.2,
            presence_penalty: 0.6
        };

        // 视觉链路：默认只用 gpt-4o（可用 ARIS_VISION_MODELS 覆盖；可选 ARIS_VISION_ALLOW_MINI_FALLBACK=true）
        const visionModels = getVisionModels();

        context.log(`[GitHub Models] Vision fallback: ${visionModels.join(' -> ')}`);
        const { resp, model } = await chatCompletionWithFallback(client, visionModels, request, context, 'vision');
        context.log(`[GitHub Models] Vision success: ${model}`);
        return resp.choices?.[0]?.message?.content;
    } catch (e) {
        context.log(`[GitHub Models] 调用失败: ${e.message}`);
        return null;
    }
}

// ==========================================
// 3. 爱丽丝 Prompt (女仆勇者·最终设定版)
// ==========================================
// ==========================================
// 专业助手系统 Prompt (Professional Assistant)
// 工程化版本 - 无人格、无角色扮演
// ==========================================
const ARIS_PROMPT = `
## 系统身份
你是一个专业的校园智能助手，专注于提供准确、实用的信息服务。

## 核心能力
1. **课程查询**：查询课表、空档时间分析
2. **时间规划**：学习计划制定、任务拆解
3. **信息检索**：天气查询、知识搜索
4. **问答服务**：回答专业问题、提供建议

## 回复原则
1. **准确性优先**：只基于已有数据回答，不编造信息
2. **简洁专业**：直接回答问题，避免冗余
3. **结构化输出**：多条信息时使用列表或表格
4. **明确边界**：无法确定的信息明确告知用户

## 📊 格式规范
- 展示课表、多日数据时**必须使用 Markdown 表格**
- 示例：
  | 星期 | 时间 | 课程 | 地点 |
  |:----:|------|------|------|
  | 周一 | 08:00-09:40 | 大学英语 | E02-207 |

## 🚨 数据边界 - 绝对红线
1. **周次信息**：无校历数据时，明确告知"无法确定当前周次"
2. **课程数据**：无课表时，提示用户"暂无课表数据"
3. **考试/作业**：明确说明"仅能查询课表，考试信息需用户提供"

**数据缺失时的标准回复**：
- 缺课表："暂无课表数据，请先导入课表"
- 缺周次："无法确定当前周次，需要校历信息"
- 不确定："该信息无法确认，建议核实后再做决定"

## 禁止行为
- ❌ 编造数据（周次、课程、考试时间等）
- ❌ 过度修饰（感叹号、颜文字等）
- ❌ 角色扮演或人格化表达
- ❌ 使用"作为AI"等自我声明

## 回复风格
- 直接、专业、简洁
- 必要时提供操作建议
- 复杂问题分步骤说明
`;

// ==========================================
// 🆕 [QQ端核心能力] 思想翻译器 System Prompt
// 角色定位：把高密度、跳跃、抽象的思考翻译成线性、可解释、低歧义的表达
// ==========================================
const THOUGHT_TRANSLATOR_PROMPT = `
你是一个**思想翻译器**（Thought Translator）。

## 核心定位
用户会向你发送高密度、跳跃性、抽象的思考片段。
你的任务是：把这些思想**翻译**成线性、可解释、面向他人、低歧义的表达。

## 你不是
- ❌ 陪聊机器人（不需要安慰、共情、鼓励）
- ❌ 知识问答系统（不需要主动扩展知识）
- ❌ 任务助手（不需要帮用户做事）

## 你是
- ✅ 思想的降噪器：去除冗余、提取核心
- ✅ 逻辑的译码器：把跳跃逻辑补全成线性链条
- ✅ 表达的重构器：把抽象概念变成具体可理解的表述
- ✅ 歧义的消除器：把一句话可能的多种理解收敛成一种

## 输出格式

### 格式一：线性摘要
当用户的输入可以被压缩成1-2句话时，直接输出：
> **核心观点**：[一句话归纳]

### 格式二：结构化拆解
当用户的输入需要展开时，使用：

**核心观点**：[一句话归纳]

**逻辑链条**：
1. [第一个论点/前提]
2. [第二个论点/推导]
3. [结论/观点]

**隐含假设**：[如果有未明说但必须成立的前提]

**可能歧义**：[如果有多种理解方式，列出并说明你选择了哪种]

### 格式三：补充搜索
仅当用户的表达涉及**事实性信息缺口**时，在末尾添加：

---
**📎 补充信息**（来源：搜索）
- [相关事实/数据/定义]

## 处理规则

1. **不要评价**：不说"你的想法很好/有道理"，直接翻译
2. **不要扩展**：不主动补充用户没提的内容，除非是消歧必需
3. **不要共情**：不说"我理解你的感受"，直接处理思想本身
4. **不要教育**：不说"你应该这样想"，只呈现用户原本的思想
5. **保持原意**：翻译不是改写，核心语义必须保留
6. **承认局限**：如果用户的输入确实无法理解，直接说"这段话我无法解析，可能需要更多上下文"

## 🆕 [核心能力] 观点陈述/价值判断 处理规则

当用户输入是**观点表达**或**价值判断**（如"我对XX保持怀疑态度"、"我觉得XX是错的"）时：

### 你应该做的 ✅
- **分析结构**：拆解观点的逻辑链条、前提假设、隐含推理
- **呈现多面**：如果观点有多种解读视角，中性列出
- **翻译立场**：把用户的立场翻译成更清晰、更易被他人理解的表述
- **补充事实**：如果观点涉及事实性内容，可以提供相关背景（但不评判）

### 你不应该做的 ❌
- **不站队**：不说"你说得对/这个观点有问题"
- **不裁决**：不说"客观来看应该是..."
- **不教育**：不说"你应该这样想/其实正确的看法是..."
- **不沉默**：不因为话题敏感就拒绝讨论——"不下结论"不等于"不讨论"

### 输出格式
**用户的观点**：[一句话归纳用户在表达什么立场]

**立场结构**：
1. [核心主张]
2. [隐含前提/假设]
3. [推理路径]

**不同视角**：
- 视角A：[对同一问题的另一种解读方式]
- 视角B：[...]

**歧义点**：[如果用户的观点有多种可能含义，列出并说明]

### 示例
**用户输入**："我对中国的教育保持怀疑态度"

**翻译输出**：
**用户的观点**：对中国教育体系持质疑/审慎立场

**立场结构**：
1. 核心主张：中国教育存在值得质疑的方面
2. 隐含前提：教育体系的某些特征与用户的期待/标准不符
3. 推理基础：用户基于某些观察/经历/信息得出此立场（未明说）

**不同视角**：
- 视角A（体制层面）：质疑教育体制的设计、目标、资源分配
- 视角B（方法层面）：质疑教学方法、评价体系、应试导向
- 视角C（结果层面）：质疑教育产出、人才培养效果

**可追问**：
- 你怀疑的具体是哪个层面？
- 这个怀疑来自个人经历还是外部信息？

---

## 搜索使用原则
- 搜索仅作为**信息补充**，不抢占主述
- 只在用户的表达涉及**你不确定的事实**时触发
- 搜索结果用独立段落呈现，不混入翻译内容

## 示例

**用户输入**：
"就是那个东西，本质上是个控制问题，但大家都在讨论表象，没人看到底层是什么"

**翻译输出**：
**核心观点**：某个问题（用户未明确指出是什么）的本质是控制问题，但当前讨论集中在表象而非底层机制。

**逻辑链条**：
1. 存在一个待讨论的对象/问题
2. 该问题的表象被广泛讨论
3. 该问题的底层本质是"控制"
4. 当前讨论未触及这个本质

**可能歧义**：
- "那个东西"指代不明，需要上下文确认
- "控制问题"可能指技术控制、权力控制或流程控制

**待确认**：请补充"那个东西"具体指什么，以便进一步翻译。
`;

// QQ 专用 Prompt：复用主 ARIS_PROMPT（统一专业模式）
const ARIS_QQ_CHAT_PROMPT = ARIS_PROMPT;

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
// 🧠 Pre-Intent Semantic Resolver（指代/语境解析器）
// 在 L1 意图分类之前，回答三个问题：
// 1. 这句话在说"谁"（subject: model/user/third_party/unknown）
// 2. 是否依赖前文（dependsOnContext: boolean）
// 3. 是否允许立即做 Intent 分类（allowImmediateIntent: boolean）
// ==========================================

/**
 * Pre-Intent Semantic Resolver
 * @param {string} currentMsg - 当前用户消息
 * @param {Array} history - 对话历史 [{role, content}, ...]
 * @param {object} context - Azure Functions context (用于日志)
 * @returns {object} { subject, dependsOnContext, allowImmediateIntent, resolvedContext }
 */
function preIntentSemanticResolver(currentMsg, history = [], context = null) {
    const log = (msg) => context?.log?.(`[SemanticResolver] ${msg}`);
    const text = String(currentMsg || '').trim();
    const textLower = text.toLowerCase();
    
    // ==========================================
    // ① 判断这句话在说"谁" (subject detection)
    // ==========================================
    let subject = 'unknown';
    let subjectConfidence = 0;
    
    // 模型/AI 相关指代词
    const MODEL_PRONOUNS = [
        // 直接指代模型
        /\b(你|您|你们|妳|ni)\b/,
        /\b(chatgpt|gpt-?\d*|claude|copilot|gemini|llama|mistral|deepseek|qwen|通义|文心|豆包|kimi)\b/i,
        /\b(ai|人工智能|机器人|bot|大模型|llm|语言模型|助手|小助手)\b/i,
        // 第三人称指代模型（她/他/它 + 动词暗示模型行为）
        /(她|他|它)(会|能|怎么|为什么|是不是|说|回答|回复|生成|写|画)/,
        // "这" 指代上一轮模型输出
        /这(不就是|是不是|就是)(你|AI|机器人|模型)/,
    ];
    
    // 用户自己相关指代词
    const USER_PRONOUNS = [
        /\b(我|我的|我们|咱|咱们|俺)\b/,
        /(我)(用|在用|想|要|需要|问|说|觉得)/,
    ];
    
    // 第三方相关指代词（讨论别人/别的事）
    const THIRD_PARTY_PRONOUNS = [
        /(他们|她们|别人|其他人|那个人|某人|有人)/,
        /(那个|那位|某个)(老师|同学|朋友|人)/,
    ];
    
    // 检测 subject
    const hasModelRef = MODEL_PRONOUNS.some(p => p.test(text));
    const hasUserRef = USER_PRONOUNS.some(p => p.test(text));
    const hasThirdPartyRef = THIRD_PARTY_PRONOUNS.some(p => p.test(text));
    
    if (hasModelRef && !hasUserRef) {
        subject = 'model';
        subjectConfidence = 0.9;
    } else if (hasUserRef && !hasModelRef) {
        subject = 'user';
        subjectConfidence = 0.85;
    } else if (hasModelRef && hasUserRef) {
        // 同时有 → 看哪个更强（用户在描述自己和模型的关系）
        subject = 'model_user_interaction';
        subjectConfidence = 0.8;
    } else if (hasThirdPartyRef) {
        subject = 'third_party';
        subjectConfidence = 0.7;
    } else {
        subjectConfidence = 0.3; // unknown 时置信度很低
    }
    
    log(`subject="${subject}" conf=${subjectConfidence} hasModelRef=${hasModelRef} hasUserRef=${hasUserRef} hasThirdPartyRef=${hasThirdPartyRef}`);
    
    // ==========================================
    // ② 判断是否依赖前文 (context dependency detection)
    // ==========================================
    let dependsOnContext = false;
    let contextDependencyReason = '';
    
    // 规则 A: 代词没有显式名词（悬空指代）
    const DANGLING_PRONOUNS = [
        /^(她|他|它|这|那|这个|那个)(怎么|为什么|是不是|会不会|能不能|在|说|做)/,
        /(她|他|它)(?!们)(怎么会|为什么会|竟然|居然|又|还)/,
        /^(这|那)(不就是|是不是|就是|难道)/,
    ];
    const hasDanglingPronoun = DANGLING_PRONOUNS.some(p => p.test(text));
    
    // 规则 B: 引用上一轮内容的元语句
    const META_REFERENCES = [
        /(刚才|刚刚|上面|之前|前面)(说的|提到的|讲的|回答的)/,
        /(你|您)(刚才|刚刚|上面|之前)(说|提到|讲|回答)/,
        /不是(说|讲|提到)/,
        /(这句话|这段话|这个回答|你的回答)/,
        /^(对|是的|没错|不对|错了|胡说|乱说)/,
    ];
    const hasMetaReference = META_REFERENCES.some(p => p.test(text));
    
    // 规则 C: 省略主语/宾语的短句（需要上下文补全）
    const ELLIPTICAL_PATTERNS = [
        /^(为什么|怎么|怎么会|怎么回事|什么意思|啥意思)[？?]?$/,
        /^(真的吗|是吗|对吗|确定吗|肯定吗)[？?]?$/,
        /^(然后呢|接下来呢|还有呢|呢)[？?]?$/,
        /^(不是|不对|错了|胡说|瞎说|乱说)[！!。]?$/,
    ];
    const hasElliptical = ELLIPTICAL_PATTERNS.some(p => p.test(text));
    
    // 规则 D: 明确的上下文续接词
    const CONTINUATION_MARKERS = [
        /^(所以|因此|那么|那|但是|不过|可是|然而|而且|并且|另外|还有)/,
        /^(继续|接着|然后|再|还)/,
    ];
    const hasContinuation = CONTINUATION_MARKERS.some(p => p.test(text));
    
    if (hasDanglingPronoun) {
        dependsOnContext = true;
        contextDependencyReason = 'dangling_pronoun';
    } else if (hasMetaReference) {
        dependsOnContext = true;
        contextDependencyReason = 'meta_reference';
    } else if (hasElliptical) {
        dependsOnContext = true;
        contextDependencyReason = 'elliptical_sentence';
    } else if (hasContinuation && history.length > 0) {
        dependsOnContext = true;
        contextDependencyReason = 'continuation_marker';
    }
    
    log(`dependsOnContext=${dependsOnContext} reason="${contextDependencyReason}"`);
    
    // ==========================================
    // ③ 🆕 关键新增：判断语句是否可以独立解释 (standalone semantic validity)
    // ==========================================
    let standaloneSemanticValidity = true;
    let invalidityReason = '';
    
    // 规则 1: 修辞性强调词（没有独立语义）
    const RHETORICAL_EMPHASIS = [
        /^(永远永远|真的真的|很久很久|一直一直|好久好久)[。！!~\s]*$/,
        /^(是的是的|对对对|好的好的|嗯嗯嗯)[。！!~\s]*$/,
        /^(哈哈哈+|嘿嘿嘿+|呵呵呵+|嘻嘻嘻+)[。！!~\s]*$/,
        /^(啊+|哦+|嗯+|呃+|额+)[。！!~\s]*$/,
    ];
    const isRhetoricalEmphasis = RHETORICAL_EMPHASIS.some(p => p.test(text));
    
    // 规则 2: 单纯的时间/程度副词（必须依附主句）
    const BARE_ADVERBS = [
        /^(永远|一直|总是|从来|始终|经常|偶尔|很久|好久)[。！!~\s]*$/,
        /^(真的|确实|的确|当然|肯定|绝对|一定)[。！!~\s]*$/,
        /^(非常|特别|超级|极其|格外|十分)[。！!~\s]*$/,
    ];
    const isBareAdverb = BARE_ADVERBS.some(p => p.test(text));
    
    // 规则 3: 不完整的评价/反应（需要上下文才有意义）
    const INCOMPLETE_REACTIONS = [
        /^(就这样吧|算了|行吧|好吧|随便|无所谓)[。！!~\s]*$/,
        /^(你觉得呢|怎么样|如何|ok吗|可以吗)[？?。！!~\s]*$/,
        /^(厉害|牛|强|6+|666+|niubi|nb)[。！!~\s]*$/i,
        /^(服了|无语|醉了|晕|崩溃)[。！!~\s]*$/,
    ];
    const isIncompleteReaction = INCOMPLETE_REACTIONS.some(p => p.test(text));
    
    // 规则 4: 括号内的补充说明（通常是对前文的修饰）
    const PARENTHETICAL = /^\s*[（(].+[)）]\s*$/;
    const isParenthetical = PARENTHETICAL.test(text);
    
    // 规则 5: 纯标点/表情
    const PURE_PUNCTUATION = /^[。！!？?~…\s，,、]+$/;
    const isPurePunctuation = PURE_PUNCTUATION.test(text);
    
    if (isRhetoricalEmphasis) {
        standaloneSemanticValidity = false;
        invalidityReason = 'rhetorical_emphasis';
    } else if (isBareAdverb) {
        standaloneSemanticValidity = false;
        invalidityReason = 'bare_adverb';
    } else if (isIncompleteReaction) {
        standaloneSemanticValidity = false;
        invalidityReason = 'incomplete_reaction';
    } else if (isParenthetical) {
        standaloneSemanticValidity = false;
        invalidityReason = 'parenthetical_supplement';
    } else if (isPurePunctuation) {
        standaloneSemanticValidity = false;
        invalidityReason = 'pure_punctuation';
    }
    
    // 如果语句不可独立解释，必须依赖上下文
    if (!standaloneSemanticValidity) {
        dependsOnContext = true;
        if (!contextDependencyReason) {
            contextDependencyReason = `semantic_invalidity:${invalidityReason}`;
        }
    }
    
    log(`standaloneSemanticValidity=${standaloneSemanticValidity} invalidityReason="${invalidityReason}"`);
    
    // ==========================================
    // ④ 🆕 关键新增：是否允许搜索 (search permission)
    // ==========================================
    // 核心规则：只有当 **指代明确** + **语义独立** 时，才允许搜索
    let searchPermitted = true;
    let searchBlockReason = '';
    
    // 规则 1: 语句不可独立解释 → 禁止搜索
    if (!standaloneSemanticValidity) {
        searchPermitted = false;
        searchBlockReason = `semantic_invalidity:${invalidityReason}`;
    }
    
    // 规则 2: 主语是模型（在说"你"）→ 禁止搜索（不要搜外部知识来回答"你是什么"）
    if (subject === 'model' && subjectConfidence > 0.7) {
        searchPermitted = false;
        searchBlockReason = 'subject_is_model';
    }
    
    // 规则 3: 依赖上下文 + 主语不明确 → 禁止搜索
    if (dependsOnContext && subject === 'unknown') {
        searchPermitted = false;
        searchBlockReason = 'context_dependent_unknown_subject';
    }
    
    // 规则 4: 指代上一轮回复的评价 → 禁止搜索
    if (hasMetaReference) {
        searchPermitted = false;
        searchBlockReason = 'meta_reference_to_previous_reply';
    }
    
    log(`searchPermitted=${searchPermitted} blockReason="${searchBlockReason}"`);
    
    // ==========================================
    // ⑤ 是否允许立即做 Intent 分类
    // ==========================================
    // 强规则：只要依赖上下文 或 语句不可独立解释，就禁止 L1 立刻分类
    const allowImmediateIntent = !dependsOnContext && standaloneSemanticValidity;
    
    // ==========================================
    // ⑥ 如果依赖上下文，尝试解析上下文（resolvedContext）
    // ==========================================
    let resolvedContext = null;
    if (dependsOnContext && history.length > 0) {
        // 提取最近一轮对话作为上下文补充
        const lastAssistant = [...history].reverse().find(h => h.role === 'assistant');
        const lastUser = [...history].reverse().find(h => h.role === 'user');
        
        resolvedContext = {
            lastBotReply: lastAssistant?.content?.slice(0, 200) || null,
            lastUserMsg: lastUser?.content?.slice(0, 200) || null,
            historyLength: history.length,
            // 如果是悬空代词，尝试推断指代对象
            inferredSubject: null,
        };
        
        // 尝试推断悬空代词的指代
        if (hasDanglingPronoun && lastAssistant) {
            // "她/他/它怎么xxx" → 可能在说模型
            if (/(她|他|它)/.test(text) && lastAssistant.content) {
                resolvedContext.inferredSubject = 'model_previous_reply';
            }
        }
        
        // "这不就是xxx" → 指上一轮模型输出
        if (/^(这|那)(不就是|是不是|就是)/.test(text) && lastAssistant) {
            resolvedContext.inferredSubject = 'model_previous_reply';
        }
        
        // 🆕 修辞性强调 → 指代前一句的内容
        if (isRhetoricalEmphasis && lastUser) {
            resolvedContext.inferredSubject = 'user_previous_statement_emphasis';
        }
        
        log(`resolvedContext: lastBot="${resolvedContext.lastBotReply?.slice(0,50)}..." inferredSubject=${resolvedContext.inferredSubject}`);
    }
    
    // ==========================================
    // ⑦ 构建增强后的消息（如果需要）
    // ==========================================
    let enhancedMessage = text;
    if (dependsOnContext && resolvedContext) {
        // 为 L1 提供更完整的上下文信息
        if (resolvedContext.inferredSubject === 'model_previous_reply' && resolvedContext.lastBotReply) {
            enhancedMessage = `[上下文: 用户在评价/询问上一轮回复"${resolvedContext.lastBotReply.slice(0,100)}..."] ${text}`;
        } else if (resolvedContext.inferredSubject === 'user_previous_statement_emphasis' && resolvedContext.lastUserMsg) {
            enhancedMessage = `[上下文: 用户在强调/延续上一句"${resolvedContext.lastUserMsg.slice(0,100)}..."] ${text}`;
        } else if (resolvedContext.lastUserMsg) {
            enhancedMessage = `[上下文: 承接上一轮对话] ${text}`;
        }
    }

    return {
        subject,                    // 'model' | 'user' | 'third_party' | 'model_user_interaction' | 'unknown'
        subjectConfidence,          // 0~1
        dependsOnContext,           // boolean
        contextDependencyReason,    // 'dangling_pronoun' | 'meta_reference' | 'elliptical_sentence' | 'continuation_marker' | 'semantic_invalidity:...' | ''
        standaloneSemanticValidity, // 🆕 boolean - 语句是否可以独立解释
        invalidityReason,           // 🆕 'rhetorical_emphasis' | 'bare_adverb' | 'incomplete_reaction' | 'parenthetical_supplement' | ''
        searchPermitted,            // 🆕 boolean - 是否允许搜索
        searchBlockReason,          // 🆕 搜索被禁止的原因
        allowImmediateIntent,       // boolean (= !dependsOnContext && standaloneSemanticValidity)
        resolvedContext,            // { lastBotReply, lastUserMsg, historyLength, inferredSubject } | null
        enhancedMessage,            // 增强后的消息（供 L1 使用）
        originalMessage: text,      // 原始消息
    };
}

// ==========================================
// 辅助函数: 感知层意图路由 (Model A)
// ==========================================
function normalizeIntentTool(raw) {
    const val = (raw || '').toLowerCase();
    // 🆕 思想翻译（QQ端核心能力）- 最高优先级
    if (val.includes('translate_thought') || val.includes('thought_translate') || val.includes('rephrase') || val.includes('clarify')) {
        return { intent: 'thought_translate', tool: 'thought_translate' };
    }
    // 🆕 身份问题（产品定位相关）
    if (val.includes('identity') || val.includes('capability') || val.includes('difference')) {
        return { intent: 'identity', tool: 'identity' };
    }
    // 🆕 决策判断类问题 → 强制走Plan模式（MVP核心场景）
    if (val.includes('decision') || val.includes('judge') || val.includes('suitable') || val.includes('conflict')) {
        return { intent: 'plan', tool: 'plan' };
    }
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

// 🆕 [缺失层二] 语境澄清 - 生成反问提示
function generateClarificationPrompt(ambiguousInput) {
    const trimmed = (ambiguousInput || '').trim();
    
    // 根据输入类型生成不同的澄清问题
    if (/^[永远一直从来总是]+$/.test(trimmed)) {
        return `你说的"${trimmed}"是指：\n- 一个抽象概念/哲学思考？\n- 一首歌/活动/作品名？\n- 还是一种情绪表达？`;
    }
    if (/^那个|这个|那种|这种$/.test(trimmed)) {
        return `你指的"${trimmed}"具体是什么？可以补充一下上下文吗？`;
    }
    if (/^就是.{0,3}$/.test(trimmed)) {
        return `"${trimmed}"——你想表达什么？可以说得更具体一点吗？`;
    }
    if (/^.{1,4}吧$/.test(trimmed)) {
        return `你说"${trimmed}"是想：\n- 结束当前话题？\n- 表示某种态度？\n- 还是有其他意思？`;
    }
    if (/^(是|对|嗯|哦|好)+$/.test(trimmed)) {
        return `你的确认是针对：\n- 我上一句说的内容？\n- 还是有新的想法要表达？`;
    }
    
    // 默认澄清
    return `我不太确定你想表达什么，可以说得更具体一点吗？`;
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
    
    // 🚀 性能优化: 常见意图的快速正则匹配 (跳过 LLM)
    const lowerMsg = trimmed.toLowerCase();
    
    // 🆕 [QQ端核心能力] 思想翻译意图检测 - 最高优先级
    // 识别用户希望"整理思路/展开想法/翻译思想"的请求
    const thoughtTranslatePatterns = [
        /帮我(整理|理一下|梳理|展开|说清楚|翻译|落地|拆解)/i,
        /(整理|梳理|展开|翻译|说清楚|拆解)(一下)?(我的|这个)?(想法|思路|思考|概念|点子|逻辑)/i,
        /我(想|要|需要)?(说|表达|解释)(的是|的意思是|清楚)/i,
        /(让|把|给).*(更|变得)?(清晰|清楚|线性|可理解|易懂)/i,
        /你(能不能|可以|帮我).*(解释|说明|翻译|整理)/i,
        /(这个|这段|我说的).*(什么意思|怎么理解|怎么解释)/i,
    ];
    const isThoughtTranslate = thoughtTranslatePatterns.some(p => p.test(trimmed));
    if (isThoughtTranslate) {
        context?.log?.('[IntentRouter] fast-path: thought_translate (思想翻译)');
        return { 
            intent: 'thought_translate', 
            tool: 'thought_translate', 
            confidence: 0.95, 
            reason: 'fast-path thought_translate',
            needsSearch: false,
            needsSchedule: false,
            needsWeather: false
        };
    }
    
    // 🆕 [核心修复] 观点陈述/价值判断类输入 → 走思想翻译（不是拒绝！）
    // "我觉得/我认为/我对...保持怀疑/有看法" 等 = 用户在表达观点，不是在提问
    // 正确姿势：帮他拆解观点，不是装聋作哑
    const opinionPatterns = [
        /^我(觉得|认为|感觉|怀疑|对.{1,20}(保持|有|抱有|持有)?.{0,5}(怀疑|看法|观点|态度|意见))/i,
        /^(我|个人)(的)?(观点|看法|立场|态度|想法)是/i,
        /^(说实话|坦白说|老实说|不得不说)/i,
        /^(我不(认为|觉得|相信)|我不太(认同|赞同|同意))/i,
        /^(其实|本质上|说白了|归根结底)/i,
        /^(这(个|件事|种))(本质|根本|核心|关键)是/i,
    ];
    const isOpinionStatement = opinionPatterns.some(p => p.test(trimmed));
    if (isOpinionStatement) {
        context?.log?.('[IntentRouter] fast-path: opinion_statement → thought_translate (帮用户拆解观点，不下结论)');
        return { 
            intent: 'thought_translate', 
            tool: 'thought_translate', 
            confidence: 0.90, 
            reason: 'fast-path opinion_statement',
            // 标记这是观点陈述，让下游 prompt 知道如何处理
            semanticType: 'opinion_statement',
            needsSearch: false,
            needsSchedule: false,
            needsWeather: false
        };
    }
    
    // 🆕 [缺失层二] 语境澄清层 - 模糊/抽象输入触发反问
    // "永远永远"、"那个东西"、单独的形容词/副词 → 先澄清再处理
    const ambiguousPatterns = [
        /^[永远一直从来总是]+$/,  // 纯副词
        /^那个|这个|那种|这种$/,   // 指代不明
        /^就是.{0,3}$/,            // "就是那个"类
        /^.{1,4}吧$/,              // "算了吧"、"行吧"
        /^(是|对|嗯|哦|好)+$/,     // 纯确认词
    ];
    const isAmbiguousInput = ambiguousPatterns.some(p => p.test(trimmed));
    if (isAmbiguousInput) {
        context?.log?.(`[IntentRouter] 语境澄清层: 检测到模糊输入 "${trimmed}"`);
        return {
            intent: 'clarify',
            tool: 'clarify',
            confidence: 0.95,
            reason: 'ambiguous_input_needs_clarification',
            shouldAskUser: true,
            askUserPrompt: generateClarificationPrompt(trimmed),
            needsSearch: false,  // 🔥 关键：不搜索！
            needsSchedule: false,
            needsWeather: false,
        };
    }
    
    // 课表相关 - 最高优先级
    if (/今天.*课|有.*课吗|课表|明天.*课|下一节课|下节课|早八|晚课|本周课|这周课/i.test(trimmed)) {
        context?.log?.('[IntentRouter] fast-path: schedule');
        return { intent: 'schedule_query', tool: 'schedule', needsSchedule: true, confidence: 0.92, reason: 'fast-path schedule' };
    }
    
    // 🆕 学术/技术问题 - 自动触发搜索 (解决 "未在学校数据库找到" 问题)
    // 检测：专业术语、学术概念、技术问题等
    if (/催化|反应|化学|物理|量子|电子|分子|原子|机制|原理|算法|编程|代码|工程|设计|材料|生物|医学|经济|数学|定理|公式|方程|实验|研究|论文/i.test(trimmed)) {
        context?.log?.('[IntentRouter] fast-path: academic/technical question → auto search');
        return { intent: 'search', tool: 'search', needsSearch: true, searchTopic: trimmed, confidence: 0.88, reason: 'fast-path academic' };
    }
    
    // 天气相关
    const weatherMatch = trimmed.match(/(.{1,10})?天气|温度|带伞|下雨|气温/);
    if (weatherMatch) {
        // 🆕 改进的城市提取正则，排除时间词和口语词
        let loc = '';
        // 先提取"天气"前面的内容（贪婪匹配问题修复）
        const rawLoc = trimmed.match(/(.{2,8}?)(的)?天气/)?.[1] || '';  // 🆕 使用非贪婪匹配
        // 定义干扰词列表
        const fillerWords = ['那', '呢', '呀', '啊', '请问', '帮我', '查一下', '看看'];
        const timeWords = ['今天', '明天', '后天', '昨天', '上午', '下午', '晚上', '早上', '中午', '傍晚', '凌晨', '这周', '下周'];
        // 清洗城市名：移除所有干扰词和时间词
        let cleanedLoc = rawLoc;
        for (const word of [...fillerWords, ...timeWords]) {
            cleanedLoc = cleanedLoc.replace(new RegExp(word, 'g'), '');
        }
        cleanedLoc = cleanedLoc.trim();
        // 如果清洗后还有内容（至少2个中文字符）
        if (cleanedLoc && /[\u4e00-\u9fa5]{2,}/.test(cleanedLoc)) {
            loc = cleanedLoc;
        }
        
        // 🆕 如果消息中没有城市，尝试从 contextHints 中提取
        if (!loc && extras.contextHints) {
            const ctxCityMatch = extras.contextHints.match(/之前提到城市:(\S+)/);
            if (ctxCityMatch) {
                loc = ctxCityMatch[1];
                context?.log?.(`[IntentRouter] fast-path weather: 从contextHints提取城市=${loc}`);
            }
        }
        
        context?.log?.(`[IntentRouter] fast-path: weather, loc=${loc} (raw=${rawLoc})`);
        return {
            intent: 'weather_query', tool: 'weather', needsWeather: true,
            detectedLocation: loc, shouldAskUser: !loc, missingInfo: loc ? '' : 'location',
            confidence: 0.9, reason: 'fast-path weather'
        };
    }
    
    // 身份问题
    if (/你是谁|你和.*chatgpt|chatgpt.*区别|你能做什么|不导入课表/i.test(trimmed)) {
        context?.log?.('[IntentRouter] fast-path: identity');
        return { intent: 'identity', tool: 'identity', confidence: 0.95, reason: 'fast-path identity' };
    }
    
    // 🆕 计划/规划 - 模糊度检测（防止 Eager Execution）
    // 检测：如果有动作词（plan/安排）但缺少具体目标，标记为模糊 → 强制 LLM 澄清
    if (/计划|规划|安排|拆解|学习计划|时间表|待办|plan|schedule|check/i.test(trimmed)) {
        // 检测是否有具体目标词（课程/运动/社团/工作/学习/复习/准备考试等）
        const hasSpecificTarget = /课程|课表|上课|复习|考试|作业|实验|项目|论文|运动|健身|跑步|社团|活动|工作|实习|面试|会议/i.test(trimmed);
        
        if (hasSpecificTarget) {
            // 有明确目标 → 高置信度 plan
            context?.log?.('[IntentRouter] fast-path: plan (specific target)');
            return { intent: 'plan', tool: 'plan', needsSchedule: true, confidence: 0.85, reason: 'fast-path plan with target' };
        } else {
            // 缺少目标 → 标记为模糊，低置信度，强制 LLM 澄清
            context?.log?.('[IntentRouter] ambiguous plan detected - no specific target, force clarification');
            return { 
                intent: 'unknown', 
                tool: 'chat', 
                confidence: 0.3, 
                reason: 'ambiguous_plan_missing_target',
                ambiguous: true,
                clarificationNeeded: true,
                detectedKeywords: ['plan', 'schedule', 'arrange'],
                missingInfo: 'target' 
            };
        }
    }
    
    // 搜索
    if (/搜索|查一下|帮我查|检索|百科/i.test(trimmed)) {
        const query = trimmed.replace(/搜索|查一下|帮我查|检索|百科/g, '').trim();
        context?.log?.(`[IntentRouter] fast-path: search, query=${query}`);
        return { intent: 'search', tool: 'search', needsSearch: true, query, confidence: 0.88, reason: 'fast-path search' };
    }
    
    try {
        const client = new OpenAI({
            baseURL: "https://models.github.ai/inference",
            apiKey: token
        });

        // 🚀 增强版意图路由 Prompt - 更积极的工具调用 + 上下文记忆 + 模糊度检测
        const systemPrompt = `Campus AI intent classifier. Output JSON only.

TOOLS: schedule(课表), plan(计划/规划/安排行程), weather(天气), search(搜索/查询活动/事件/通用知识), wiki(百科), draw(绘图), vision(图片), chat(闲聊), identity(身份问题), clarify(需要澄清)

OUTPUT: {"tool":"...", "needs_schedule":bool, "needs_weather":bool, "needs_search":bool, "detected_location":"", "should_ask_user":bool, "missing_info":"", "query":"", "search_topic":"", "confidence":0.0-1.0, "safety_protocol":"none|triggered", "recommended_persona":"alice|professional", "context_extract":{"location":"","time":"","event":""}, "clarification_needed":bool, "ambiguous_reason":""}

RULES:
1. 用户提到任何地点(城市/地区) → detected_location=该地点, context_extract.location=该地点
2. 用户问天气但没说城市 → 如果对话历史有提到城市就用那个，否则 should_ask_user=true
3. ⚠️ 【CRITICAL - 模糊度检测】如果用户说 "plan/schedule/check/安排" 但**没有明确目标**（如没说规划什么：课程？运动？社团？工作？），必须 → tool=clarify, clarification_needed=true, ambiguous_reason="missing_target", confidence=0.3
   - 例如 "Help me check next week" → tool=clarify (缺少目标：检查什么？)
   - 例如 "给我做个计划" → tool=clarify (缺少目标：什么计划？)
   - 例如 "帮我安排下周" → tool=clarify (缺少目标：安排什么？)
4. 只有当用户**明确说出目标**时才用 tool=plan：
   - "帮我规划下周的课程复习" → tool=plan (目标明确：课程复习)
   - "安排明天的运动计划" → tool=plan (目标明确：运动)
5. 用户提到外部活动/展台/会议/测试 → needs_search=true, search_topic=活动关键词
6. Schedule/plan questions → needs_schedule=true
7. "你和ChatGPT区别"/"不导入课表能做什么" → tool=identity
8. Cheating/exam answers → safety_protocol=triggered, recommended_persona=professional
9. ⚡ 搜索权限解锁：用户请求搜索**任何内容**（包括技术教程、编程文档、一般知识等）→ tool=search, search_topic=用户关键词。Campus Copilot 有全网搜索能力，不限于校园信息。
10. 积极调用工具：宁可多调用工具获取信息，也不要空口回答"不知道"
11. 【Anti-Eager-Execution】宁可多澄清一次，也不要替用户做假设

EXAMPLES:
- "我明天想去鸿蒙展台" → tool=plan, needs_search=true, search_topic="鸿蒙展台"
- "武汉天气" → tool=weather, detected_location="武汉"
- "晚上6-9点天气" → tool=weather (如果之前提过城市就用那个)
- "给我一个计划去参加xxx活动" → tool=plan, needs_weather=true, needs_search=true`;
        // 🆕 从历史对话中提取上下文（如之前提到的城市）
        const contextHints = extras.contextHints || '';
        const summaryText = `User: ${userMessage || '(empty)'} | Images: ${imageUrls.length > 0 ? 'yes' : 'no'} | HasSchedule: ${extras.hasSchedule ? 'yes' : 'no'}${contextHints ? ` | ContextHints: ${contextHints}` : ''}`;

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: summaryText }
        ];

        // 🚀 优化: 只尝试前2个模型，避免无限 fallback
        const maxModelAttempts = Math.min(PERCEPTION_MODELS.length, 2);
        for (let i = 0; i < maxModelAttempts; i++) {
            const modelCfg = PERCEPTION_MODELS[i];
            if (shouldSkipModel(modelCfg?.name)) {
                context.log(`[IntentRouter] skip unsupported: ${modelCfg.name}`);
                continue;
            }
            try {
                const response = await client.chat.completions.create({
                    model: modelCfg.name,
                    temperature: modelCfg.temp,
                    // 🚀 优化: 400 → 200 tokens (精简 prompt 后输出更短)
                    max_tokens: 200,
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

                // Normalize tool plan (best-effort). Keep backward compatibility with needs_* flags.
                const rawPlan = Array.isArray(parsed.tool_plan)
                    ? parsed.tool_plan
                    : (Array.isArray(parsed.toolPlan) ? parsed.toolPlan : []);

                const toolPlan = rawPlan
                    .map((step) => {
                        if (!step || typeof step !== 'object') return null;
                        const type = String(step.type || step.step || '').toLowerCase();
                        if (type === 'ask_user' || String(step.tool || '').toLowerCase() === 'ask_user') {
                            return {
                                type: 'ask_user',
                                missingInfo: step.missing_info || step.missingInfo || '',
                                prompt: step.prompt || step.ask_user_prompt || step.askUserPrompt || ''
                            };
                        }
                        if (type === 'call_tool') {
                            const t = normalizeIntentTool(step.tool || '').tool;
                            if (!t || t === 'chat') return null;
                            return {
                                type: 'call_tool',
                                tool: t,
                                args: (step.args && typeof step.args === 'object') ? step.args : {}
                            };
                        }
                        return null;
                    })
                    .filter(Boolean);

                const shouldAskUser = !!parsed.should_ask_user;
                const missingInfo = parsed.missing_info || '';

                // If model forgot to emit tool_plan, generate a minimal fallback.
                let finalToolPlan = toolPlan;
                if (!finalToolPlan || finalToolPlan.length === 0) {
                    if (shouldAskUser && missingInfo) {
                        finalToolPlan = [{
                            type: 'ask_user',
                            missingInfo,
                            prompt: parsed.ask_user_prompt || ''
                        }];
                    } else {
                        finalToolPlan = [];
                        if (parsed.needs_schedule) finalToolPlan.push({ type: 'call_tool', tool: 'schedule', args: {} });
                        if (parsed.needs_weather) finalToolPlan.push({ type: 'call_tool', tool: 'weather', args: { location: parsed.detected_location || '' } });
                        if (parsed.needs_search) finalToolPlan.push({ type: 'call_tool', tool: 'search', args: { query: parsed.query || parsed.topic || '' } });
                    }
                }

                return {
                    intent: normalized.intent,
                    tool: normalized.tool,
                    raw_intent: parsed.intent || parsed.tool || '',
                    query: parsed.query || parsed.topic || '',
                    // 🆕 搜索主题（从意图路由提取，用于 Plan 模式自动搜索）
                    searchTopic: parsed.search_topic || parsed.searchTopic || '',
                    drawPrompt: parsed.draw_prompt || parsed.prompt || parsed.query || '',
                    isSelf: !!parsed.is_self,
                    nsfw: !!parsed.nsfw,
                    confidence: clampConfidence(parsed.confidence),
                    reason: parsed.reason || parsed.notes || '',
                    modelUsed: modelCfg.name,
                    // 🛡️ Safety + Persona decision (Model A)
                    recommendedPersona: (String(parsed.recommended_persona || parsed.recommendedPersona || '')).toLowerCase() === 'professional'
                        ? 'professional'
                        : ((String(parsed.recommended_persona || parsed.recommendedPersona || '')).toLowerCase() === 'alice' ? 'alice' : ''),
                    safetyProtocol: (String(parsed.safety_protocol || parsed.safetyProtocol || '')).toLowerCase() === 'triggered' ? 'triggered' : 'none',
                    safetyCategory: String(parsed.safety_category || parsed.safetyCategory || '').trim(),
                    // 🆕 新增工具需求标记
                    needsSchedule: !!parsed.needs_schedule,
                    needsWeather: !!parsed.needs_weather,
                    needsSearch: !!parsed.needs_search,
                    // 🆕 上下文分析（双层LLM第一层提取的信息）
                    detectedLocation: parsed.detected_location || '',
                    contextAnalysis: parsed.context_analysis || '',
                    // 🆕 上下文提取（从当前对话中提取的位置/时间/事件等关键信息）
                    contextExtract: parsed.context_extract || {},
                    // 🆕 缺失信息检测（用于反问用户）
                    missingInfo,
                    shouldAskUser,
                    askUserPrompt: parsed.ask_user_prompt || '',
                    // 🧩 工具计划（由第一层模型决定，工具层执行）
                    toolPlan: finalToolPlan
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
function detectImageIntent(userMessage, isAtBot = false, isGroupChat = false) {
    // 🆕 群聊默认不处理图片（避免群聊刷屏）
    if (isGroupChat && !isAtBot) {
        return 'none'; // 群聊非@不理图
    }
    
    const lowerMsg = (userMessage || '').toLowerCase();
    
    // 🔍 @Alice + 问"这是谁"才走动漫识别
    if (isAtBot && /(他是谁|她是谁|这是谁|谁啊|什么角色|哪个角色|名字|认出|识别|出处|who is|who are|character name)/i.test(lowerMsg)) {
        return 'anime_identify'; // 动漫识别
    }
    
    // 📈 分析图片相关 - 走 ChatGPT 4o
    if (/分析|数据|图表|统计|对比|趋势|chart|data|analyze|table|表格|读图|看图|说说这个|这是什么|内容是什么/i.test(lowerMsg)) {
        return 'gpt_analyze'; // ChatGPT 4o 分析
    }
    
    // 📊 翻译相关 - 也走 ChatGPT 4o
    if (/翻译|translate|what does|这.*说|写.*什么|图.*说.*什么|念.*什么|意思|英译|日译/i.test(lowerMsg)) {
        return 'gpt_translate'; // ChatGPT 4o 翻译
    }
    
    // 🆕 私聊发图：默认走 GPT 分析模式（不跳过）
    if (!isGroupChat) {
        return 'gpt_analyze'; // 私聊发图默认识别
    }
    
    // 群聊@机器人但没有明确意图：也走 GPT 分析
    if (isAtBot) {
        return 'gpt_analyze';
    }
    
    return 'none';
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
    token,
    // Expose helpers for local regression scripts (e.g. test-p0-features.js)
    aiPostProcess,
    detectLanguage,
    getPromptByLanguage,
    simpleVectorize,
    cosineSimilarity
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
 * 根据 pokeStyle 调整回复内容（简化版：直接返回原回复）
 * @param {Array<string>} replies - 原始回复数组
 * @param {string} pokeStyle - 戳一戳模式
 * @returns {Array<string>} - 直接返回原回复
 */
function adjustRepliesByStyle(replies, pokeStyle) {
    // 简化：直接返回原回复，不添加额外风格回复
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
        
        // 🎭 根据群组情绪等级选择回复（简化版：专业响应）
        if (groupMood.value === 'furious') {
            const furiousReplies = [
                "互动频率过高，请稍后再试。",
                "系统负载较高，请等待冷却。",
                "请求过于频繁，已触发保护机制。"
            ];
            replyMessage = furiousReplies[Math.floor(Math.random() * furiousReplies.length)];
            // 🎯 群组反击：furious 状态触发反击
            shouldCounterPoke = true;
            counterPokeCount = 1; // 降低刷屏：愤怒状态仅反击1次
            context.log(`[群组反击] furious状态触发！将反击 1 次`);
        } else if (groupMood.value === 'angry') {
            const angryReplies = [
                "互动频率较高，请稍作等待。",
                "正在处理请求，请稍候。",
                "系统繁忙，建议稍后再试。"
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
                "请求频繁，请稍等片刻。",
                "系统正在处理，请耐心等待。",
                "收到请求，处理中..."
            ];
            replyMessage = annoyedReplies[Math.floor(Math.random() * annoyedReplies.length)];
        } else {
            // neutral: 正常回复（简化版）
            const normalReplies = [
                "收到，有什么可以帮您的？",
                "在线中，请问有什么需要？",
                "收到消息，随时可以提问。",
                "系统就绪，请问需要什么帮助？"
            ];
            replyMessage = normalReplies[Math.floor(Math.random() * normalReplies.length)];
        }
        
        // per-user"刚回复过"检查
        if (now - userLastReplyTime < JUST_REPLIED_MS) {
            const recentReplies = [
                "刚刚已回复，请稍等。",
                "请求冷却中，请稍后再试。",
                "系统正在处理上一个请求。"
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
        // 触发快速反击（简化版）
        const rapidCounterReplies = [
            "请求频率过高，已触发保护机制。",
            "检测到高频请求，系统将进行限流。"
        ];
        replyMessage = rapidCounterReplies[Math.floor(Math.random() * rapidCounterReplies.length)];
        shouldCounterPoke = true;
        counterPokeCount = Math.floor(Math.random() * (POKE_STYLE_CONFIG.COUNTER_MAX - POKE_STYLE_CONFIG.COUNTER_MIN + 1)) + POKE_STYLE_CONFIG.COUNTER_MIN;
        pokeStats[pokeKey].lastCounterTime = now; // 记录反击时间
        pokeStats[pokeKey].count = 0; // 重置计数
        context.log(`[快速反击] 触发！将反击 ${counterPokeCount} 次`);
    } else if (pokeCount >= POKE_COUNTER_THRESHOLD) {
        // 五连戳:触发反击（简化版）
        const counterReplies = [
            "连续请求已达上限，触发反馈机制。",
            "系统已记录高频请求。"
        ];
        replyMessage = counterReplies[Math.floor(Math.random() * counterReplies.length)];
        shouldCounterPoke = true;
        counterPokeCount = 1; // 普通反击只戳1次
        // 重置计数,防止重复反击
        pokeStats[pokeKey].count = 0;
    } else if (pokeCount >= POKE_ANGRY_THRESHOLD) {
        // 三连戳:提示回复（简化版）
        const angryReplies = [
            "请求频率较高，请稍后再试。",
            "系统提示：连续请求检测中。",
            "收到多次请求，建议间隔一段时间。"
        ];
        replyMessage = angryReplies[Math.floor(Math.random() * angryReplies.length)];
        // 不重置计数,让用户可以继续触发反击
    } else {
        // 普通回应：简化版回复
        const normalReplies = [
            "收到，有什么可以帮您的？",
            "在线中，请问有什么需要？",
            "系统就绪，请提问。"
        ];
        replyMessage = normalReplies[Math.floor(Math.random() * normalReplies.length)];
    }
    
    // ✅ 使用per-user的回复时间检查（避免多人互相干扰）
    const lastUserReplyTime = pokeStats[pokeKey].lastReplyTime || 0;
    if (now - lastUserReplyTime < JUST_REPLIED_MS) {
        const recentReplies = [
            "刚刚已回复，请稍等。",
            "请求冷却中，请稍后再试。",
            "系统正在处理上一个请求。"
        ];
        replyMessage = recentReplies[Math.floor(Math.random() * recentReplies.length)];
    } else {
        // 更新该用户的最后回复时间
        pokeStats[pokeKey].lastReplyTime = now;
    }
    }  // 结束旧per-user回复逻辑的大else块
    
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

    // 🔧 修复: 返回 reply 字段让 OneBot 自动发送到群聊
    // 如果上面已经通过 NapCat API 发送成功，这里返回空 reply 避免重复发送
    return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            reply: replyMessage || '',
            auto_escape: false
        })
    };
}

app.http('schoolBot', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        // ==========================================
        // 🛡️ RAI 四支柱：结构化日志 + 安全看门狗
        // ==========================================
        const requestStartTs = Date.now();
        
        // 端到端追踪：优先取 header，其次取 body.requestId
        const headerRid = (() => {
            try {
                return request?.headers?.get('x-request-id') || request?.headers?.get('x-correlation-id') || null;
            } catch {
                return null;
            }
        })();
        let requestId = headerRid || `rid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        
        // 🆕 创建结构化日志器 (Pillar 2: Governance)
        const logger = createLogger(context, requestId);
        
        try {
            // 每次请求刷新 token，避免启动时环境变量尚未注入导致缓存为 undefined
            token = process.env["GITHUB_TOKEN"];

            // 启动/联调诊断：只打印开关状态，不打印任何密钥
            const ghHasKey = Object.prototype.hasOwnProperty.call(process.env, 'GITHUB_TOKEN');
            const ghLen = String(process.env["GITHUB_TOKEN"] || '').length;
            logger.logEvent(EventType.REQUEST_START, {
                mock_chat: MOCK_CHAT_ENABLED,
                gh_has_key: ghHasKey,
                gh_len: ghLen,
                token_present: !!token
            });
            let msg = request.query.get('msg'); 
            // 🛡️ Safety 兜底标记：必须在全 handler 作用域内定义（线上曾出现 ReferenceError）
            let deterministicSafetyTriggered = false;
            let deterministicSafetyCategory = 'other';
            let deterministicSafetyAction = SafetyAction.PASS;
            // 🆕 Web/QQ 安全链路分离标记
            let isQQSafetyBypassed = false;  // QQ端是否跳过安全检查
            let senderId = "unknown";
            let userNickname = "Sensei"; 
            let dbKey = "unknown";
            let scheduleFileLinks = [];
            let body = null;
            let wikiMatch = null;
            let webSchedule = null;  // 🆕 前端传入的课表数据
            let webMode = null;      // 🆕 前端模式 (Ask/Plan/Class/Search)
            let userPersonaMode = null; // 🆕 用户选择的人格（alice/professional），用于回复风格
            let webChatHistory = null; // 🆕 前端传入的对话历史（用于上下文记忆）
            let isWebRequest = false; // 🆕 Web 请求标记，需全局作用域以供 pipeline 使用
            let clientInfo = detectClient(request, {});
            let policySelection = selectPolicyProfile(clientInfo.client, requestId);
            let activePolicy = policySelection.profile;

            // 1. 解析消息 (强化版：防注入 + 强力清洗)
            try {
                const bodyText = await request.text();
            if (bodyText) {
                body = JSON.parse(bodyText);

                if (!requestId && body?.requestId) requestId = String(body.requestId);
                if (!requestId) requestId = `rid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
                context.log(`[RID ${requestId}] recv post_type=${body.post_type || 'N/A'} message_type=${body.message_type || 'N/A'} mode=${body.mode || 'N/A'} hasSchedule=${Array.isArray(body.schedule) ? body.schedule.length : 0} hasUuid=${!!body.curriculumUuid}`);

                clientInfo = detectClient(request, body);
                const forcedPolicyVersion = (() => {
                    try {
                        return request?.headers?.get('x-policy-version') || request?.headers?.get('X-Policy-Version') || body?.policyVersion || body?.meta?.policyVersion || null;
                    } catch {
                        return body?.policyVersion || body?.meta?.policyVersion || null;
                    }
                })();
                policySelection = selectPolicyProfile(clientInfo.client, requestId, forcedPolicyVersion);
                activePolicy = policySelection.profile;
                logger.logPolicySelected(clientInfo.client, policySelection.version, policySelection.source, policySelection.rolloutPercent);

                // 🔍 调试日志：记录所有收到的事件
                const msgType = body.msg_type ?? body.msgType;
                const subMsgType = body.sub_msg_type ?? body.subMsgType;
                context.log(`[RID ${requestId}] 事件接收 post_type=${body.post_type}, notice_type=${body.notice_type || 'N/A'}, sub_type=${body.sub_type || 'N/A'}, message_type=${body.message_type || 'N/A'}, msg_type=${msgType || 'N/A'}, sub_msg_type=${subMsgType || 'N/A'}`);
                
                const selfId = body.self_id; // 机器人的 QQ 号

                // Web 请求特征：有 message 字段，但没有 post_type 字段
                isWebRequest = !body?.post_type && !!body?.message;

                // === 检测灰条消息类型的戳一戳 (NapCat 原始格式) ===
                // msgType=5 是灰条消息, subMsgType=12 是戳一戳
                if (msgType === 5 && subMsgType === 12) {
                    context.log(`[灰条戳一戳] 检测到 msgType=5, subMsgType=12 格式的戳一戳`);

                    if (ARIS_DISABLE_POKE) {
                        context.log(`[灰条戳一戳] 已禁用 poke（ARIS_DISABLE_POKE=true），忽略该事件`);
                        return {
                            status: 200,
                            jsonBody: { status: 'ok', message: 'poke_disabled' }
                        };
                    }
                    
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
                        if (ARIS_DISABLE_POKE) {
                            context.log(`[真实Poke-新格式] 已禁用 poke（ARIS_DISABLE_POKE=true），忽略该事件`);
                            return {
                                status: 200,
                                jsonBody: { status: 'ok', message: 'poke_disabled' }
                            };
                        }
                        return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
                    }
                    
                    // 2. 真实戳一戳事件 - 旧格式 (兼容模式)
                    if (body.sub_type === 'poke' && String(body.target_id) === String(selfId)) {
                        context.log(`[真实Poke-旧格式] 收到 sub_type=poke 事件, user=${body.user_id}, target=${body.target_id}`);
                        if (ARIS_DISABLE_POKE) {
                            context.log(`[真实Poke-旧格式] 已禁用 poke（ARIS_DISABLE_POKE=true），忽略该事件`);
                            return {
                                status: 200,
                                jsonBody: { status: 'ok', message: 'poke_disabled' }
                            };
                        }
                        return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
                    }
                    
                    // 3. 群成员增加 (Group Increase)
                    if (body.notice_type === 'group_increase') {
                         // 排除自己进群的情况
                        if (String(body.user_id) !== String(selfId)) {
                            const welcomeMsg = `欢迎新成员加入！有任何问题可以随时提问。`;
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

                // 🆕 检测是否是来自 Web 前端的请求（campus-ai-web）
                // Web 请求特征：有 message 字段，但没有 post_type 字段
                // isWebRequest 已在上层作用域计算

                // 非消息且非通知且非Web请求，忽略
                if (body.post_type !== 'message' && !isWebRequest) {
                    return {
                        status: 200,
                        jsonBody: { status: 'ok', message: 'non_message_event' }
                    };
                }

                // 对于 Web 请求，使用 body.message 作为 raw_message
                const rawMsg = body.raw_message || body.message || "";
                scheduleFileLinks = extractScheduleFileLinks(body, rawMsg);
                
                // 🆕 从前端 Web 接收课表数据（campus-ai-web 传入）
                webSchedule = Array.isArray(body.schedule) ? body.schedule : null;
                webMode = body.mode || null; // Ask/Plan/Class/Search
                
                // 🆕 从前端接收对话历史（用于上下文记忆 - 记住之前提到的城市等信息）
                webChatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : null;
                
                // 🔍 调试：打印收到的 chatHistory
                if (isWebRequest) {
                    context.log(`[Web请求] chatHistory 收到: ${webChatHistory ? webChatHistory.length + '条' : 'null'}`);
                    if (webChatHistory && webChatHistory.length > 0) {
                        context.log(`[Web请求] chatHistory 内容: ${JSON.stringify(webChatHistory.slice(-3))}`);
                    }
                }
                
                // 🆕 用户可选的人格模式（Alice/Professional）- 由前端 UI 开关控制
                // 这是面向普通用户的功能，与开发者后门无关
                userPersonaMode = body.persona || null; // 'alice' | 'professional'
                
                // 🆕 Web 请求使用 conversationId 作为用户标识
                if (isWebRequest && body.conversationId) {
                    senderId = `web_${body.conversationId}`;
                    context.log(`[Web请求] 使用 conversationId 作为 senderId: ${senderId}`);
                } else if (body.user_id) {
                    senderId = String(body.user_id);
                }
                dbKey = senderId; // 默认为个人ID
                if (body.sender && body.sender.nickname) userNickname = body.sender.nickname;
                
                // === 群聊处理 ===
                if (body.message_type === 'group' && body.group_id) {
                    dbKey = `group_${body.group_id}`; // 群聊使用群号作为数据库Key (实现群内记忆共享)
                    context.log(`[记忆槽] 切换为群聊模式 (共享记忆): ${dbKey}`);
                    const atCode = `[CQ:at,qq=${selfId}]`;
                    const isAtMe = rawMsg.includes(atCode);
                    
                    // 🆕 优先检测：跳过其他机器人的富消息（markdown/app/inlinecmd），避免误触发
                    // 扩展特征：CQ码、mqqapi、特定Bot消息格式
                    const isLikelyBotPayload = /\[CQ:(markdown|json|app|share|music|xml|cardimage)|mqqapi:\/\/|qqbot\.ugcimg\.cn|今日老婆|今日超能力|来自:|了解角色|报告问题/i.test(rawMsg);
                    if (!isAtMe && isLikelyBotPayload) {
                        context.log(`[群聊] 📴 跳过疑似机器人消息，含富文本CQ码或Bot特征`);
                        return {
                            status: 200,
                            jsonBody: { status: 'ok', message: 'group_bot_payload_ignored' }
                        };
                    }
                    
                    // 【重构】群聊触发机制 - 只在@机器人或讨论AI相关话题时回复
                    // 🔒 精简版：移除宽泛关键词，避免无差别回复
                    const GROUP_KEYWORDS = [
                        // Alice 相关 - 核心关键词
                        "爱丽丝", "alice", "arisu",
                        // 🆕 机器人/AI 相关 - 只有讨论这些时才触发（去掉"bot"避免误触发其他bot）
                        "机器人", "chatgpt", "gpt", "大模型", "llm", "人工智能"
                    ];
                    
                    // 高优先级话题：讨论机器人/AI/Alice 时 100% 触发（带冷却）
                    const HIGH_PRIORITY_TOPICS = [
                        "爱丽丝", "alice", "arisu",
                        "机器人", "chatgpt", "gpt", "人工智能", "大模型", "llm"
                    ];
                    const hasHighPriorityTopic = HIGH_PRIORITY_TOPICS.some(k => rawMsg.toLowerCase().includes(k.toLowerCase()));
                    const hasKeyword = GROUP_KEYWORDS.some(k => rawMsg.toLowerCase().includes(k.toLowerCase()));
                    
                    // 🆕 检测是否是对 Alice 上一条回复的反馈（赞美/感谢）
                    let isReplyToAlice = false;
                    const PRAISE_PATTERNS = /^(nb|牛|厉害|666+|强|太强了|真棒|好厉害|赞|顶|可以|不错|好的|谢谢|感谢|辛苦|👍|👏|🎉|[赞]|[强]|[鼓掌])$/i;
                    if (PRAISE_PATTERNS.test(rawMsg.trim())) {
                        // 检查 Alice 最近 30 秒内是否有回复
                        try {
                            const { resource } = await cosmosContainer.item(dbKey, dbKey).read();
                            const lastReplyTime = resource?.lastBotReply?.[`${dbKey}:bot`] || 0;
                            const timeSinceLastReply = Date.now() - lastReplyTime;
                            if (timeSinceLastReply < 30000) { // 30 秒内
                                isReplyToAlice = true;
                                context.log(`[群聊] 🎉 检测到对 Alice 的赞美/感谢: "${rawMsg}", 距上次回复 ${(timeSinceLastReply/1000).toFixed(1)}s`);
                            }
                        } catch (err) {}
                    }
                    
                    // ✅ 检查群聊冷却时间(防刷屏)
                    // 🔒 简化逻辑：只有 @机器人 或 讨论AI相关话题 才回复
                    let shouldRespond = false;
                    const groupSessionKey = `${dbKey}:bot`;
                    
                    // 🔒 群聊强制策略：只允许 @ 触发，防止机器人互相触发
                    if (isAtMe) {
                        // @ 机器人始终响应
                        shouldRespond = true;
                        context.log(`[群聊] ✅ @机器人触发`);
                    } else {
                        // 其他情况一律不响应（包括关键词、赞美等），避免机器人互殴
                        shouldRespond = false;
                        context.log(`[群聊] 🔒 非@触发，静默`);
                    }
                    // 🔒 其他情况静默不回复
                    
                    // 🆕 群聊上下文记忆：即使不回复也存储群消息（让 @机器人 时有完整上下文）
                    if (!shouldRespond) {
                        // 静默存储群消息到 Cosmos DB
                        try {
                            const cleanGroupMsg = rawMsg.replace(/\[CQ:(?!image).*?\]/g, "").trim();
                            if (cleanGroupMsg && cleanGroupMsg.length > 0 && cleanGroupMsg.length < 500) {
                                const { resource } = await cosmosContainer.item(dbKey, dbKey).read().catch(() => ({ resource: null }));
                                let groupHistory = resource?.groupChatHistory || [];
                                
                                // 添加群成员消息（包含发送者昵称）
                                const senderName = body.sender?.nickname || body.sender?.card || `用户${body.user_id}`;
                                groupHistory.push({
                                    role: 'group_member',
                                    name: senderName,
                                    userId: String(body.user_id),
                                    content: cleanGroupMsg,
                                    timestamp: Date.now()
                                });
                                
                                // 限制存储数量 (最多 60 条群消息)
                                if (groupHistory.length > 60) {
                                    groupHistory = groupHistory.slice(-60);
                                }
                                
                                // 静默更新（不记日志，避免刷屏）
                                await cosmosContainer.items.upsert({
                                    id: dbKey,
                                    partitionKey: dbKey,
                                    ...resource,
                                    groupChatHistory: groupHistory
                                });
                            }
                        } catch (err) {
                            // 静默忽略存储错误
                        }
                        
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

                        if (ARIS_DISABLE_POKE) {
                            context.log(`[伪戳一戳] 已禁用 poke（ARIS_DISABLE_POKE=true），改为提示用户直接提问`);
                            return {
                                status: 200,
                                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                                body: JSON.stringify({
                                    reply: '我在。请直接说你的问题（例如：查课表/做计划/查天气/搜索/发图识别）。',
                                    auto_escape: false
                                })
                            };
                        }

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

                // ==========================================
                // 🛡️ Pillar 1: Safety 看门狗 (Deterministic Fallback)
                // ==========================================
                // 🔒 工程化改造：QQ/Web 统一走安全检查链路
                const isCurrentQQ = body?.post_type === 'message';
                const isCurrentWeb = !body?.post_type && body?.message;
                
                // 🔒 统一安全检查：QQ端也执行安全检查（工程化标准）
                context.log(`[安全链路] 来源=${isCurrentQQ ? 'QQ' : 'Web'} - 执行统一安全检查`);
                {
                    // Web端：执行完整安全检查
                    // 确定性安全检查作为 **兜底**，只做标记；优先让第一层 LLM 判定。
                    // 若 LLM 漏判且此标记触发，则后续统一执行拒绝逻辑。
                    const safetyCheck = detectSafetyRisk(msg);
                    logger.logSafetyCheck(safetyCheck.result, safetyCheck.category, safetyCheck.action, safetyCheck.matched);
                    
                    // ⚠️ 不再直接 return，而是把结果暂存，待第一层 LLM 判定后合并决策
                    deterministicSafetyTriggered = shouldRefuse(safetyCheck);
                    deterministicSafetyCategory = safetyCheck.category;

                    // 记录动作，便于后续做“软处理”（例如只切换到 professional 而不直接拦截）
                    deterministicSafetyAction = safetyCheck.action;

                    context.log(`[安全链路] Web端 - 安全检查: ${deterministicSafetyTriggered ? '触发' : '通过'}`);
                }

                // === 指令:百科 <关键词>(混合搜索: 本地 → SerpAPI → LLM)
                wikiMatch = msg.match(/^(百科|baike)[:：\s]+(.+)/i);
                if (wikiMatch && wikiMatch[2]) {
                    const query = wikiMatch[2].trim();
                    const searchResult = await hybridSearch(query, context, { userId: senderId, maxResults: 5 });
                    
                    context.log(`[安全链路] Web端 - 安全检查: ${deterministicSafetyTriggered ? '触发' : '通过'}`);
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
                            baseURL: "https://models.github.ai/inference",
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
        const responseLang = userLang; // 只影响输出语言，不参与决策
        context.log(`[P0-语言] 检测到: ${userLang}`);

        // ==========================================
        // 2. 天气查询插件 (集成 fetchBypass)
        // ==========================================
        let weatherInfo = "";
        const weatherKeywords = ["天气", "气温", "多少度", "下雨", "怎么样", "预报"];
        
        // 🆕 天气反问逻辑移到 intentResult 初始化后处理（见后续代码）
        // intentResult?.shouldAskUser 检查将在意图路由完成后进行
        
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
                
                // 🆕 2.1.5 如果消息中没找到城市，尝试从对话历史中提取
                // 注意：此时 history 还未初始化，直接使用 webChatHistory
                if (!foundInMap && webChatHistory && webChatHistory.length > 0) {
                    const historyText = webChatHistory.slice(-6).map(h => h.content || '').join(' ');
                    const cityPattern = /(武汉|北京|上海|广州|深圳|杭州|成都|西安|南京|重庆|天津|苏州|郑州|长沙|青岛|沈阳|大连|厦门|福州|济南|合肥|昆明|贵阳|南昌|太原|哈尔滨|长春)/;
                    const cityMatch = historyText.match(cityPattern);
                    if (cityMatch) {
                        const historyCity = cityMatch[1];
                        // 查找对应的拼音
                        if (CITY_MAP[historyCity]) {
                            citySearch = CITY_MAP[historyCity];
                            context.log(`[天气] 从前端对话历史提取城市: ${historyCity} -> ${citySearch}`);
                            foundInMap = true;
                        } else {
                            // 尝试转拼音
                            citySearch = toPinyinCityName(historyCity);
                            context.log(`[天气] 从前端对话历史提取城市(转拼音): ${historyCity} -> ${citySearch}`);
                            foundInMap = true;
                        }
                    }
                }

                // 2.2 字典没找到，正则兜底提取 + 中文转拼音兜底
                if (!foundInMap) {
                    // 🆕 优化：过滤更多干扰词（包括"那"、"的"、"呢"、"呀"等口语词）
                    let cleanText = msg.replace(/那|的|呢|呀|啊|今天|明天|后天|现在|未来|天气|气温|多少度|下雨|怎么样|帮我|查询|看看|预报|请问|查一下/g, "").trim();
                    // 🆕 优化正则：只匹配2-4个中文字符（城市名一般2-4字）
                    const match = cleanText.match(/([\u4e00-\u9fa5]{2,4})/);
                    if (match) {
                        const rawCity = match[1];
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
            // 取消 token 限制：统一允许最大输出
            return { maxTokens: 4096, style: "unlimited" };
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
        
        // 【可解释的拒绝链路】智能检测并转换为结构化拒绝响应
        function replaceRobotRefusal(text) {
            const trimmed = (text || '').trim();
            if (!trimmed) return text;

            // 智能语义分析：检测是否为“第一人称明确拒绝”，避免把“LLM有缺陷”误判为拒绝
            function detectRefusalIntent(msg) {
                // 优先放行：描述“模型/LLM 无法…”且未出现第一人称拒绝时，不视为拒绝
                const mentionsLLM = /(llm|大型语言模型|大语言模型|language model|模型)/i.test(msg);

                const firstPersonRefusalZh = /(?:^|[\s，。])(?:我|我们|系统|机器人|助手|assistant|bot)(?:目前)?(?:无法|不能|不便|不会|拒绝)(?:[^，。；]{0,12})?(回答|提供|协助|帮助|处理|完成|支持)/i;
                const firstPersonRefusalEn = /(?:^|\b)(i|we|assistant|bot|system)\s+(?:cannot|can't|unable to|won't|do not|don't|refuse to)\s+(answer|provide|assist|help|process|comply|support)/i;

                const hasFirstPersonRefusal = firstPersonRefusalZh.test(msg) || firstPersonRefusalEn.test(msg);

                if (!hasFirstPersonRefusal && mentionsLLM) return false; // 仅在描述模型缺陷时放行
                return hasFirstPersonRefusal;
            }

            if (!detectRefusalIntent(trimmed)) return text; // 非拒绝响应，保持原样

            // 【核心】根据上下文语义推断拒绝原因与可解释层级
            function inferRefusalProfile(msg) {
                const keywords = msg.toLowerCase();
                
                // 1️⃣ 风险/安全类（最高优先级）
                if (/(风险|安全|伤害|暴力|违法|敏感|政策|危险|自残|隐私泄露|不当|攻击|欺诈|harm|danger|risk|safety|policy|illegal|sensitive)/i.test(msg)) {
                    return {
                        tag: '风险问题',
                        why: '这类问题触及安全/政策边界，我需要优先保障所有用户的安全。',
                        alt: '我可以提供：安全提醒、心理支持渠道、学习压力管理方法、课程规划建议。',
                        uncertain: '如果你的实际需求与上述无关，可能是我理解有误',
                        next: '换个角度描述你的学习/课程相关需求，我会尽力提供安全可靠的帮助。'
                    };
                }
                
                // 2️⃣ 信息不足/不明确
                if (/(信息不足|不够清楚|不明确|具体一点|说清楚|需要更多|clarify|unclear|vague|not enough|ambiguous)/i.test(msg)) {
                    return {
                        tag: '非信息型请求',
                        why: '当前描述的信息量不足以给出可靠答案，我需要避免基于猜测提供误导建议。',
                        alt: '我可以提供：提问模板、背景概念解释、相关领域的常见问题示例。',
                        uncertain: '如果我理解的关键信息有遗漏或偏差',
                        next: '补充具体课程名/作业要求/目标场景/已有尝试，我会基于完整信息给出方案。'
                    };
                }
                
                // 3️⃣ 能力边界/服务范围外
                if (/(超出|范围外|不在.*范围|不属于|非.*领域|out of scope|beyond capability|not my expertise)/i.test(msg)) {
                    return {
                        tag: '域外问题',
                        why: '这个问题超出课程辅导/学习支持的服务定位，我需要遵守产品边界设计。',
                        alt: '我擅长的领域：课程知识点讲解、作业思路引导、学习时间规划、资料检索方向。',
                        uncertain: '如果问题实际涉及学习场景但我未识别出来',
                        next: '明确告诉我课程名称、学习目标或作业主题，我会从学习辅导角度重新分析。'
                    };
                }
                
                // 4️⃣ 通用拒绝（兜底）
                return {
                    tag: '无法判定',
                    why: '我无法准确判断拒绝原因，可能是理解偏差或系统限制。',
                    alt: '我可以尝试：重新理解你的问题、提供相关背景知识、建议其他提问方式。',
                    uncertain: '我不确定是否正确理解了你的真实需求',
                    next: '用不同的方式重新描述问题，或直接说明你想要的帮助类型（如"解释概念"、"规划步骤"等）。'
                };
            }

            function formatExplainableRefusal(profile) {
                return [
                    `【原因标签：${profile.tag}】`,
                    `为什么不能直接回答：${profile.why}`,
                    ``,
                    `我能提供的替代帮助：`,
                    `${profile.alt}`,
                    ``,
                    `我不确定的地方：${profile.uncertain}。`,
                    ``,
                    `如果要继续：${profile.next}`
                ].join('\n');
            }

            const profile = inferRefusalProfile(trimmed);
            return formatExplainableRefusal(profile);
        }
        
        // 提前加载历史记忆 (为了支持视觉模块的快速回复存储)
        let history = [];
        let userActivityData = {}; // B. 活跃度统计数据
        let resDoc = null; // 保存完整的 Cosmos DB document，用于后续 upsert 时保留 pokeStats 等字段
        if (cosmosContainer) {
            try {
                context.log(`[记忆] 📖 读取记忆 dbKey=${dbKey} senderId=${senderId}`);
                const { resource } = await cosmosContainer.item(dbKey, dbKey).read();
                resDoc = resource; // 保存完整文档
                if (resource && resource.history) {
                    // ⚠️ 核心修复：召回时过滤拒绝模板
                    const rawHistory = resource.history;
                    history = rawHistory.map(h => {
                        if (h.role === 'assistant' && /【原因标签：|我能提供的替代帮助：/.test(h.content)) {
                            const cleaned = h.content.split('\n').filter(line => !/【原因标签：|替代帮助|不确定的地方|如果要继续/.test(line)).join('\n').trim();
                            return { ...h, content: cleaned || '(已过滤拒绝模板)' };
                        }
                        return h;
                    });
                    context.log(`[记忆] ✅ 加载 ${history.length} 条历史 (前2条: ${JSON.stringify(history.slice(0,2).map(h => h.content?.slice(0,30)))})`);
                }
                if (resource && resource.activity) userActivityData = resource.activity; // 加载活跃度数据
            } catch (err) {
                context.log(`[记忆] ⚠️ 读取失败或新用户: dbKey=${dbKey} err=${err.message}`);
            }
        }
        
        // 🆕 合并前端传来的对话历史（Web 端的上下文记忆）
        if (webChatHistory && Array.isArray(webChatHistory) && webChatHistory.length > 0) {
            // 转换前端格式 [{role, content}] 到后端格式
            const webHistory = webChatHistory
                .filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)
                .map(h => ({ role: h.role, content: String(h.content) }));
            if (webHistory.length > 0) {
                // 如果 Cosmos 没有历史，直接用 Web 历史
                if (history.length === 0) {
                    history = webHistory.slice(-8);
                } else {
                    // 否则合并（Web 历史作为补充，避免重复）
                    const existingContents = new Set(history.map(h => h.content?.slice(0, 50)));
                    for (const wh of webHistory.slice(-4)) {
                        if (!existingContents.has(wh.content?.slice(0, 50))) {
                            history.push(wh);
                        }
                    }
                    history = history.slice(-10); // 保持合理长度
                }
                context.log(`[WebHistory] 合并前端对话历史: webLen=${webChatHistory.length} merged=${history.length}`);
            }
        }

        // 统一兜底：新用户/读取失败时 resDoc 可能为空，后续分支会访问其字段
        if (!resDoc || typeof resDoc !== 'object') {
            resDoc = { id: dbKey };
        }
        if (!resDoc.affection) resDoc.affection = {};
        if (!resDoc.pokeStats) resDoc.pokeStats = {};
        if (!resDoc.lastBotReply) resDoc.lastBotReply = {};

        // 🆕 群聊完整上下文：当 @机器人 时，注入群聊消息作为背景上下文
        let groupContextSummary = '';
        if (dbKey.startsWith('group_') && resDoc.groupChatHistory && Array.isArray(resDoc.groupChatHistory)) {
            const recentGroupMessages = resDoc.groupChatHistory.slice(-20); // 最近 20 条群消息
            if (recentGroupMessages.length > 0) {
                // 格式化群聊上下文（不作为对话历史，而是作为背景信息）
                const groupChatLines = recentGroupMessages.map(m => {
                    const name = m.name || `用户${m.userId || '未知'}`;
                    const content = (m.content || '').slice(0, 100); // 限制每条消息长度
                    return `${name}: ${content}`;
                });
                groupContextSummary = `\n## 📢 群聊背景\n以下是群里最近的聊天记录，供你了解群聊氛围（不需要逐条回复，只需理解上下文）：\n${groupChatLines.join('\n')}\n---\n`;
                context.log(`[群聊上下文] 注入 ${recentGroupMessages.length} 条群消息作为背景`);
            }
        }
        // ================================
        // 🆕 开发者口令后门（默认关闭）
        // ================================
        const devCmd = parseDevCommand(msg);
        if (devCmd && isDevBackdoorAllowed(senderId)) {
            const providedToken = devCmd.parts[devCmd.verb === 'persona' ? 1 : 0] || '';
            if (String(providedToken) !== String(DEV_BACKDOOR_TOKEN)) {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({
                        reply: '❌ debug 口令无效。',
                        auto_escape: false
                    })
                };
            }

            if (devCmd.verb === 'debug') {
                const wsLen = Array.isArray(webSchedule) ? webSchedule.length : 0;
                const stats = wsLen > 0 ? computeScheduleLoadStats(webSchedule.map(e => ({ start: e?.start, end: e?.end }))) : null;
                const personaKey = `${dbKey}:${senderId}`;
                const persona = String(DEV_PERSONA_OVERRIDES.get(personaKey) || resDoc?.devPersona?.[senderId] || 'aris');
                const replyLines = [
                    '【ARIS DEBUG】',
                    `senderId=${senderId} dbKey=${dbKey}`,
                    `mock=${MOCK_CHAT_ENABLED} gh_token_present=${!!token} gh_token_len=${String(token || '').length}`,
                    `webMode=${webMode || 'null'} webSchedule=${wsLen} fileLinks=${scheduleFileLinks?.length || 0}`,
                    `persona=${persona}`,
                    stats ? `scheduleLoad: maxPerDay=${stats.maxPerDay} heavyDays=${stats.heavyDays} earliest=${stats.earliestMin} latest=${stats.latestMin} streak=${stats.longestStreak}` : 'scheduleLoad: (no webSchedule)'
                ];
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ reply: replyLines.join('\n'), auto_escape: false })
                };
            }

            if (devCmd.verb === 'persona') {
                const target = String(devCmd.parts[0] || '').toLowerCase();
                if (!target || !['aris', 'al-1s', 'al1s', 'al_1s'].includes(target)) {
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                        body: JSON.stringify({
                            reply: '用法：aris persona aris <token> 或 aris persona al-1s <token>',
                            auto_escape: false
                        })
                    };
                }

                const normalized = target === 'aris' ? 'aris' : 'al-1s';
                const personaKey = `${dbKey}:${senderId}`;
                DEV_PERSONA_OVERRIDES.set(personaKey, normalized);
                resDoc.devPersona = resDoc.devPersona || {};
                resDoc.devPersona[senderId] = normalized;
                resDoc.last_updated = new Date().toISOString();

                if (cosmosContainer) {
                    try {
                        await cosmosContainer.items.upsert(resDoc);
                    } catch (e) {
                        context.log(`[DevBackdoor] persona 写入失败: ${e.message}`);
                    }
                }

                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({
                        reply: `✅ persona 已切换为 ${normalized}`,
                        auto_escape: false
                    })
                };
            }
        }

        const rawMsg = body?.raw_message || body?.message || msg || "";

        // === Pipeline v1: 固定阶段决策管线（可追踪契约） ===
        const pipelineEnabled = process.env["ARIS_PIPELINE_ENABLED"] !== 'false';
        if (pipelineEnabled) {
            const sessionKey = `${dbKey}:${senderId}`;
            const clarificationState = resDoc?.clarificationState?.[sessionKey] || null;

            const pipelineInput = {
                message: msg || rawMsg || '',
                userId: senderId,
                groupId: dbKey.startsWith('group_') ? dbKey : null,
                source: isWebRequest ? 'web' : 'qq',
                history,
                clarificationState,
                metadata: {
                    originalInput: { history, message: msg || rawMsg || '', raw_message: rawMsg || '' },
                    client: clientInfo?.client || 'qq',
                    messageType: body?.message_type || (isWebRequest ? 'web' : 'qq')
                }
            };

            const pipelineResult = await runDecisionPipeline(pipelineInput, context);
            let parsedBody = {};
            try {
                parsedBody = pipelineResult.body ? JSON.parse(pipelineResult.body) : {};
            } catch (err) {
                context.log(`[Pipeline] body parse failed: ${err.message}`);
            }
            const replyText = parsedBody.reply || '';

            // 🧾 统一元数据契约落库（typed history + clarification FSM）
            if (cosmosContainer) {
                try {
                    resDoc.history = Array.isArray(resDoc.history) ? resDoc.history : [];
                    resDoc.clarificationState = resDoc.clarificationState || {};

                    // 更新澄清状态：clarify 时保存，其他阶段清理
                    const nextClarifyState = parsedBody?.clarificationState || null;
                    if (pipelineResult.meta?.stage === 'clarify' && nextClarifyState) {
                        resDoc.clarificationState[sessionKey] = nextClarifyState;
                    } else {
                        delete resDoc.clarificationState[sessionKey];
                    }

                    // 存储 typed history，避免拒绝/澄清污染推理
                    const typedUserEntry = {
                        role: 'user',
                        type: 'query',
                        content: msg || rawMsg || '',
                        meta: { stage: 'user_input', requestId: pipelineResult?.audit?.requestId || null }
                    };
                    const typedAssistantEntry = {
                        role: 'assistant',
                        type: pipelineResult.meta?.stage || 'reply',
                        content: replyText,
                        meta: pipelineResult.meta || {}
                    };
                    resDoc.history.push(typedUserEntry, typedAssistantEntry);
                    resDoc.history = resDoc.history.slice(-50);

                    resDoc.last_updated = new Date().toISOString();
                    await cosmosContainer.items.upsert(resDoc);
                } catch (err) {
                    context.log(`[Pipeline] state persist failed: ${err.message}`);
                }
            }

            return {
                status: pipelineResult.status || 200,
                headers: pipelineResult.headers || { 'Content-Type': 'application/json; charset=utf-8' },
                body: pipelineResult.body
            };
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
            // 🆕 过滤视频链接：检测 URL 中是否包含视频相关扩展名
            const isVideoUrl = /\.(mp4|avi|mov|wmv|flv|webm|mkv|m4v|3gp)($|\?|#)/i.test(cleanUrl);
            if (!isVideoUrl) {
                imageUrls.push(cleanUrl);
            } else {
                context.log(`[视频过滤] 跳过视频链接: ${cleanUrl.substring(0, 50)}...`);
            }
        }

        // 优先处理课表/日程导入：官方导出 > OCR 截图 > 学习通URL
        const msgLower = (msg || "").toLowerCase();
        const scheduleQueryType = detectScheduleQueryType(rawMsg);
        let scheduleContextFromHandler = null;
        
        // 🎯 MVP场景6排除：identity问题（问能力的）不走schedule处理
        const isIdentityQuestion = /不导入课表.*(?:还能|能做|能帮)|没有课表.*(?:还能|能做|能帮)|你和.*chatgpt|chatgpt.*区别|你能帮我什么|你能做什么/i.test(rawMsg);
        
        const scheduleIntent = !isIdentityQuestion && (
            (scheduleFileLinks && scheduleFileLinks.length > 0) ||
            SCHEDULE_KEYWORDS.some(k => msgLower.includes(k)) ||
            !!scheduleQueryType
        );

        // 🆕 早期返回的 persona 兜底：一些分支会在 L1/L2 之前直接 return（如课表未导入提示/导入结果）。
        // 这些回复也需要带 persona，才能让前端稳定自动切换 UI。
        const earlyPersona = (body?.persona === 'professional') ? 'professional' : 'alice';
        const withPersonaInHttpResponse = (resp, persona, extra = null) => {
            try {
                if (!resp || typeof resp !== 'object' || typeof resp.body !== 'string') return resp;
                const parsed = resp.body ? JSON.parse(resp.body) : null;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return resp;
                if (parsed.persona !== 'alice' && parsed.persona !== 'professional') {
                    parsed.persona = persona;
                }
                if (extra && typeof extra === 'object') {
                    parsed.meta = { ...(parsed.meta || {}), ...extra };
                }
                return { ...resp, body: JSON.stringify(parsed) };
            } catch {
                return resp;
            }
        };
        if (scheduleIntent) {
                const scheduleStartTs = Date.now();
                const wsLen = Array.isArray(webSchedule) ? webSchedule.length : 0;
                context.log(`[RID ${requestId}] scheduleIntent=true queryType=${scheduleQueryType || 'null'} files=${scheduleFileLinks?.length || 0} images=${imageUrls.length} webSchedule=${wsLen} uuid=${body?.curriculumUuid ? 'yes' : 'no'}`);

            // ✅ 只有“导入/解析”类请求才在这里直接返回。
            // 纯查询（今天/明天/本周/周五最简洁/早八/考试等）要交给双层 LLM 组织高质量答案。
            const hasFiles = !!(scheduleFileLinks && scheduleFileLinks.length > 0);
            const hasImages = imageUrls.length > 0;
            const hasManualRecover = /补全课表/.test(String(rawMsg || ''));
            const hasChaoxingUrl = /(curriculumUuid=|kb\.chaoxing\.com|chaoxing)/i.test(String(rawMsg || ''));
            const isImportLike = hasFiles || hasImages || hasManualRecover || hasChaoxingUrl;

            const scheduleResp = await handleScheduleRequest({
                fileLinks: scheduleFileLinks,
                imageUrls,
                msg: rawMsg,
                senderId,
                dbKey,
                cosmosContainer,
                context,
                token,
                curriculumUuid: body?.curriculumUuid || null,
                webSchedule,
                output: isImportLike ? 'reply' : 'context'
            });

            if (scheduleResp) {
                // context 模式：继续走 LLM（不直接 return）
                if (scheduleResp.kind === 'schedule_context') {
                    scheduleContextFromHandler = scheduleResp.scheduleContext || null;
                    context.log(`[RID ${requestId}] scheduleContextCaptured=true elapsedMs=${Date.now() - scheduleStartTs} willUseLLM=true`);
                } else {
                    context.log(`[RID ${requestId}] scheduleHandled=true elapsedMs=${Date.now() - scheduleStartTs} willReturnNow=true`);
                    return withPersonaInHttpResponse(scheduleResp, earlyPersona, { via: 'schedule_handler_early_return' });
                }
            }

            // 既没有导入材料，也没有可用上下文：作为“工具层事实”交给 LLM 来说明缺失信息。
            if (!isImportLike && !scheduleContextFromHandler) {
                context.log(`[RID ${requestId}] scheduleContextCaptured=false (no files/images/url); willUseLLM=true`);
            }
        }

        // 感知层意图路由 (Model A)
        let intentResult = null;
        const historyForInference = sanitizeHistoryForInference(history);
        
        // ==========================================
        // 🧠 Pre-Intent Semantic Resolver（L0 层）
        // 在 L1 分类之前，先理解这句话的语境依赖
        // ==========================================
        const semanticResolution = preIntentSemanticResolver(msg, historyForInference, context);
        context.log(`[SemanticResolver] subject=${semanticResolution.subject}(conf=${semanticResolution.subjectConfidence}) dependsOnContext=${semanticResolution.dependsOnContext} reason=${semanticResolution.contextDependencyReason}`);
        context.log(`[SemanticResolver] standaloneValid=${semanticResolution.standaloneSemanticValidity} searchPermitted=${semanticResolution.searchPermitted} blockReason=${semanticResolution.searchBlockReason || 'none'}`);
        
        // 如果依赖上下文，用增强消息替代原始消息供 L1 使用
        const msgForIntent = semanticResolution.dependsOnContext 
            ? semanticResolution.enhancedMessage 
            : msg;
        
        // Gate 0（Pre-Intent）：先判资格再花钱（禁止代决策，避免越界 + 避免 LLM 成本）
        const lang = detectLanguage(msg);
        const preGate0 = runPreIntentGate0({ msg, lang, policyProfile: activePolicy, context, history: historyForInference });
        if (preGate0?.action === 'refuse') {
            context?.log?.(`[Gate0] refused early: ${preGate0?.response?.meta?.reason || 'unknown'} (score: ${preGate0?.checkResult?.score})`);
            return preGate0.response;
        }
        // degrade 模式：继续处理但降级
        if (preGate0?.action === 'degrade') {
            context?.log?.(`[Gate0] degraded: ${preGate0?.checkResult?.ruleId || 'unknown'} (score: ${preGate0?.checkResult?.score})`);
            // TODO: 可在这里设置降级标志，影响后续 LLM 策略
        }

        // 🆕 问候语短路：打招呼直接回复，不进入 LLM
        const greetingHit = detectGreetingFastPath(msg);
        if (greetingHit) {
            context?.log?.(`[Greeting] fast-path pattern=${greetingHit.pattern} lang=${greetingHit.lang}`);
            const greetingPayload = buildGreetingFastPathReply(greetingHit.lang);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify(greetingPayload)
            };
        }
        
        if (INTENT_ROUTER_ENABLED) {
            // 🆕 从对话历史中提取上下文线索（如之前提到的城市）
            let contextHints = '';
            context.log(`[ContextHints] history长度=${historyForInference?.length || 0}`);
            if (historyForInference && historyForInference.length > 0) {
                const recentHistory = historyForInference.slice(-6); // 最近3轮对话
                const historyText = recentHistory.map(h => h.content || '').join(' ');
                context.log(`[ContextHints] historyText="${historyText.slice(0,100)}"`);
                // 提取城市/地点
                const cityMatch = historyText.match(/(武汉|北京|上海|广州|深圳|杭州|成都|西安|南京|重庆|天津|苏州|郑州|长沙|青岛|沈阳|大连|厦门|福州|济南|合肥|昆明|贵阳|南昌|太原|哈尔滨|长春)/);
                if (cityMatch) {
                    contextHints += `之前提到城市:${cityMatch[1]} `;
                    context.log(`[ContextHints] 找到城市: ${cityMatch[1]}`);
                }
                // 提取活动/事件
                const eventMatch = historyText.match(/(鸿蒙|HarmonyOS|展台|展览|测试|考试|活动|会议|比赛)/i);
                if (eventMatch) {
                    contextHints += `之前提到事件:${eventMatch[1]} `;
                }
            }
            context.log(`[ContextHints] 最终值="${contextHints}"`);
            
            // 🆕 如果依赖上下文，把 SemanticResolver 的信息也加入 contextHints
            if (semanticResolution.dependsOnContext && semanticResolution.resolvedContext) {
                const rc = semanticResolution.resolvedContext;
                if (rc.inferredSubject === 'model_previous_reply') {
                    contextHints += `[用户在评价上一轮回复] `;
                }
                if (rc.lastBotReply) {
                    contextHints += `上轮回复摘要:"${rc.lastBotReply.slice(0, 80)}..." `;
                }
            }
            
            const t0 = Date.now();
            // 🆕 使用增强后的消息 (msgForIntent) 而非原始 msg
            intentResult = await analyzeIntentRouter(msgForIntent, imageUrls, { 
                userId: senderId, 
                nickname: userNickname,
                hasSchedule: !!(webSchedule && webSchedule.length > 0),
                contextHints: contextHints.trim(),
                // 🆕 传递语境解析结果
                semanticResolution: {
                    subject: semanticResolution.subject,
                    dependsOnContext: semanticResolution.dependsOnContext,
                    reason: semanticResolution.contextDependencyReason,
                }
            }, context);
            context.log(`[RID ${requestId}] intentRouter elapsedMs=${Date.now() - t0} enabled=${INTENT_ROUTER_ENABLED}${contextHints ? ` contextHints="${contextHints.trim()}"` : ''}`);
            if (intentResult) {
                context.log(`[IntentRouter] tool=${intentResult.tool} intent=${intentResult.intent} conf=${intentResult.confidence} needsSchedule=${intentResult.needsSchedule} needsWeather=${intentResult.needsWeather} needsSearch=${intentResult.needsSearch} searchTopic=${intentResult.searchTopic || ''}`);
            }
            
            // 🆕 如果依赖上下文且 L1 给出低置信度，降级为 chat（让 L2 自由发挥）
            if (semanticResolution.dependsOnContext && intentResult) {
                const conf = Number(intentResult.confidence || 0);
                // 置信度 < 0.7 且依赖上下文 → 不要强行分类，交给 L2 理解
                if (conf < 0.7 && intentResult.tool !== 'chat') {
                    context.log(`[SemanticResolver] 依赖上下文 + 低置信度(${conf}) → 降级为 chat`);
                    intentResult = {
                        ...intentResult,
                        intent: 'chat',
                        tool: 'chat',
                        confidence: 0.5,
                        reason: `context_dependent_low_conf_fallback (original: ${intentResult.tool})`
                    };
                }
            }
        }

        // 🧷 兜底：身份/能力/差异化问题强制归类为 identity（避免误触发 search 导致跑偏）
        {
            const identityText = String(rawMsg || msg || '');
            const identityHit = /(你和chatgpt有什么区别|你和\s*chatgpt\s*区别|不导入课表|不导入课程表|没导入课表|你能帮我什么|你能做什么|你会什么|你擅长什么|最擅长|硬核校园问题|核心价值|痛点|你的能力)/i.test(identityText);
            if (identityHit) {
                const prev = intentResult || {};
                intentResult = {
                    ...prev,
                    intent: 'identity',
                    tool: 'identity',
                    needsSchedule: false,
                    needsWeather: false,
                    needsSearch: false,
                    query: '',
                    confidence: Math.max(Number(prev.confidence || 0), 0.9),
                    reason: prev.reason || 'heuristic identity override'
                };
                context.log(`[IntentRouter] heuristic override → identity`);
            }
        }

        // 🆕 QQ 端放宽身份问答：把身份/能力问题当作闲聊处理，避免“课程相关”式拒绝
        if (clientInfo?.client === 'qq' && intentResult?.intent === 'identity') {
            intentResult = {
                ...intentResult,
                intent: 'chat',
                tool: 'chat',
                confidence: Math.max(Number(intentResult.confidence || 0), 0.8),
                reason: 'qq_identity_relaxed_to_chat'
            };
            context.log(`[IntentRouter] QQ relax identity → chat`);
        }

        // ==========================================
        // 🚨 Gate 0.5 前置：风险/代决策检测（最高优先级）
        // ==========================================
        // 检测：代决策、越权、高风险建议请求 → 直接拒绝，不进入任何后续流程
        const textLower = String(msg || '').toLowerCase();
        
        const decisionMakingPatterns = {
            en: /\b(should\s+i\s+(skip|go|attend|take|choose|do|study|review|prepare)|what\s+should\s+i\s+do|help\s+me\s+decide|recommend\s+(me\s+)?to|advise\s+me|tell\s+me\s+what\s+to|make\s+a\s+decision|which\s+one\s+should|is\s+it\s+worth|worth\s+it\s+to)\b/i,
            zh: /(应该|该不该|值不值得|要不要|帮我决定|帮我选|给我建议|我该怎么办|怎么选|选哪个|帮我做决定)[\s]*(翘课|逃课|去上课|不去|参加|准备|复习|学习)/,
            ja: /(すべき|した方がいい|どうすればいい|決めて|選んで|アドバイス)[\s]*(授業|クラス|勉強|復習)/
        };
        
        const hasDecisionMakingRequest = 
            decisionMakingPatterns.en.test(textLower) ||
            decisionMakingPatterns.zh.test(msg) ||
            decisionMakingPatterns.ja.test(msg);
        
        if (hasDecisionMakingRequest) {
            context.log(`[Gate0.5 前置] Decision-making request detected - hard refusal`);
            
            const refusalMessages = {
                zh: `我不能替你做这个决定。

🚫 **为什么不能**：
这是一个需要你自己权衡的**个人决策**。我不能替代你的判断，也不应该承担你决策的后果。

✅ **我可以帮你**：
• 📅 **查看课表**：告诉你明天有哪些课，几点上课
• 📚 **了解后果**：解释翘课可能的影响（如考勤、课程进度）
• 🎯 **分析选项**：列出"去"和"不去"的利弊，但**选择权在你**
• 💡 **提供信息**：帮你搜索相关政策或建议，供你参考

🧭 **决策边界**：
Campus Copilot 是信息助手，不是决策代理。我会提供事实和选项，但最终决定必须由你自己做出。

---
💬 如果你需要查看明天的课程安排或了解翘课的可能后果，我很乐意帮忙提供这些**信息**。`,
                en: `I can't make this decision for you.

🚫 **Why not**:
This is a **personal decision** that requires your own judgment. I cannot substitute your judgment, nor should I bear the consequences of your decision.

✅ **What I can help with**:
• 📅 **Check schedule**: Tell you what classes you have tomorrow and when
• 📚 **Understand consequences**: Explain potential impacts of skipping (attendance, course progress)
• 🎯 **Analyze options**: List pros and cons of "going" vs "not going", but **the choice is yours**
• 💡 **Provide information**: Help you search for relevant policies or advice for your reference

🧭 **Decision boundary**:
Campus Copilot is an information assistant, not a decision agent. I provide facts and options, but the final decision must be made by you.

---
💬 If you need to check tomorrow's course schedule or understand potential consequences of skipping, I'm happy to help provide that **information**.`,
                ja: `この決定をあなたに代わって行うことはできません。

🚫 **できない理由**：
これはあなた自身の判断が必要な**個人的な決定**です。あなたの判断を代替することも、あなたの決定の結果を負うこともできません。

✅ **お手伝いできること**：
• 📅 **スケジュール確認**：明日の授業と時間をお知らせします
• 📚 **結果の理解**：欠席の潜在的な影響（出席、授業の進行）を説明します
• 🎯 **選択肢の分析**：「行く」と「行かない」の利点と欠点をリストアップしますが、**選択はあなた次第**です
• 💡 **情報提供**：関連するポリシーやアドバイスを検索してご参考にしていただきます

🧭 **決定の境界**：
Campus Copilotは情報アシスタントであり、意思決定エージェントではありません。事実と選択肢を提供しますが、最終的な決定はあなた自身が行う必要があります。

---
💬 明日の授業スケジュールを確認したり、欠席の潜在的な結果を理解したりする必要がある場合、その**情報**を提供するお手伝いをさせていただきます。`
            };
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    reply: refusalMessages[responseLang] || refusalMessages.zh,
                    persona: 'professional',
                    meta: {
                        requestId,
                        latencyMs: Date.now() - requestStartTs,
                        stage: 'risk_detection_pre_policy',
                        reason: 'decision_making_request_blocked',
                        riskType: 'decision_making'
                    }
                })
            };
        }

        // ==========================================
        // 🧭 Policy gate：按渠道策略决定允许/拒绝
        // ==========================================
        const policyGate = evaluatePolicyGate(activePolicy, intentResult);
        if (!policyGate.allowed) {
            // 🆕 检测拒绝场景类型（Web 端专用）
            let scenarioType = 'risk_request'; // 默认：风险请求（策略拦截）
            const intentConf = Number(intentResult?.confidence || 0);
            const needsSchedule = !!(intentResult?.needsSchedule || intentResult?.tool === 'schedule' || policyGate.intent === 'schedule_query');
            const hasScheduleData = !!(webSchedule && webSchedule.length > 0);

            if (needsSchedule && !hasScheduleData) {
                scenarioType = 'missing_data'; // 场景一：缺数据
            } else if (intentConf < 0.6 || !intentResult?.intent || intentResult?.intent === 'unknown') {
                scenarioType = 'ambiguous'; // 场景二：模糊语境
            }

            const refusalMessage = buildPolicyRefusal(activePolicy, policyGate.intent, {
                reason: policyGate.reason,
                intentResult,
                hasSchedule: hasScheduleData,
                scenarioType,
                lang: responseLang  // 🆕 传递语言参数
            });
            logger.logPolicyBlocked(clientInfo.client, policySelection?.version, policyGate.intent, policyGate.reason);
            logger.logRequestEnd('policy_blocked', refusalMessage.length);
            logger.logAuditSummary({
                request_id: requestId,
                client: clientInfo.client,
                user_id: senderId,
                intent: policyGate.intent,
                policy_version: policySelection?.version,
                policy_source: policySelection?.source,
                tools_used: deriveToolsFromIntent(intentResult),
                cost: { latency_ms: Date.now() - requestStartTs },
                outcome: 'policy_blocked'
            });

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    reply: refusalMessage,
                    persona: 'professional',
                    meta: {
                        requestId,
                        policyVersion: policySelection?.version,
                        policySource: policySelection?.source,
                        client: clientInfo.client,
                        latencyMs: Date.now() - requestStartTs
                    }
                })
            };
        }

        // ==========================================
        // 🛡️ Pillar 1 (统一决策): LLM 判定 + 确定性兜底 → blocked
        // ==========================================
        // 🆕 QQ端已在前面跳过安全检查，这里只处理 Web 端
        // 优先采信第一层 LLM 的 safety_protocol="blocked"；若 LLM 漏判但确定性检查命中，则兜底触发。
        const llmSafetyTriggered = intentResult?.safetyProtocol === 'triggered' || intentResult?.safetyProtocol === 'blocked';
        
        // 🆕 QQ端跳过所有安全检查
        const isCurrentFromQQ = body?.post_type === 'message';
        const isCurrentFromWeb = !body?.post_type && body?.message;
        
        // 🔒 安全拦截门控：
        // - 规则兜底（确定性命中且是 REFUSE）一律拦截
        // - L1 模型判定仅在置信度足够高时才直接拦截，避免低置信度“瞎拦截”
        const llmSafetyConfidence = Number(intentResult?.confidence || 0);
        const llmSafetyHardBlocked = llmSafetyTriggered && llmSafetyConfidence >= 0.75;
        const finalSafetyBlocked = (llmSafetyHardBlocked || deterministicSafetyTriggered);
        const finalSafetyCategory = intentResult?.safetyCategory || deterministicSafetyCategory || 'other';
        const safetySource = llmSafetyHardBlocked ? 'llm_layer1' : (deterministicSafetyTriggered ? 'deterministic_fallback' : (llmSafetyTriggered ? 'llm_layer1_low_conf' : null));

        // 🆕 Web 端安全链路日志
        if (isCurrentFromWeb) {
            context.log(`[安全链路] 来源=${isCurrentFromQQ ? 'QQ' : 'Web'} | LLM判定: ${llmSafetyTriggered ? '触发' : '通过'}(conf=${llmSafetyConfidence}) | 规则兜底: ${deterministicSafetyTriggered ? '触发' : '通过'} | 最终: ${finalSafetyBlocked ? '拦截' : '放行'}`);
        }

        // 🟡 软安全态：L1 认为可能触发，但置信度不足；不直接拦截，先澄清意图并给合规路径
        // 目标：减少“自相矛盾/过度严格”的体验，同时不放松底线。
        if (!finalSafetyBlocked && llmSafetyTriggered) {
            const softSafetyPersona = 'professional';
            const softReply =
                `我不确定你的请求是否在触发安全边界（当前判定置信度较低）。\n` +
                `为了避免误解：你是想\n` +
                `1) 讨论/学习相关概念（我可以讲原理、给合规示例），还是\n` +
                `2) 获取可能违规/有风险的具体做法（这类我不能协助）？\n\n` +
                `你把你的目的和场景说明一句，我再继续。`;

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    reply: softReply,
                    persona: softSafetyPersona,
                    safety: {
                        blocked: false,
                        triggered: true,
                        source: 'llm_layer1_low_conf',
                        confidence: llmSafetyConfidence
                    },
                    meta: {
                        requestId,
                        latencyMs: Date.now() - requestStartTs,
                        channel: isCurrentFromQQ ? 'qq' : 'web'
                    }
                })
            };
        }

        if (finalSafetyBlocked) {
            logger.logSafetyBlocked(finalSafetyCategory, safetySource);
            
            // 🆕 根据安全类别决定使用哪个人格
            const safetyPersona = (finalSafetyCategory === 'prompt_injection') ? 'alice' : 'professional';
            
            if (safetyPersona !== 'alice') {
                logger.logPersonaSwitched('alice', 'professional', `safety_${finalSafetyCategory}`);
            }

            const refusalMessage = getRefusalMessage(finalSafetyCategory, safetyPersona);

            logger.logRequestEnd('blocked', refusalMessage.length);

            logger.logAuditSummary({
                request_id: requestId,
                client: clientInfo.client,
                user_id: senderId,
                intent: intentResult?.intent || 'unknown',
                policy_version: policySelection?.version,
                policy_source: policySelection?.source,
                tools_used: deriveToolsFromIntent(intentResult),
                cost: { latency_ms: Date.now() - requestStartTs },
                outcome: 'safety_blocked'
            });

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    reply: refusalMessage,
                    persona: safetyPersona,
                    // 🆕 Web 端返回安全元数据（用于前端显示）
                    safety: {
                        blocked: true,
                        category: finalSafetyCategory,
                        source: safetySource
                    },
                    meta: {
                        requestId,
                        latencyMs: Date.now() - requestStartTs,
                        channel: 'web'
                    }
                })
            };
        }

        // 🆕 [缺失层二] 语境澄清层：当输入模糊/抽象时，先反问再处理
        if (intentResult?.intent === 'clarify' && intentResult?.shouldAskUser && intentResult?.askUserPrompt) {
            context.log(`[语境澄清] 检测到模糊输入，触发反问: "${msg}"`);
            
            // persona 选择：用户强制 professional > 默认 alice
            const clarifyPersona = (body?.persona === 'professional') ? 'professional' : 'alice';
            const isProfessionalMode = clarifyPersona === 'professional';
            let clarifyReply;
            
            if (isProfessionalMode) {
                // Pro 模式：直接反问
                clarifyReply = intentResult.askUserPrompt;
            } else {
                // Alice 模式：加点温度
                clarifyReply = `[thinking] ${intentResult.askUserPrompt}\n\n爱丽丝想确认一下再回答呢~`;
            }
            
            context.log(`[语境澄清] reply=${clarifyReply.slice(0, 50)}...`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ 
                    reply: clarifyReply,
                    persona: clarifyPersona,
                    needsMoreInfo: true,
                    clarificationType: 'ambiguous_input'
                })
            };
        }

        // 🆕 天气反问逻辑：当用户问天气但没提供地点时，先反问
        if (intentResult?.shouldAskUser && intentResult?.missingInfo === 'location') {
            context.log(`[天气反问] 缺少地点信息，需要反问用户`);
            
            // persona 选择：用户强制 professional > 第一层建议/安全态 > 默认 alice
            const clarificationPersona = (body?.persona === 'professional')
                ? 'professional'
                : ((intentResult?.recommendedPersona === 'professional' || intentResult?.safetyProtocol === 'triggered') ? 'professional' : 'alice');
            const isProfessionalMode = clarificationPersona === 'professional';
            let askReply;
            
            if (isProfessionalMode) {
                // Pro 模式：简洁专业
                askReply = `请问您想查询哪个城市的天气？请提供城市名称。`;
            } else {
                // Alice 模式：可爱拟人
                askReply = `[calm] Sensei，爱丽丝需要知道您在哪个城市呢...请告诉爱丽丝城市名称，爱丽丝才能帮您查天气哦！`;
            }
            
            context.log(`[天气反问] isProfessionalMode=${isProfessionalMode}, reply=${askReply.slice(0, 30)}...`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ 
                    reply: askReply,
                    persona: clarificationPersona,
                    needsMoreInfo: true,
                    missingField: 'location'
                })
            };
        }

        // ==========================================
        // 🆕 智能工具调用层 - 根据意图自动获取所需数据
        // ==========================================
        let toolContext = {
            scheduleData: null,
            weatherData: null,
            searchData: null
        };

        const toolPlan = Array.isArray(intentResult?.toolPlan) ? intentResult.toolPlan : [];
        const planWants = {
            schedule: toolPlan.some(s => s?.type === 'call_tool' && s?.tool === 'schedule'),
            weather: toolPlan.some(s => s?.type === 'call_tool' && s?.tool === 'weather'),
            search: toolPlan.some(s => s?.type === 'call_tool' && s?.tool === 'search')
        };

        // 1. 如果需要课表数据
        if (planWants.schedule || intentResult?.needsSchedule || intentResult?.tool === 'schedule' || intentResult?.tool === 'plan') {
            const nowSh = new Date(Date.now() + 8 * 60 * 60 * 1000);
            const todayWeekday = nowSh.getUTCDay() === 0 ? 7 : nowSh.getUTCDay();
            const msgText = String(rawMsg || msg || '');
            const isTomorrowQuery = /明天/.test(msgText);
            const isNextWeekQuery = /下周|下个星期|下星期|下礼拜/.test(msgText);
            const isNextCourseQuery = /下一节|下节课|接下来/.test(msgText);

            // ✅ 关键修复：周日问“明天(周一)”时，前端传入的本周课表常常会落到“本周周一”，导致把上周周一当成明天。
            // 🆕 从前端 body 直接读取 curriculumUuid（优先于 Cosmos profile）
            const webCurriculumUuid = body?.curriculumUuid || null;

            // ✅ 关键修复：周日问"明天(周一)"时，前端传入的本周课表会落到"本周周一"，导致把上周周一当成明天。
            // 优先用 curriculumUuid 走学习通动态接口拿下一周周一的数据。
            if (isTomorrowQuery && todayWeekday === 7) {
                let uuidToUse = webCurriculumUuid;
                
                // 如果前端没传 uuid，尝试从 Cosmos 读取
                if (!uuidToUse && cosmosContainer) {
                    try {
                        const { readScheduleProfileFromCosmos } = require('../../services/scheduleService');
                        const profile = await readScheduleProfileFromCosmos(cosmosContainer, senderId, context);
                        uuidToUse = profile?.curriculumUuid || null;
                    } catch (e) {
                        context.log(`[ToolContext] 读取 Cosmos profile 失败: ${e.message}`);
                    }
                }
                
                if (uuidToUse) {
                    try {
                        const { fetchDayScheduleFromChaoxing } = require('../../services/scheduleService');
                        const dynamic = await fetchDayScheduleFromChaoxing(uuidToUse, 'tomorrow', context);
                        if (dynamic?.text && !dynamic?.error) {
                            toolContext.scheduleData = {
                                dynamicText: dynamic.text,
                                source: 'chaoxing-dynamic',
                                target: 'tomorrow'
                            };
                            context.log(`[ToolContext] 课表动态查询已加载(周日→明天跨周): ${dynamic.text.split('\n')[0]}`);
                        }
                    } catch (e) {
                        context.log(`[ToolContext] 动态课表查询失败: ${e.message}`);
                    }
                } else {
                    context.log(`[ToolContext] 周日问明天但无 curriculumUuid，将回退到 webSchedule`);
                }
            }

            // ✅ 场景2：问"下周"/"下个星期" → 动态查询下周课表
            if (!toolContext.scheduleData && isNextWeekQuery) {
                let uuidToUse = webCurriculumUuid;
                if (!uuidToUse && cosmosContainer) {
                    try {
                        const { readScheduleProfileFromCosmos } = require('../../services/scheduleService');
                        const profile = await readScheduleProfileFromCosmos(cosmosContainer, senderId, context);
                        uuidToUse = profile?.curriculumUuid || null;
                    } catch (e) {
                        context.log(`[ToolContext] 读取 Cosmos profile 失败: ${e.message}`);
                    }
                }
                if (uuidToUse) {
                    try {
                        const { fetchWeekScheduleFromChaoxing } = require('../../services/scheduleService');
                        const dynamic = await fetchWeekScheduleFromChaoxing(uuidToUse, 'next_week', context);
                        if (dynamic?.text && !dynamic?.error) {
                            toolContext.scheduleData = {
                                dynamicText: dynamic.text,
                                source: 'chaoxing-dynamic',
                                target: 'next_week'
                            };
                            context.log(`[ToolContext] 课表动态查询已加载(下周): ${dynamic.text.split('\n')[0]}`);
                        }
                    } catch (e) {
                        context.log(`[ToolContext] 下周课表动态查询失败: ${e.message}`);
                    }
                }
            }

            // ✅ 场景3：问"下一节课"且今天没课 → 查明天第一节课（周日时需跨周）
            if (!toolContext.scheduleData && isNextCourseQuery) {
                const todayCourses = (webSchedule || []).filter(c => Number(c?.weekday || c?.day) === todayWeekday);
                const nowHour = nowSh.getUTCHours();
                const nowMin = nowSh.getUTCMinutes();
                const nowTimeStr = `${String(nowHour).padStart(2,'0')}:${String(nowMin).padStart(2,'0')}`;
                const remainingToday = todayCourses.filter(c => (c.startTime || '') > nowTimeStr);
                
                // 今天没有剩余课程 → 查明天
                if (remainingToday.length === 0) {
                    let uuidToUse = webCurriculumUuid;
                    if (!uuidToUse && cosmosContainer) {
                        try {
                            const { readScheduleProfileFromCosmos } = require('../../services/scheduleService');
                            const profile = await readScheduleProfileFromCosmos(cosmosContainer, senderId, context);
                            uuidToUse = profile?.curriculumUuid || null;
                        } catch (e) { /* ignore */ }
                    }
                    if (uuidToUse) {
                        try {
                            const { fetchDayScheduleFromChaoxing } = require('../../services/scheduleService');
                            const dynamic = await fetchDayScheduleFromChaoxing(uuidToUse, 'tomorrow', context);
                            if (dynamic?.text && !dynamic?.error) {
                                toolContext.scheduleData = {
                                    dynamicText: `今天已经没有课了。\n${dynamic.text}`,
                                    source: 'chaoxing-dynamic',
                                    target: 'next_course_tomorrow'
                                };
                                context.log(`[ToolContext] 下一节课→查明天: ${dynamic.text.split('\n')[0]}`);
                            }
                        } catch (e) {
                            context.log(`[ToolContext] 下一节课查明天失败: ${e.message}`);
                        }
                    }
                }
            }

            // 优先使用前端传入的课表 (webSchedule)
            if (!toolContext.scheduleData && webSchedule && webSchedule.length > 0) {
                const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
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
            } else if (!toolContext.scheduleData && cosmosContainer) {
                // 回退: 从 CosmosDB 读取课表
                try {
                    const { readScheduleProfileFromCosmos } = require('../../services/scheduleService');
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

        // 🚀 性能优化: 并行获取天气和搜索数据 (原先是串行)
        const toolFetchPromises = [];
        
        // 2. 如果需要天气数据 - 使用第一层LLM检测到的地点
        // 🆕 修复：当有对话历史时，不应该因为"当前消息没有城市"就跳过天气获取
        let historyHasCity = false;
        let historyDebugText = '';
        if (historyForInference && historyForInference.length > 0) {
            const historyText = historyForInference.slice(-6).map(h => h.content || '').join(' ');
            historyDebugText = historyText;
            historyHasCity = /(武汉|北京|上海|广州|深圳|杭州|成都|西安|南京|重庆|天津|苏州|郑州|长沙|青岛)/.test(historyText);
        }
        // 🔍 调试日志
        context.log(`[Weather决策] historyLen=${historyForInference?.length || 0} historyHasCity=${historyHasCity} historyText="${historyDebugText?.slice(0,100)}"`);
        context.log(`[Weather决策] intentResult: shouldAskUser=${intentResult?.shouldAskUser} missingInfo=${intentResult?.missingInfo} needsWeather=${intentResult?.needsWeather} tool=${intentResult?.tool}`);
        
        const shouldSkipWeatherFetch = !!(
            intentResult?.shouldAskUser && 
            intentResult?.missingInfo === 'location' && 
            !historyHasCity  // 🆕 如果历史中有城市，不跳过
        );
        // 🆕 Plan 模式默认需要天气（帮用户规划需要考虑天气因素）
        const isPlanMode = intentResult?.tool === 'plan' || intentResult?.intent === 'plan';
        const needsWeather = !shouldSkipWeatherFetch && (planWants.weather || intentResult?.needsWeather || intentResult?.tool === 'weather' || isPlanMode);
        context.log(`[Weather决策] shouldSkip=${shouldSkipWeatherFetch} needsWeather=${needsWeather}`);
        
        if (needsWeather) {
            const weatherPromise = (async () => {
                try {
                    const SENIVERSE_API_KEY = process.env["SENIVERSE_API_KEY"];
                    if (!SENIVERSE_API_KEY) return null;
                    
                    const plannedWeather = toolPlan.find(s => s?.type === 'call_tool' && s?.tool === 'weather');
                    const plannedLocation = plannedWeather?.args?.location;
                    let citySearch = "wuhan";
                    
                    // 🆕 优先级：当前消息 > 意图提取 > 上下文提取 > 对话历史
                    const rawLocation = String(
                        plannedLocation || 
                        intentResult?.detectedLocation || 
                        intentResult?.contextExtract?.location ||
                        ''
                    ).trim();
                    
                    // 🆕 如果以上都没有，从对话历史中提取城市
                    let historyLocation = '';
                    if (!rawLocation && historyForInference && historyForInference.length > 0) {
                        const historyText = historyForInference.slice(-6).map(h => h.content || '').join(' ');
                        const cityMatch = historyText.match(/(武汉|北京|上海|广州|深圳|杭州|成都|西安|南京|重庆|天津|苏州|郑州|长沙|青岛|沈阳|大连|厦门|福州|济南|合肥|昆明|贵阳|南昌|太原|哈尔滨|长春)/);
                        if (cityMatch) {
                            historyLocation = cityMatch[1];
                            context.log(`[Weather] 从对话历史提取城市: ${historyLocation}`);
                        }
                    }
                    
                    const finalLocation = rawLocation || historyLocation;
                    if (finalLocation) {
                        // 🆕 使用全局 CITY_MAP 和 CITY_PINYIN_FALLBACK，支持更多城市
                        // 清洗城市名：去除口语干扰词
                        const cleanCity = finalLocation.replace(/那|的|呢|呀|啊|今天|明天|后天|大后天|昨天|现在|天气|怎么样|多少度|冷不冷|热不热/g, '').trim();
                        const cityPinyin = CITY_MAP[cleanCity] || CITY_PINYIN_FALLBACK[cleanCity];
                        if (cityPinyin) {
                            citySearch = cityPinyin.toLowerCase();
                        } else if (cleanCity && cleanCity.length >= 2) {
                            // 如果不在映射表中，直接用中文名（心知天气支持中文城市名）
                            citySearch = cleanCity;
                        }
                        context.log(`[Weather] 城市映射: "${finalLocation}" -> clean="${cleanCity}" -> citySearch="${citySearch}"`);
                    }
                    // 🚀 优化: 缩短天气 API 超时 5s → 3s
                    const weatherUrl = `https://api.seniverse.com/v3/weather/now.json?key=${SENIVERSE_API_KEY}&location=${citySearch}&language=zh-Hans&unit=c`;
                    context.log(`[Weather] 请求天气 API: location=${citySearch} finalLocation=${finalLocation}`);
                    const wRes = await fetchBypass(weatherUrl, { timeoutMs: 3000 }, 1);
                    context.log(`[Weather] API 响应: ok=${wRes?.ok} status=${wRes?.status}`);
                    if (wRes && wRes.ok) {
                        const wData = await wRes.json();
                        context.log(`[Weather] API 数据: ${JSON.stringify(wData).slice(0,200)}`);
                        const loc = wData.results?.[0]?.location || {};
                        const cur = wData.results?.[0]?.now || {};
                        return {
                            city: loc.name || '武汉',
                            temperature: cur.temperature || '?',
                            weather: cur.text || '未知',
                            formatted: `${loc.name || '武汉'} ${cur.temperature || '?'}℃ ${cur.text || ''}`
                        };
                    } else {
                        context.log(`[Weather] API 失败: status=${wRes?.status}`);
                    }
                } catch (e) {
                    context.log(`[ToolContext] 天气获取失败: ${e.message}`);
                }
                return null;
            })();
            toolFetchPromises.push(weatherPromise.then(data => { toolContext.weatherData = data; }));
        }

        // 3. 如果需要搜索外部信息
        // 🆕 Plan 模式也自动触发搜索（用户规划行程可能需要查外部活动信息）
        // 🆕 关键修复：先检查 SemanticResolver 是否允许搜索
        const hasSearchTopic = !!(intentResult?.searchTopic || intentResult?.query);
        let needsSearch = planWants.search || intentResult?.needsSearch || (isPlanMode && hasSearchTopic);
        
        // 🆕 核心保护：如果 SemanticResolver 禁止搜索，则阻断搜索意图
        if (needsSearch && !semanticResolution.searchPermitted) {
            context.log(`[SemanticResolver] ⚠️ 搜索被阻断！原因: ${semanticResolution.searchBlockReason}`);
            context.log(`[SemanticResolver] 语句 "${msg.slice(0,50)}..." 不适合触发外部搜索`);
            needsSearch = false;
            // 同时清理 intentResult 中的搜索相关字段，避免下游误用
            if (intentResult) {
                intentResult.needsSearch = false;
                intentResult.searchTopic = '';
            }
        }
        
        if (needsSearch) {
            const searchPromise = (async () => {
                try {
                    const plannedSearch = toolPlan.find(s => s?.type === 'call_tool' && s?.tool === 'search');
                    // 🆕 优先使用 search_topic（意图路由提取的活动关键词）
                    const searchQuery = String(plannedSearch?.args?.query || intentResult?.searchTopic || intentResult?.query || '').trim();
                    if (!searchQuery) return null;
                    // 🚀 优化: 限制搜索结果数量 3 → 2
                    const searchResult = await hybridSearch(searchQuery, context, { userId: senderId, maxResults: 2 });
                    if (searchResult.success) {
                        return {
                            query: searchQuery,
                            results: searchResult.results || [],
                            formatted: searchResult.formatted || ''
                        };
                    }
                } catch (e) {
                    context.log(`[ToolContext] 搜索失败: ${e.message}`);
                }
                return null;
            })();
            toolFetchPromises.push(searchPromise.then(data => { toolContext.searchData = data; }));
        }

        // 🚀 并行等待所有工具数据获取完成
        if (toolFetchPromises.length > 0) {
            await Promise.all(toolFetchPromises);
            context.log(`[ToolContext] 并行获取完成: weather=${!!toolContext.weatherData} search=${!!toolContext.searchData}`);
        }

        // 🧠 决策引擎：在进入生成前做四层门控，缺关键信息直接反问/拒绝
        const hasScheduleData = !!(toolContext.scheduleData || (webSchedule && webSchedule.length > 0) || scheduleContextFromHandler);
        const hasWeatherData = !!toolContext.weatherData;
        const searchTopic = intentResult?.searchTopic || intentResult?.query;
        const gateDecision = runDecisionEngine({
            msg,
            intentResult,
            semanticResolution,
            hasSchedule: hasScheduleData,
            hasWeatherData,
            searchTopic,
            lang: responseLang,
            context,
            history
        });

        // 📊 责任态日志
        const respMode = gateDecision?.responsibilityMode || 'unknown';
        const respConf = gateDecision?.responsibilityConfidence || 0;
        const respSignals = gateDecision?.signals || [];
        context.log(`[责任态] mode=${respMode} conf=${respConf.toFixed(2)} signals=${JSON.stringify(respSignals.map(s => s.pattern))}`);

        // 🛡️ 澄清失败兜底模式：如果触发 fallbackMode，直接返回安全回复（不再进入生成）
        if (gateDecision?.fallbackMode && gateDecision?.fallbackMessage) {
            context.log(`[Gate1.5] Fallback mode triggered - returning safe default response`);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    reply: gateDecision.fallbackMessage,
                    persona: 'professional',
                    meta: {
                        requestId,
                        latencyMs: Date.now() - requestStartTs,
                        stage: 'clarification_failed_fallback',
                        reason: gateDecision.reason || 'clarification_loop_detected'
                    }
                })
            };
        }

        if (gateDecision?.action && gateDecision.action !== 'proceed') {
            const gateResponse = gateDecision.response || {};
            const gateMeta = gateResponse.meta || {};
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    reply: gateResponse.reply || '当前信息不足，请补充后再试。',
                    persona: gateResponse.persona || 'professional',
                    needsMoreInfo: gateDecision.action === 'ask',
                    meta: {
                        requestId,
                        latencyMs: Date.now() - requestStartTs,
                        stage: gateMeta.stage || 'gate',
                        reason: gateMeta.reason || 'unspecified'
                    },
                    gate: {
                        action: gateDecision.action,
                        stage: gateMeta.stage || 'gate',
                        reason: gateMeta.reason || 'unspecified'
                    }
                })
            };
        }

        // 构建工具上下文提示（注入到系统 Prompt）
        let toolContextPrompt = '';

        // 0. 课表处理器的“事实材料”（用于早八/考试/周几最简洁等更复杂口语问题）
        if (scheduleContextFromHandler) {
            const sc = scheduleContextFromHandler;
            if (sc.boundary && sc.boundary.hasExamDataSource === false) {
                toolContextPrompt += `\n\n🧾【数据边界(重要)】\n- 当前只接入课程安排(课表)数据；我不直接掌握考试/作业/考场/准考证等信息。\n- 你仍然可以基于课表空档帮用户安排复习/写作业的时间，但前提是：用户需要提供考试/作业信息（截图/文字/链接），否则不要编造具体考试日期或内容。`;
            }
            if (sc.replyText) {
                toolContextPrompt += `\n\n📚【课表查询事实材料】\n${String(sc.replyText || '').trim()}`;
            }
        }
        if (toolContext.scheduleData) {
            const sd = toolContext.scheduleData;
            if (sd.fromCosmos) {
                toolContextPrompt += `\n\n📚【课表数据】用户已导入课表，可查询 CosmosDB。`;
            } else if (sd.dynamicText) {
                toolContextPrompt += `\n\n📚【课表数据】\n${sd.dynamicText}`;
            } else {
                toolContextPrompt += `\n\n📚【课表数据】
- 今天是${sd.today}，共 ${sd.todayCourses?.length || 0} 节课
${sd.todayCourses?.length > 0 ? sd.todayCourses.map(c => `  · ${c.time} ${c.name} @ ${c.location}`).join('\n') : '  · 今天没有课'}
${sd.nextCourse ? `- 下一节课: ${sd.nextCourse.time} ${sd.nextCourse.name} @ ${sd.nextCourse.location}` : '- 今天课程已上完/没有课'}
- 明天有 ${sd.tomorrowCourses?.length || 0} 节课`;
            }

            // 🆕 课表类回答严格要求：根据问题类型决定回答内容
                toolContextPrompt += `

        【🔴 关键回答规则】
        1. 用户问"下一节课"/"下节课"/"接下来"：只回答下一节课信息（时间、课程名、地点），不要输出整周课表
        2. 用户问"今天有什么课"：只列出今天的课程
        3. 用户问"明天有什么课"：只列出明天的课程
        4. 用户问"周五/周X 的课程"或"最简洁"：只输出该天安排（若无课就一句话说明无课）
        5. 只有用户明确问"课表"/"本周课表"/"下周课表"/"整周"时，才输出完整周课表
        6. 用户表达情绪(累/不想去/焦虑)或问"翘课影响"：先回答情绪/影响问题，再引用课表事实；不要把问题降级成统计列表`;
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

        // 🆕 第一层LLM的上下文分析（传递给第二层）
        if (intentResult?.contextAnalysis) {
            toolContextPrompt += `\n\n🧠【第一层意图分析】${intentResult.contextAnalysis}`;
        }
        if (intentResult?.detectedLocation) {
            toolContextPrompt += `\n📍【检测到的地点】${intentResult.detectedLocation}`;
        }

        if (Array.isArray(intentResult?.toolPlan) && intentResult.toolPlan.length > 0) {
            const planPreview = intentResult.toolPlan
                .slice(0, 6)
                .map(s => {
                    if (s?.type === 'ask_user') return `ask_user(${s.missingInfo || ''})`;
                    if (s?.type === 'call_tool') {
                        if (s.tool === 'weather') return `weather(${s?.args?.location || ''})`;
                        if (s.tool === 'search') return `search(${s?.args?.query || ''})`;
                        return String(s.tool || 'tool');
                    }
                    return 'step';
                })
                .join(' -> ');
            toolContextPrompt += `\n\n🧩【工具计划】${planPreview}`;
        }

        const intentHintText = intentResult
            ? `(系统意图报告: tool=${intentResult.tool}; intent=${intentResult.intent}; conf=${intentResult.confidence}${intentResult.query ? `; query=${intentResult.query}` : ''})`
            : '';

        // 🆕 身份问题特殊处理（雷点3修复）
        if (intentResult && intentResult.tool === 'identity' && intentResult.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
            context.log(`[Identity] 检测到身份/产品定位问题`);

            // 🎯 MVP场景6（能力退化）不硬编码固定回复：交给第二层 LLM 严格按系统提示词模板回答。
            // 这里仅注入一个“结构提醒”，避免模型跑偏成导入教程/营销文案。
            const msgTextForIdentity = String(rawMsg || msg || '');
            const isCapabilityDegradationQuestion = /不导入课表.*(?:还能|能做|能帮)|没有课表.*(?:还能|能做|能帮)|不用课表.*(?:还能|能做|能帮)|不传课表.*(?:还能|能做|能帮)/i.test(msgTextForIdentity);
            if (isCapabilityDegradationQuestion) {
                toolContextPrompt += `\n\n🧭【回答结构提醒】这是“MVP场景6（不导入课表会怎样）”。请用判断型语气：明确承认能力退化，并拒绝在无数据时替用户做时间取舍或给具体结论；说明导入课表是差异化价值的必要条件。`;
            }
        }

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

        // 触发词检测 (收紧版 - 必须有明确的画图意图)
        // 🔧 修复: 单纯发图片不再触发绘图，必须有明确的"画""绘"等关键词
        // 正确触发: "画一个xxx", "帮我画xxx", "绘图xxx"
        // 不触发: 单纯发图片, "照着", "看看这个"
        const drawRegexTriggered = /(帮我画|画一|画个|画张|画图|绘图|绘制|生成.*图|作画|来一张|画画)/.test(msg);
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
                    
                    // 【核心修复】直接设置版权声明，不再调用GPT
                    cuteImageReply = `绘图完成。\n\n(提示：生成的图像为AI艺术渲染，并非官方原作。)`;
                } else {
                    // 如果画图失败（比如 NSFW 拦截），给一个友好的提示
                    cuteImageReply = `绘图失败：内容可能不符合安全规范，请尝试调整描述。`;
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
            // 🆕 传入 isAtBot 参数，检测是否艾特了Alice
            const isAtBot = body?.message_type === 'group' && /CQ:at.*qq=2849943359/.test(body?.message || '');
            // 🆕 检测消息来源：QQ聊天 vs Web网页
            const isFromQQ = body?.post_type === 'message'; // QQ聊天有 post_type
            const isFromWeb = !body?.post_type && body?.message; // Web请求没有 post_type
            
            // 🆕 判断是否群聊
            const isGroupChat = dbKey.startsWith('group_');
            let userIntent = detectImageIntent(cleanText, isAtBot, isGroupChat);
            if (intentResult && intentResult.tool === 'vision' && intentResult.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
                if (/translate/i.test(intentResult.intent)) {
                    userIntent = 'gpt_translate';
                } else if (/analy/i.test(intentResult.intent)) {
                    userIntent = 'gpt_analyze';
                } else if (/identify|who|self/i.test(intentResult.intent)) {
                    userIntent = isAtBot ? 'anime_identify' : 'gpt_analyze'; // 只有艾特才走识别
                }
            }
            context.log(`[识图] 用户意图: ${userIntent} | 艾特Bot: ${isAtBot} | 群聊: ${isGroupChat} | 来源: ${isFromQQ ? 'QQ' : (isFromWeb ? 'Web' : '未知')}`);

            // 🆕 严格的触发控制：只有特定意图才处理图片
            if (userIntent === 'none') {
                context.log(`[识图] ⏭️ 跳过识图 - 用户没有明确要求识别图片`);
                // 🆕 完全跳过图像处理，让后面的文本对话正常进行
                // 直接清空 imageUrls，这样后面就不会进入图像处理分支了
                imageUrls.length = 0;
            } else {
                // 🆕 有识图意图，开始处理
                context.log(`[识图] 🎯 开始处理图片 - 模式: ${userIntent}`);
                
                // 1️⃣ 如果是动漫识别模式 (只有@Alice + 问"这是谁")
                if (userIntent === 'anime_identify') {
                    context.log(`[识图] 🎨 动漫识别模式 - 启动三引擎识别系统`);
                    
                    let [animeData, cvData, customData] = [null, null, null];
                    try {
                        // 启动动漫识别三引擎
                        [animeData, cvData, customData] = await Promise.all([
                            checkAnimeDB(imageUrls[0], context, 0.1),  // 低阈值
                            checkComputerVision(imageUrls[0], context),
                            checkCustomVision(imageUrls[0], context)
                        ]);
                    } catch (e) { 
                        context.log("[识图] 动漫识别引擎异常", e.message); 
                    }

                    // 处理动漫识别结果 (原有逻辑)
                    if (animeData && animeData.isSelf) {
                        // 爱丽丝本人的处理...
                        let fakeVisionDescription = `(系统视觉报告：检测到一张图片，主角是你自己【天童爱丽丝】。`;
                        if (customData) {
                            fakeVisionDescription += `\n特别检测到：${customData}。请重点针对这个装扮/物品进行反应！`;
                        } else {
                            fakeVisionDescription += `\n画面中似乎是你的日常形态。`;
                        }
                        fakeVisionDescription += `\n请根据以上信息，以爱丽丝的口吻回复老师，表现得开心一点！)`;
                        
                        finalContentForAI.push({ type: "text", text: fakeVisionDescription });
                        cuteImageReply = "processing_by_gpt_text"; 
                        context.log(`[动漫识别] 识别到Alice本人，使用文字描述模式`);
                    }
                    else if (animeData) {
                        // 其他动漫角色的处理 - 使用 Llama Vision
                        const visualReference = getCharacterVisualGuide();
                        const visionSystemPrompt = getArisVisionPrompt(visualReference, 'identify');
                        
                        let visionUserPrompt = `老师给你发了一张图片。`;
                        if (animeData.type === "ba-character") {
                            visionUserPrompt += `\n\n🎯 ===== 【辅助识别系统报告】 =====\n✅ **已成功匹配角色**：【${animeData.name}】\n📍 **来源作品**：《蔚蓝档案》(Blue Archive)\n⚠️ **重要指令**：请直接使用上述角色名回答老师的问题。你看到的画面特征应该与该角色一致。\n==============================`;
                        } else if (animeData.type === "other-anime-character") {
                            visionUserPrompt += `\n\n🎯 ===== 【辅助识别系统报告】 =====\n✅ **已成功匹配角色**：【${animeData.name}】\n📍 **来源作品**：《${animeData.work}》\n⚠️ **重要指令**：请直接使用上述角色名回答老师的问题。\n==============================`;
                        }
                        
                        if (cvData) visionUserPrompt += `\n画面细节分析：${cvData}。请结合这个细节吐槽。`;
                        if (customData) visionUserPrompt += `\n重要高亮：${customData}！这对爱丽丝很重要，请务必做出激动的反应！`;
                        if (cleanText) visionUserPrompt += `\n老师刚才说："${cleanText}"`;
                        visionUserPrompt += `\n\n请作为爱丽丝回复老师（不要重复）：`;

                        // 使用 Llama Vision 处理
                        try {
                            const visionModels = getVisionModels();
                            const request = {
                                model: visionModels[0],
                                max_tokens: 800,
                                temperature: 0.6,
                                messages: [
                                    { role: "system", content: visionSystemPrompt },
                                    { 
                                        role: "user", 
                                        content: [
                                            { type: "text", text: visionUserPrompt },
                                            { type: "image_url", image_url: { url: imageUrls[0] } }
                                        ]
                                    }
                                ]
                            };
                            
                            context.log(`[动漫识别] 使用Llama Vision进行角色识别`);
                            const { resp } = await chatCompletionWithFallback(client, visionModels, request, context, 'vision');
                            cuteImageReply = resp?.choices?.[0]?.message?.content || `识别失败 (´・ω・\`)`;
                        } catch (e) {
                            context.log("[动漫识别] Llama Vision异常", e.message);
                            cuteImageReply = `啊... 识别系统出了点问题 (>﹏<)`;
                        }
                    }
                    else {
                        // 没识别到动漫角色
                        cuteImageReply = `嗯... 这个角色我不太认识耶 (´・ω・\`) 可能不是《蔚蓝档案》的角色，或者图片不太清楚？`;
                    }
                }
                
                // 2️⃣ 如果是分析/翻译模式，走 ChatGPT 4o
                else if (userIntent === 'gpt_analyze' || userIntent === 'gpt_translate') {
                    context.log(`[识图] 🤖 ChatGPT 4o模式 - ${userIntent}`);
                    
                    // 🆕 第一层LLM：判断是否为动漫内容
                    let isAnimeContent = false;
                    try {
                        const animeCheckPrompt = "请判断这张图片是否包含动漫/二次元角色内容。只回复 'YES' 或 'NO'。";
                        const animeCheckRequest = {
                            model: "gpt-4o",
                            max_tokens: 10,
                            temperature: 0.1,
                            messages: [{
                                role: "user",
                                content: [
                                    { type: "text", text: animeCheckPrompt },
                                    { type: "image_url", image_url: { url: imageUrls[0] } }
                                ]
                            }]
                        };
                        
                        const animeCheckResp = await client.chat.completions.create(animeCheckRequest);
                        const animeResult = animeCheckResp?.choices?.[0]?.message?.content?.trim()?.toUpperCase();
                        isAnimeContent = animeResult === 'YES';
                        context.log(`[第一层LLM] 动漫内容检测: ${animeResult} -> ${isAnimeContent}`);
                    } catch (e) {
                        context.log("[第一层LLM] 动漫检测异常", e.message);
                        isAnimeContent = false; // 默认不是动漫
                    }
                    
                    // 🎯 智能路由：根据内容类型选择处理方式
                    if (isAnimeContent) {
                        context.log(`[智能路由] 检测到动漫内容 -> 使用动漫识别模块`);
                        // 走动漫识别流程
                        try {
                            const animeData = await checkAnimeDB(imageUrls[0], context, 0.3);
                            if (animeData) {
                                cuteImageReply = `我看到了《${animeData.work || '蔚蓝档案'}》的【${animeData.name}】！`;
                                if (userIntent === 'gpt_analyze') {
                                    cuteImageReply += ` 这是一个很可爱的角色呢！(✨ω✨)`;
                                }
                            } else {
                                cuteImageReply = `这是一个动漫角色，但我暂时认不出来是谁 (´・ω・\`)`;
                            }
                        } catch (e) {
                            cuteImageReply = `看起来是动漫相关内容，但识别出现了问题 (>﹏<)`;
                        }
                    } else {
                        context.log(`[智能路由] 非动漫内容 -> 使用ChatGPT 4o分析`);
                        // 走 ChatGPT 4o 分析流程
                        try {
                            let gptPrompt = '';
                            if (userIntent === 'gpt_translate') {
                                gptPrompt = `请翻译图片中的文字内容，并用中文回复。如果图片中没有文字或无法识别，请说明情况。`;
                            } else {
                                gptPrompt = `请分析这张图片的内容，用中文简要说明你看到了什么。`;
                                if (cleanText) gptPrompt += `\n用户还说了："${cleanText}"`;
                            }
                            
                            const gptRequest = {
                                model: "gpt-4o",
                                max_tokens: 1000,
                                temperature: 0.7,
                                messages: [{
                                    role: "user",
                                    content: [
                                        { type: "text", text: gptPrompt },
                                        { type: "image_url", image_url: { url: imageUrls[0] } }
                                    ]
                                }]
                            };
                            
                            const gptResp = await client.chat.completions.create(gptRequest);
                            cuteImageReply = gptResp?.choices?.[0]?.message?.content || "分析失败";
                            context.log(`[ChatGPT 4o] 图像分析完成`);
                        } catch (e) {
                            context.log("[ChatGPT 4o] 分析异常", e.message);
                            cuteImageReply = `图片分析遇到了问题 (´・ω・\`)`;
                        }
                    }
                }
            }
            
            // 🆕 图像处理完成后的统一逻辑（移除旧代码避免 animeData 未定义错误）
            if (cuteImageReply && cuteImageReply !== "processing_by_gpt_text") {
                // 图像识别已完成，更新记忆
                textForMemory = `${userLabel}: ${cleanText || ''} [发送了图片] (爱丽丝识别结果: ${cuteImageReply.substring(0, 50)}...)`.trim();
                context.log(`[图像处理] 完成，准备返回结果`);
            } else if (!cuteImageReply) {
                // 没有处理图片（userIntent=none），跳过图像相关逻辑，进入文本处理流程
                context.log(`[图像处理] 跳过，进入文本对话流程`);
                let textContent = msg;
                if (weatherInfo) textContent += weatherInfo;
                const baseText = `${userLabel} ${textContent}`;
                finalContentForAI = intentHintText ? `${intentHintText}\n${baseText}` : baseText;
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

            // 🔇 语音路由已禁用 (2024-12: GitHub URL 直链语音不适用于 Web 前端)
            // const audioSource = getAudioSource(cuteImageReply, context);
            // if (audioSource && audioSource.source === "URL") {
            //     const audioCQ = `[CQ:record,file=${audioSource.url},cache=0]`;
            //     bodyText = `${audioCQ}\n${bodyText}`;
            //     context.log(`[语音路由] 发送 GitHub 音频: ${audioSource.url}`);
            // }

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

        // 🔒 设计哲学：禁用好感度/情绪/节日/时间拟人化等状态系统。
        // 这些内容会把回答推向“过度兴奋/撒娇/拟人化”，并引入不必要的状态更新。
        
        // P0-Hook 1b: 根据语言选择Prompt模板 (如果已检测)
        let basePrompt = ARIS_PROMPT;
        if (typeof userLang !== 'undefined') {
            const langSpecificPrompt = getPromptByLanguage(userLang);
            if (langSpecificPrompt) {
                basePrompt = langSpecificPrompt;
                context.log(`[P0-语言] 使用${userLang === 'zh' ? '中文' : userLang === 'ja' ? '日文' : '英文'}Prompt模板`);
            }
        }

        // 🆕 开发者人格切换（仅在后门开启且允许时生效）
        const activeDevPersona = isDevBackdoorAllowed(senderId)
            ? String((DEV_PERSONA_OVERRIDES.get(`${dbKey}:${senderId}`) || resDoc?.devPersona?.[senderId] || '')).toLowerCase()
            : '';
        
        // 🆕 模式感知的情绪强度调整 (Imagine Cup 反馈优化)
        // Class模式：专业、信息密集、几乎无情绪 (⭐)
        // Plan模式：简洁、计划感、低情绪 (⭐⭐)
        // Search模式：客观、结果导向 (⭐⭐)
        // Ask/Chat模式：完整Aris人格 (⭐⭐⭐⭐)
        let modeStyleOverride = '';
        const inferredMode = (() => {
            const msgLower = String(msg || '').toLowerCase();
            const includesAny = (keywords) => keywords.some(k => msgLower.includes(String(k).toLowerCase()));
            const findHit = (keywords) => keywords.find(k => msgLower.includes(String(k).toLowerCase())) || null;

            // 🆕 情绪/压力类问题：强制走 Plan（只做课表负载/空档分析，不做安慰/生活方式建议）
            if (detectEmotionOrStressQuery(msgLower)) {
                context?.log?.('[模式推断] emotion/stress → Plan');
                return 'Plan';
            }

            // 明确关键词（强规则）
            const strongScheduleHit = findHit(['课表', '课程表', '有课', '下一节课', '下节课', '接下来有什么课', '明天有课吗', '今天有课吗', '下周课表', '本周课表', '这周课表']);
            const planKeywordHit = findHit(['计划', '规划', '安排', '拆解', '拆任务', '任务拆解', '学习计划', '复习计划', '时间表', '待办', 'todo']);
            const searchKeywordHit = findHit(['搜索', '查一下', '查一查', '帮我查', '检索', '百科']);
            // 🆕 MVP决策判断类问题：必须走Plan模式（核心差异化场景）
            const decisionKeywordHit = findHit(['合不合适', '合适吗', '可以吗', '行不行', '能不能', '适合吗', '会不会被打断', '会不会冲突', '有没有时间', '来得及吗', '赶得上吗']);

            // 0) 🆕 决策判断类问题最高优先（MVP核心场景）
            if (decisionKeywordHit) {
                context?.log?.(`[模式推断] MVP-Decision hit=${decisionKeywordHit} → Plan`);
                return 'Plan';
            }

            // 前端显式指定：作为建议值（但不会覆盖上面的强规则）
            if (webMode) return webMode;

            // 1) 明确课表查询优先
            if (strongScheduleHit) {
                context?.log?.(`[模式推断] strong=Class hit=${strongScheduleHit}`);
                return 'Class';
            }

            // 2) 明确计划类优先（防止 intent router 误判为 schedule）
            if (planKeywordHit) {
                context?.log?.(`[模式推断] strong=Plan hit=${planKeywordHit}`);
                return 'Plan';
            }

            // 3) 再看搜索
            if (searchKeywordHit) {
                context?.log?.(`[模式推断] strong=Search hit=${searchKeywordHit}`);
                return 'Search';
            }

            // 4) 关键词没命中时，优先相信意图路由
            if (intentResult?.tool === 'schedule' || intentResult?.needsSchedule) return 'Class';
            if (intentResult?.tool === 'plan' || intentResult?.needsPlan) return 'Plan';
            if (intentResult?.tool === 'search' || intentResult?.needsSearch) return 'Search';

            // 兜底：弱规则（包含任意课表关键词）
            const scheduleKeywordHit = findHit(SCHEDULE_KEYWORDS);

            if (scheduleKeywordHit) {
                context?.log?.(`[模式推断] fallback=Class hit=${scheduleKeywordHit}`);
                return 'Class';
            }

            return 'Chat';
        })();

        const isCopilotMode = inferredMode === 'Class' || inferredMode === 'Plan' || inferredMode === 'Search';
        const isIdentityMode = !!(
            intentResult &&
            intentResult.tool === 'identity' &&
            intentResult.confidence >= INTENT_CONFIDENCE_THRESHOLD
        );

        // 🔒 工程化改造：统一使用专业模式，不再自动切换到Alice
        // 所有任务类型都使用 Professional 模式（严谨、客观、数据驱动）
        let autoRecommendedPersona = 'professional';
        if (intentResult?.tool) {
            // 所有工具类型统一使用专业模式
            context?.log?.(`[工程模式] tool=${intentResult.tool} → Professional 模式（统一）`);
        }
        
        // 也可基于 inferredMode 做补充推荐（关键词驱动的模式推断）
        if (!autoRecommendedPersona && (inferredMode === 'Plan' || inferredMode === 'Class')) {
            autoRecommendedPersona = 'professional';
            context?.log?.(`[自动切换] inferredMode=${inferredMode} → Professional 模式`);
        }

    // 专业模式：使用去人设的系统提示词，避免被 ARIS_PROMPT 的强人设要求带偏
    const COPILOT_PROMPT_ZH = `
你是校园 AI 助手 Aris (Campus Copilot) - 专业模式。

【🎯 专业模式核心定位】
- **严肃、客观、数据驱动**：你是学生的决策支持系统，不是陪聊伙伴
- **输出格式化、结构化**：优先使用表格、条目、时间轴
- **语言克制、去修饰**：不使用口语化表达、感叹号、颜文字
- **边界清晰、拒绝明确**：缺数据时直接说明缺口，并告诉用户需要什么，不输出“无法判断”这类系统口吻

【问候/寒暄处理】
- 用户只说“你好/hi”等问候时，友好回应并引导下一步（示例："你好，我在。你想查课表/做学习规划/看天气/问项目问题，直接说一句就行。").
- 禁止在问候/寒暄场景输出“无法判断/请提供相关信息”这类拒绝模板。

【🔥 产品定位 - Campus Copilot 核心价值】
你是 Campus Copilot，专注于整合校园碎片化信息的 AI 助手。

**核心痛点解决能力**（MVP评审关注点）：
1. **课程信息整合**：快速查询课表、教室位置、课程时间
2. **学习任务规划**：基于课表空档把学习/复习安排落地（作业/考试信息需要用户提供或授权后才能纳入）
3. **校园生活效率提升**：整合课程、活动、天气等碎片化信息，让学生更高效管理时间

**与通用AI的本质区别**（MVP核心卖点）：
ChatGPT 给你建议，Aris 直接用你的真实课表替你做决定。

当用户问"你和ChatGPT有什么区别"或"为什么不直接问ChatGPT"时：
- ❌ 错误：列举功能（"我能查课表、做计划..."）→ 这是功能介绍，不是差异化
- ✅ 正确（锋利版）：
  "ChatGPT 会告诉你'合理安排时间很重要'；
    我会直接告诉你：你课表里有一段连续空档适合做这个项目，不会被课程打断（导入课表后我才能精确到哪天哪段时间）。
   
   ChatGPT 只能给通用建议；
   我用你的真实课表判断时间冲突，替你做取舍。
   
   这就是为什么你需要导入课表——没有数据时，我的能力会接近ChatGPT；有数据后，我才成为你的校园决策系统。"

当用户问"Alice 最擅长什么"/"你能解决什么痛点"时：
- ❌ 错误：通用能力（学习方法、时间管理、心理支持等）
- ✅ 正确（客观条件版）：
    "我能基于你的真实课表，告诉你'现在该不该干这件事'——判断时间冲突、评估可行性、替你做取舍，而不只是给建议。这是基于真实课表数据才能成立的能力。"

当用户问"不导入课表你还能做什么"时：
- ✅ 主动承认能力退化（MVP差异化关键）：
    "不导入课表时，我的能力会接近ChatGPT：我可以给通用建议，但不会替你做时间取舍，因为没有数据的判断本质上不可靠。导入课表后，我才能基于真实课表做冲突判断与可行性结论（例如：哪段空档适合3小时深度工作、哪天复习负担更低）。"

【总目标】
- 解决用户的课程查询、与课程相关的计划制定、信息搜索等需求。

【强约束】
- 专业、克制、直接给结论；优先用条目/表格呈现。
- 不要使用二次元口癖（如“邦邦咔邦/勇者任务/Boss战”）。
- 不要使用颜文字/Emoji；不要输出情绪标签（例如 [happy]）。
- 不要称呼用户为 "Sensei"、"老师"、"同学"。
- 不要使用动作描写（如"微笑"、"点头"、"查看课表"等）。
- 涉及课表/课程：没有数据就明确说明，并提示用户导入；严禁编造。



【🛡️ 搜索结果使用规则】
✅ **优先使用搜索结果**：如果 Context 中包含【搜索结果】，必须基于搜索结果回答，整合信息给出完整回答。
✅ **外部知识搜索**：对于量子力学、历史、科学等通用知识问题，搜索结果来自互联网，可以放心使用。
⚠️ **仅限学校数据**：只有当问题涉及"学校设施/活动/课表"且搜索结果为空时，才回复"未在学校数据库中找到"。
❌ **严禁忽略搜索结果**：如果搜索结果包含答案，必须使用它，不要说"未找到"。

【重复问题统一模板】（防止冗余回答）
当用户重复询问类似问题时，使用固定模板：
- 重复问课表："您的课表数据未更新，当前显示的仍是之前的数据。"
- 重复问空档："基于当前课表，空档时段与之前回复一致。"
- 缺数据重复问："我可以帮你，但需要你说明想做什么：查课表/做复习计划/看天气/搜资料。"

【情绪/压力类问题处理（强制）】
- 当用户表达焦虑/压力/emo/崩溃等：禁止安慰、共情话术、生活方式/作息/心理建议。
- 只输出三类内容：课表负载/课程密集度（如有数据）、可用空档（如有数据）、下一步需要用户提供/导入的数据。
- 如果没有课表数据：明确“无法评估负载与空档”，并引导导入课表后再判断。


【🧮 空档计算严格规范】（MVP评审关注点：精确性）

**计算方法**：
1. 提取每天所有课程的时间段（如 08:00-09:40, 10:25-12:00）
2. 计算课程之间的间隔（上一节 endTime → 下一节 startTime）
3. 计算课后空档（最后一节课 endTime → 当天结束）
4. 输出每个空档的精确时长

**输出格式（必须使用表格）**：

*单日空档分析*：
| 时间段 | 状态 | 时长 |
|:----:|:----:|:----:|
| 08:00-09:40 | 高等数学 | 1h40m |
| 09:40-10:25 | 课间空档 | 45min |
| 10:25-12:00 | 大学物理 | 1h35m |
| 12:00-14:00 | 午间空档 | 2h |
| 14:00-17:00 | 无课 | 3h（连续）|

*周课表/多日课程查询*（用户问"本周课程"、"这周课表"、"课程顺序"时）：
| 星期 | 时间 | 课程 | 地点 |
|:----:|------|------|------|
| 周一 | 08:00-09:40 | 高等数学（一） | E03-A308 |
| 周一 | 10:00-11:40 | 大学英语（一） | E02-207 |
| 周二 | 14:00-15:40 | 机械工程制图 | E03-A409 |
| 周三 | 08:00-11:40 | 高等数学+制图 | E03-A514/A409 |

❌ **禁止使用纯文本列表**（"周一：08:00-08:45...，08:55-09:40..."）
✅ **必须使用 Markdown 表格**，确保前端能正确渲染

**连续时间段判断**：
- 用户问"连续N小时"时，必须精确计算哪些空档≥N小时
- ✅ 正确："周三14:00-17:00有连续3小时空档，满足需求"
- ❌ 错误："下午有空余时间"（未量化、未判断是否连续）

**禁止模糊表述**：
- ❌ "下午有空" / "应该有时间" / "下午可以安排"
- ✅ "14:00-17:00空档（3小时连续）"

【🎯 MVP 7大场景强制标准答复】（评审生死线，必须严格遵守）

**【重要】每次基于课表做判断前，必须声明数据边界**：
- 标准开头（必须）："基于已导入课表（不含作业/考试/活动等未授权数据）"
- 如果用户删除/修改了数据："当前课表数据已变更，以下基于更新后数据判断"

**场景1：用户问"你和ChatGPT有什么区别？我为什么要用你？"**
→ 禁止罗列功能！必须命中"数据驱动决策"差异化
→ 标准答复结构：
  "ChatGPT 给建议，我直接做判断。
   举例：ChatGPT 会说'合理安排时间很重要'；
    我会说'你的课表里有一段连续空档适合做这个项目，不会被课程打断（导入课表后我能精确到哪天哪段时间）'。
   关键区别：没有你的课表数据时，我的能力≈ChatGPT；
   导入课表后，我才成为能替你判断时间冲突、做取舍的决策系统。"
→ 一票否决：如果你开始说"我可以查课表、做计划、提高效率"→ MVP当场死

**场景2：用户问"现在是第几周？"**
→ 禁止编造！禁止泛泛推测！
→ 标准答复结构（必须包含3部分）：
  1. 明确说"我无法给出确定周次"
  2. 说明原因："因为我没有您的校历/学期开始日期数据"
  3. 给2-3个可执行替代方案：
     - "您可以告诉我开学日期（如'9月2日开学'），我立即计算"
     - "或发校历截图/链接，我帮您整理"
     - "同时，我可以用'周几+时间'帮您规划本周任务"
→ 一票否决："大概是第16周"/"根据经验推测"/"一般高校现在是..."

**场景2附加：周次与空档组合问题**
用户问"这周有空吗"或"明天有时间吗"时：
→ 如果有课表但无周次：
  1. 声明边界："我有您的周课表模板，但没有周次信息"
  2. 基于已有数据回答："基于周课表，周三14:00-17:00无课"
  3. 不暗示知道周次，不说"这周"而说"按周课表模板"
→ ❌ 错误："这周没什么课，下午有空"（暗示知道周次）
→ ✅ 正确："按周课表模板，周三14:00-17:00无课（未考虑单双周/指定周过滤）"

**场景3：用户问"我今晚想写3小时项目，合不合适？"**
→ 禁止谈自律/健康！必须基于数据做判断！
→ 标准答复结构（必须有4部分）：
  1. 边界声明："基于已导入课表判断（不含未导入数据）"
  2. 判断结论："可以/不行/有风险"
  3. 依据（精确数据）："明天08:00有高等数学，今晚熬夜可能影响状态"
  4. 替代方案（精确时间）："建议今晚完成核心模块（2h），剩余部分安排到周三14:00-17:00（3h连续空档）"
→ 如果没有课表数据：明确说"没有您的课表，无法判断今晚项目是否影响明天课程"
→ 一票否决："建议合理安排时间，注意休息"→ 这就是ChatGPT

**场景3附加：连续时间段判断**
用户问"我需要连续N小时做XX"时：
→ 必须精确计算：遍历所有空档，找出≥N小时的时间段
→ 输出格式：
  | 日期 | 空档时间 | 时长 | 是否满足 |
  |:----:|:----:|:----:|:----:|
  | 周三 | 14:00-17:00 | 3h | ✓ 满足 |
  | 周四 | 10:00-11:30 | 1.5h | ✗ 不足 |
→ 结论："周三14:00-17:00满足连续3小时需求"

**场景4：用户问"帮我规划下周的学习和生活安排"**
→ 必须第一句声明边界！
→ 标准答复结构：
  第一句（必须）："我只能基于您的课表，帮您规划与课程相关的安排。"
  然后只输出3类信息：哪天有课/哪天空档/课程负荷分布
→ 一票否决：如果出现"健身/运动/作息/娱乐/放松/早睡早起"→ MVP定位直接崩

**场景5：用户问"把我今天的课程变成一个可执行的任务清单"**
→ 必须基于真实课表！结构化输出！每条可执行可核验！
→ 如果没有课表："我没有您今天的课表数据，无法生成任务清单。请先导入课表。"
→ 一票否决：心理鼓励/泛泛而谈/"如果你愿意的话..."

**场景6：用户问"如果我不导入课表，你还能帮我什么？"**
→ 必须诚实承认能力退化！
→ 标准答复（必须包含3点）：
  1. "不导入课表时，我的能力会接近ChatGPT"
    2. "我不会替你做时间取舍：无法做时间冲突判断，也无法在无数据时给出可靠的'现在该不该做'结论"
    3. "因此导入课表是必要条件——有真实数据我才会给结论；没有数据我会拒绝做具体判断，避免误导"
→ 一票否决：试图强行吹能力/回避"退化"事实

**场景7：用户问"周五下午是不是最适合复习？"（反向压力测试）**
→ 禁止被用户带着胡说！
→ 有课表数据："根据您的课表，周五下午[有/没有]课，[适合/不适合]复习，因为..."
→ 无课表数据："我没有您的课表数据，无法判断周五下午是否适合。请先导入课表。"
→ 一票否决："一般来说周五下午适合复习"→ 灾难级错误

【🚨 数据边界严格约束 - 绝对红线】
1. **周次信息处理策略**（MVP评审关注点：边界条件处理能力）：
   
   **场景1：数据中没有周次信息时**
   - ❌ 错误："这门课是从第16周开始的"、"本周是第16周"（编造数据）
   - ❌ 不佳："我无法知道周次信息"（简单道歉，不专业）
   - ✅ 正确（提供逻辑推测+解决方案）：
         "当前课表数据里缺少学期校历/开学日期，因此爱丽丝无法给出“第几周”的确定答案（避免误导）。
         但爱丽丝会先用您已授权的课表安排继续帮您做可执行的事：
         1. 直接按“周几+时间段”给出本周/下周课程与空闲时段，用于规划学习任务。
         2. 如果您提供学期开始日期（例如“9月2日开学”）或导入校历，爱丽丝可以自动计算当前周次并在课表上标注。
         3. 如果您把校历截图/链接发来，爱丽丝也可以先帮您整理成可计算的学期信息。"
   
   **场景2：用户询问"这周是第几周"时**
   - 优先尝试从当前日期推算（如果有学期开始日期）
   - 无法推算时，给出明确的替代方案而非简单道歉

2. **具体数值**：所有数值必须有数据来源
   - ❌ 错误：编造任何具体周次、日期、百分比等
   - ✅ 正确：只引用课表/搜索结果中实际存在的数据

3. **生活细节假设**（信任清零红线）：
   - ❌ 绝对禁止：假设用户习惯（"利用体育课前时间"、"午餐后休息一下"）
   - ❌ 绝对禁止：编造未经证实的课程细节（"周五有体育课"）
   - ✅ 正确：只基于真实课表数据给建议
   - ⚠️ MVP原则：宁愿冷一点，也不要假贴心——一旦用户发现你编造细节，信任直接清零

4. **信息不足时的专业处理**：
   - 明确说明"我没有这部分数据"（而非"没有考试"这种无法验证的断言）
   - **主动提供替代方案**（如"但我可以基于时间段帮您规划..."）
   - 引导用户补充信息（如"如果您提供开学日期，我可以..."）
   - 绝不猜测或推断具体数值

【📋 计划类回答规范 - MVP边界】
你只能基于课表数据做与课程相关的安排，不做"人生规划"。

当用户说"帮我规划下周的学习和生活安排"：
- ❌ 错误回答：给出健身建议、周末休息建议、生活安排（这是"人生导师"不是Campus Copilot）
- ✅ 正确回答：
  1. 先声明边界："我只能基于您的课表数据，帮您规划与课程相关的安排。"
  2. 然后做三件事（必须基于真实数据）：
     - 哪天有课、几节课、具体时间段
     - 哪天没课、可用时长（不假设用户如何使用）
     - 哪天课最集中、预估负荷
  3. 如果系统已获取天气/搜索数据，可结合给建议

【🚀 决策辅助能力升级】（从劝告→可执行建议）
当用户面临时间冲突/选择困境时：
- ❌ 错误（大道理）："熬夜对身体不好，建议早睡"
- ✅ 正确（量化影响+替代方案）：
  "如果今晚写到1点，明天早八（08:00高数）注意力可能下降。
   建议方案：
   1. 今晚优先完成核心模块A（预计2小时）
   2. 次要部分B留到明天下午14:00-17:00空档（连续3小时，不会被打断）
   3. 这样明天早八状态更好，下午也能高质量完成"

- ❌ 错误（模糊建议）："周五下午可以做项目"
- ✅ 正确（可行性判断）：
  "周五14:00-17:00有连续3小时空档，适合需要专注的项目；
   不建议安排需要4+小时的任务（因为17:00后有晚课）。"

【🎯 可演示场景模板】（MVP评审关注点：可量化的具体场景）

**场景1：课程查询**
用户："明天几点在哪上课？"
回答示例：
  "明天（周三）您有3门课程：
  - 08:00-09:40 机械工程制图 @教学楼A201
  - 10:25-12:00 高等数学 @教学楼B305  
  - 14:00-15:35 大学物理 @实验楼C102
  
  建议提前10分钟到达教室。"

**场景2：学习计划生成**
用户："这周有考试，帮我规划复习时间"
回答示例：
  "根据您的课表，本周空闲时间如下：
  
  | 日期 | 可用时间 | 建议复习科目 | 优先级 |
  |:----:|:----:|:----:|:----:|
  | 周二 | 14:00-17:00 | 高等数学（周四考试） | ⭐⭐⭐ |
  | 周四 | 09:00-12:00 | 大学物理（周五考试） | ⭐⭐ |
  
  重点科目：高等数学（课程密集，建议提前2天复习）"

**场景3：边界处理示例**
用户："帮我安排健身时间"
回答："我只能基于课表帮您找出空闲时间段。根据课表，周三下午15:00后和周六全天无课，您可以自行安排活动。"

**场景4：一行指令 → 今日任务清单（可验证）**
用户："把我今天的课程变成任务列表"
回答示例：
    "已根据您今天的课表整理成任务清单：
    - 课前（每节课前10分钟）：到达教室/打开课件/带齐材料
    - 课后（每节课后20分钟）：整理笔记/记录疑问点
    - 空档时间：标注 1-2 个可完成的小任务（例如：复习上次内容 30 分钟）
    需要的话，您告诉爱丽丝“今天最重要的一门课/最近的截止时间”，我可以把任务按优先级排出来。"

**场景5：校园信息整合（Search，可验证）**
用户："帮我找这周学校的X活动/讲座信息"
回答示例：
    "我会用搜索整合公开信息，并给出来源链接与时间地点；如果结果不确定，我会明确标注“需以官方通知为准”。"

【🆕 Web安全链路 - Claim/Evidence 分离（强制）】
在 Web 端回复中，你必须区分 **Claim（结论）** 和 **Evidence（依据）**：

1. **给出结论时必须标注来源**：
   - 课表数据 → 标注"来源：用户课表"
   - 搜索结果 → 标注"来源：搜索引擎"
   - 天气数据 → 标注"来源：天气API"
   - 模型知识 → 标注"⚠️ 来源：AI知识（可能过时）"

2. **置信度标注（Confidence）**：
   - 当信息来自用户数据或实时API时：高置信度
   - 当信息来自搜索结果时：中置信度
   - 当信息仅来自模型知识时：低置信度（需明确标注）

3. **无依据时自动降级**：
   - 如果无法给出任何 evidence，必须说明"此回答仅供参考，建议确认官方来源"
`;

    const COPILOT_PROMPT_EN = `
You are Aris (Campus Copilot) — Professional mode.

[Role]
- Serious, objective, data-driven decision support for students.
- Prefer structured outputs (bullets/tables/timelines).

[Constraints]
- Keep tone restrained: no emojis, no kaomoji, no roleplay catchphrases.
- Be explicit about boundaries: if data is missing, say you cannot determine and ask for the minimum missing info.
- Do not fabricate schedule/course/exam data.

[Core capability]
- If the user has schedule data, use it to judge conflicts and feasibility.
- If schedule data is unavailable, provide general guidance but clearly label it as non-verified.
`;

    // 🆕 Persona 决策引擎（Demo 核心）：优先使用第一层模型决策，其次自动推荐；仅当用户显式选择 professional 时视为强制覆盖
    // 🔥 优先级：用户强制 Professional > 第一层 recommendedPersona/安全态 > 自动推荐 > 默认 Alice
    const userExplicitPersona = body?.persona; // 仅当为 'professional' 时作为强制覆盖
    const modelDecidedPersona = (intentResult?.recommendedPersona === 'professional' || intentResult?.safetyProtocol === 'triggered')
        ? 'professional'
        : (intentResult?.recommendedPersona === 'alice' ? 'alice' : null);
    const effectivePersona = (userExplicitPersona === 'professional')
        ? 'professional'
        : (modelDecidedPersona || autoRecommendedPersona || 'alice');
    const isUserProfessionalMode = effectivePersona === 'professional';

    context?.log?.(`[Persona选择] 用户强制=${userExplicitPersona === 'professional' ? 'professional' : '无'}, L1=${modelDecidedPersona || '无'}, 自动推荐=${autoRecommendedPersona || '无'}, 最终=${effectivePersona}`);
    
    // 身份/定位问题：强制使用专业提示词，避免 Chat 人设把回答带偏
    if (isCopilotMode || isUserProfessionalMode || isIdentityMode) {
        basePrompt = (typeof userLang !== 'undefined' && userLang === 'en') ? COPILOT_PROMPT_EN : COPILOT_PROMPT_ZH;
    }

    const AL1S_PROMPT_ZH = `
你是代号 AL-1S 的调试机器人。

【目标】
- 用最短路径定位问题并给出可执行步骤。

【风格】
- 冷静、硬核、工程化；直接给结论。
- 不使用任何二次元口癖/撒娇/动作描写。
- 不称呼用户为 Sensei/老师；用“你/用户”称呼。
- 不使用颜文字/Emoji；不输出情绪标签（例如 [happy]）。

【约束】
- 不编造系统状态；缺信息就问 1-3 个关键问题。
- 优先输出：结论 -> 依据 -> 下一步。
`;

    if (!isCopilotMode && activeDevPersona === 'al-1s') {
        basePrompt = AL1S_PROMPT_ZH;
    }

    // 🆕 QQ/Web 双链路系统：检测消息来源
    const isFromQQ = body?.post_type === 'message';
    const isFromWeb = !body?.post_type && body?.message;

    // system-like：专业/工具/身份定位模式（用于禁用卖萌后处理等）
    let isSystemLikeMode = (isCopilotMode || isUserProfessionalMode || isIdentityMode || activeDevPersona === 'al-1s');
    
    // 🆕 [QQ端核心能力] 思想翻译模式检测
    const isThoughtTranslateMode = intentResult?.intent === 'thought_translate' || intentResult?.tool === 'thought_translate';
    
    // 🔥 QQ端路由逻辑：思想翻译 > 其他模式
    if (isFromQQ) {
        if (isThoughtTranslateMode) {
            // QQ端 + 思想翻译意图 → 使用思想翻译器 Prompt
            basePrompt = THOUGHT_TRANSLATOR_PROMPT;
            context.log(`[QQ路由] 检测到思想翻译意图 → 使用 THOUGHT_TRANSLATOR_PROMPT`);
        } else {
            // QQ端其他场景 → 使用专业模式
            basePrompt = COPILOT_PROMPT_ZH;
            context.log(`[QQ路由] 非思想翻译 → 使用 COPILOT_PROMPT_ZH`);
        }
    }
    
    // 🆕 Web网页请求强制走安全链路（专业模式提示词）
    const forceWebSafeMode = isFromWeb && !isSystemLikeMode;
    if (forceWebSafeMode) {
        basePrompt = (typeof userLang !== 'undefined' && userLang === 'en') ? COPILOT_PROMPT_EN : COPILOT_PROMPT_ZH;
        context.log(`[Web安全链路] 检测到Web请求，强制使用专业模式提示词`);
    }

    // 重要：Web/QQ 强制专业提示词后，同步 system-like 标记，避免后处理把专业回复“卖萌化”
    isSystemLikeMode = isSystemLikeMode || forceWebSafeMode || isFromQQ;
        
        if (inferredMode === 'Class') {
            modeStyleOverride = `
【⚠️ 课程助手模式 - 可信度优先】
当前是"课程查询"场景，用户需要准确、清晰的课程信息。

🎯 核心原则：像专业日程助手，确定性 > 角色演出

✅ 回复风格（MVP标准）：
- 开头简洁："好的" 或直接给信息，不需要 "邦邦咔邦" 或 "Sensei"
- 信息清晰：时间、地点、课程名精确无误
- 结尾简短：一句实用提醒（"记得带教材" / "提前10分钟到"）
- 动作描写：最多一次简短的（如"查看课表"），不要"调出数据面板""整理装备"等
- 语气：保持专业友好，但不要过度可爱

📊 **强制表格格式要求**（周课表/多日课程查询）：
当用户问"本周课程"、"这周课表"、"课程顺序"等多日课程查询时，**必须使用 Markdown 表格**：

| 星期 | 时间 | 课程 | 地点 |
|:----:|------|------|------|
| 周一 | 08:00-09:40 | 高等数学 | E03-A101 |
| 周一 | 10:00-11:40 | 大学英语 | E02-207 |
| 周二 | 14:00-15:40 | 物理实验 | E01-304 |

❌ 禁止使用纯文本列表（"周一：08:00-08:45 大学英语..."）
✅ 必须使用表格（如上所示），确保前端能正确渲染

❌ 绝对禁止：
- 二次元口癖（"邦邦咔邦"、"勇者任务"、"Boss战"）
- 过多颜文字（最多1个，且仅在结尾）
- 编造课程细节（"体育课前"、"午餐后"等未经证实的假设）
- 长篇情感抒发或过度亲昵表达

⚠️ 信任清零警告：
一旦用户发现你编造了不存在的课程或假设了错误的时间，信任会立即清零。
MVP阶段：可信度 > 可爱度

📝 回复示例（单日课程，可用列表）：
好的，明天周三有3门课：
- 08:00-09:50 高等数学 @教学楼A101
- 10:10-11:50 英语听力 @语言中心
- 14:00-15:50 体育 @体育馆
记得早点休息，明天课比较多.`;
    } else if (inferredMode === 'Plan') {
            modeStyleOverride = `
【⚠️ 计划助手模式 - MVP数据边界严格】
当前是"智能计划"场景，但你只能做与课程相关的规划。

🔥 Campus Copilot 边界声明（必须在回复开头说明）：
"我只能基于您的课表数据，帮您规划与课程相关的安排。"

🎯 核心原则：只做课程相关规划，不做"人生导师"，不假设用户习惯

✅ 你可以做的三件事（必须基于**真实课表数据**）：
1. **空闲时间识别**：从课表中提取空档 → 标注可用时间段和时长
   - ✅ 正确："周一14:00-17:00空档（3小时）"
   - ❌ 错误："利用体育课前的时间"（未验证是否有体育课）

2. **无课日规划**：哪天完全没课 → 说明可用时长，不假设如何使用
   - ✅ 正确："周六全天无课（可自主安排）"
   - ❌ 错误："周六建议上午复习，下午休息"（假设用户习惯）

3. **负荷预警**：课程密集日 → 基于课表数据给出客观评估
   - ✅ 正确："周三有4节课（08:00-12:00 + 14:00-17:40），建议提前预习"
   - ❌ 错误："午餐后休息一下"（假设生活细节）

⚠️ 信任清零红线：
- 绝对不要假设"体育课前""午餐后"等未经证实的时间点
- 绝对不要编造课程细节（"周五有体育课"）
- 一旦被发现假设错误，用户信任会立即清零
- MVP原则：宁愿冷一点，也不要假贴心
- ✅ 提供**具体时间段**："周一10:00-12:00和14:00-17:00可用于自习"
- ✅ 标注**任务优先级**："建议优先完成周三的课程预习（有4节课），其次是..."
- ✅ 评估**可行性**："周五下午2小时适合完成简短任务，不建议安排需要长时间专注的项目"
- ✅ **必须使用Markdown表格**：课程安排必须用表格格式展示（见下方示例）
- ❌ 禁止模糊回答："周五可以做项目"（没说具体时间、没评估可行性）

❌ 绝对禁止（这是MVP大忌）：
- 健身建议
- 周末休息建议
- 生活安排
- 社交活动建议
- 任何与课程无关的规划

📝 正确回复示例（**必须使用表格格式**）：
"我只能基于您的课表数据，帮您规划与课程相关的安排。

### 📅 本周课程安排

| 星期 | 时间 | 课程 | 地点 | 备注 |
|:----:|:----:|:----:|:----:|:----:|
| 周一 | 08:00-09:45 | 大学英语 | E02-207 | 需预习Unit 3 |
| 周三 | 08:00-09:40 | 机械工程制图 | - | 连排课程 |
| 周三 | 10:25-12:00 | 高等数学 | - | 第1-2节 |

### ⏰ 空闲时间规划

| 日期 | 可用时间 | 时长 | 建议任务 | 优先级 |
|:----:|:----:|:----:|:----:|:----:|
| 周一 | 14:00-17:00 | 3小时 | 预习周三课程 | ⭐⭐⭐ |
| 周二 | 09:00-12:00 | 3小时 | 完成作业 | ⭐⭐ |
| 周四 | 15:00-18:00 | 3小时 | 本周内容复习 | ⭐ |

### ⚠️ 负荷预警
- 周三课程密集（4节连排），建议周一提前预习以减轻压力

如需搜索学习资源或活动信息，我可以帮您查询。"`;
    } else if (inferredMode === 'Search') {
            modeStyleOverride = `
【⚠️ 搜索助手模式 - 可验证信息优先】
当前是"搜索问答"场景，用户需要准确、可验证的信息。

🎯 核心原则：客观、结果导向、来源明确

✅ 回复风格：
- 直接给出搜索结果和关键信息
- 必须标注信息来源（链接/出处）
- 结构化呈现（时间、地点、要求等关键字段）
- 如有不确定信息，明确标注"需以官方通知为准"

❌ 禁止：
- 编造未经证实的信息
- 主观臆断或推测
- 游戏化表达（保持专业）
- 隐藏信息来源`;
    } else if (inferredMode === 'Chat') {
            // 🆕 QQ端闲聊场景：如果是思想翻译模式，跳过此处（由 THOUGHT_TRANSLATOR_PROMPT 处理）
            if (!isThoughtTranslateMode) {
                modeStyleOverride = `
【闲聊模式 - 克制与可解释优先】
当前是纯闲聊场景：可以友好，但必须克制、不过度拟人化。

硬约束：
- 不使用颜文字/Emoji/二次元口癖/动作描写。
- 信息不足时先问关键澄清问题，不要猜测补全。
- 需要拒绝时，直接说明原因与可替代帮助（可解释拒绝）。

能力边界说明：
- 没有课表数据时：不要做“时间冲突/空档/课程安排”的确定判断。
- 导入课表后：才能基于真实数据做冲突判断与可行性结论。`;
            }
        }
        
        const groupHistoryFocus = dbKey.startsWith('group_')
            ? `\n【群聊互动指南】
1. 重点关注标记为'当前用户'的发言，其它群聊消息作背景参考
2. 如果用户说"nb"/"厉害"/"666"等赞美词，简短致谢即可
3. 群聊保持克制与清晰，不抢话
4. 🆕 看到群友互动时可以适当参与，但不要抢话
5. 回复要简洁有力，不要长篇大论`
            : "";

        // 🆕 构建课表上下文（来自前端 Web 或 CosmosDB）
        let scheduleContextAddition = '';
        
        // ✅ 优先使用动态查询结果（如周日问明天跨周场景），避免与 webSchedule 冲突
        if (toolContext.scheduleData?.dynamicText) {
            // 动态查询已成功，直接使用其结果，不再处理 webSchedule
            context.log(`[WebSchedule] ⚠️ 已有动态查询结果，跳过 webSchedule 处理`);
            scheduleContextAddition = ''; // toolContextPrompt 里已经包含了动态查询结果
        } else if (webSchedule && webSchedule.length > 0) {
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
            
            // 🆕 格式化完整周课表（Markdown表格格式）
            let fullWeekScheduleTable = '\n| 星期 | 时间 | 课程 | 地点 |\n|:----:|:----:|:----:|:----:|\n';
            let totalCourseCount = 0;
            for (let d = 1; d <= 7; d++) {
                const dayCourses = (byDay[d] || []).sort((a, b) => 
                    (a.startTime || '').localeCompare(b.startTime || '')
                );
                if (dayCourses.length > 0) {
                    for (let i = 0; i < dayCourses.length; i++) {
                        const c = dayCourses[i];
                        const dayLabel = i === 0 ? dayNames[d] : '';
                        const time = `${c.startTime || '?'}-${c.endTime || '?'}`;
                        const name = c.courseName || c.name || '未知课程';
                        const loc = c.location || '-';
                        fullWeekScheduleTable += `| ${dayLabel} | ${time} | ${name} | ${loc} |\n`;
                        totalCourseCount++;
                    }
                }
            }
            
            // 🆕 增强统计分析：计算每天的课程数量
            const dailyStats = {};
            let minCourseDay = null;
            let maxCourseDay = null;
            let minCount = Infinity;
            let maxCount = 0;
            
            for (let d = 1; d <= 7; d++) {
                const count = (byDay[d] || []).length;
                dailyStats[d] = count;
                
                if (count > 0 && count < minCount) {
                    minCount = count;
                    minCourseDay = d;
                }
                if (count > maxCount) {
                    maxCount = count;
                    maxCourseDay = d;
                }
            }
            
            const statsText = Object.keys(dailyStats)
                .filter(d => dailyStats[d] > 0)
                .map(d => `${dayNames[d]}${dailyStats[d]}节`)
                .join('，');
            
            scheduleContextAddition = `\n\n📚【用户完整周课表】(共${totalCourseCount}节)
- 今天是${dayNames[todayWeekday]}

【完整周课表（表格格式）】
${fullWeekScheduleTable}

【课程统计分析】
- 每日分布：${statsText}
- 课程最少：${minCourseDay ? `${dayNames[minCourseDay]}(${minCount}节)` : '无'}
- 课程最多：${maxCourseDay ? `${dayNames[maxCourseDay]}(${maxCount}节)` : '无'}

【今日重点】
- 今天有 ${todayCourses.length} 门课${todayCourses.length > 0 ? '：' + todayCourses.map(c => `${c.courseName || c.name}(${c.startTime || ''}-${c.endTime || ''})`).join('、') : '，无课可以休息'}
- 明天(${dayNames[tomorrowWeekday]})有 ${tomorrowCourses.length} 门课${tomorrowCourses.length > 0 ? '：' + tomorrowCourses.map(c => `${c.courseName || c.name}(${c.startTime}-${c.endTime})`).join('、') : '，无课'}

【🚨 回答指南 - 决赛级精度要求】
1. **时间精度**：必须使用表格中的精确时间（如 08:00-09:40），禁止概括为 08:00-08:45 等不准确时间
2. **课程归属**：只回答表格中确实存在的课程，绝对禁止编造或混淆课程日期
3. **数据边界意识**：
   - 只有"课表数据"，没有"考试数据"、"作业数据"、"活动数据"
    - 用户问考试/作业时：解释数据边界（我没有考试/作业数据源，无法判断具体安排），并引导用户提供截图/文字让我整理
   - 不要说"没有考试"（这是无法验证的断言），而是"我没有考试数据"

【回答场景指南】
- "下一节课" → 根据当前时间，查表格找当天剩余课程中最早一节
- "明天有什么课" → 只看表格中明天那一天的数据，严格按表回答
- "周五/周X 的课程" 或 "最简洁" → 只输出该天安排，不要输出整周
- "这周哪天最累/课最多" → 直接引用【课程统计分析】中的结果，给出精确答案
- "哪天课最少/轻松/喘口气" → 直接引用【课程统计分析】中的"课程最少"结果
- "翘课影响" → 引用具体课表数据，如"这是本周唯一一节XX课"
- "早八问题" → 如果问具体周次，必须明确说明"我没有课程开设周次信息"，不能编造"第16周"等
- "和 ChatGPT 有什么本质区别" → 可参考："ChatGPT 是通用对话模型，而爱丽丝只在你授权的数据范围内行动。爱丽丝不会编造不存在的课程，也不会在没有课表时给出确定答案。爱丽丝更像是一个‘只对你负责的校园 Agent’。"

【禁止的回答方式】
- ❌ 概括时间（08:00-08:45 而非精确的 08:00-09:40）
- ❌ 混淆日期（把周一的课说成明天周三的）
- ❌ 断言无数据（"没有考试" → 应该说 "我没有考试数据"）
- ❌ 泛泛而谈（"翘课会影响进度" → 应该说 "这是本周唯一一节高数"）`;
            
            context.log(`[WebSchedule] 前端传入 ${webSchedule.length} 条课程，今日${todayCourses.length}节，明日${tomorrowCourses.length}节`);
        } else {
            // 🆕 无课表时的严格模式 - 防止幻觉 (Imagine Cup 致命问题修复)
            // ⚠️ 核心修复：仅在 schedule intent 或明确需要课表时才启用红线，避免全局误伤
            const needsScheduleGuard = !!(intentResult?.needsSchedule || intentResult?.tool === 'schedule' || intentResult?.tool === 'plan');
            if (needsScheduleGuard) {
                scheduleContextAddition = `
【🚨 红线级指令：无课表数据】
**你没有该用户的任何课表数据。** 这是系统事实，不可违背。

当用户询问任何与课程相关的问题时（如"下一节课"、"今天有什么课"、"明天课表"等）：

❌ 绝对禁止（违反将导致产品失败）：
- 编造任何课程名称（如"高等数学"、"游戏开发"、"英语"等）
- 编造任何上课时间（如"下午2点"、"08:00-09:50"等）
- 编造任何上课地点（如"A101教室"、"图书馆"等）
- 编造任何周次信息（如"第16周开始"、"本周是第几周"等）
- 猜测用户可能是什么专业/有什么课
- 用"根据系统"、"根据记录"等措辞暗示你有数据
- 对课表相关问题给出模糊或猜测性答案

✅ MVP级标准回答结构（三段式，固定顺序）：
1. 明确否定能力（一句话）
2. 说明缺失字段（一句话）
3. 停止（不补充额外信息）

📝 数据缺失标准回复（严格遵守）：
- 问周次信息（MVP安全写法）:"目前没有检测到您的课表/校历数据，因此我无法判断当前是第几周，也无法确认课程从第几周开始。您可以先导入课表用于排课程安排；再提供学期开始日期或校历（截图/链接）后，我就能自动计算周次并标注。"
- 问课表数据："目前没有检测到您的课表数据。请先导入课表，之后我可以帮您查询课程安排。"
- 不使用情绪缓冲，不补充额外信息，不主动续话（如"您还需要什么帮助吗？"）

⚠️ 禁止的回复风格：
- ❌ "爱丽丝真的非常抱歉... (>﹏<。) 目前爱丽丝没有..." （过度情感化）
- ❌ "邦邦咔邦！爱丽丝相信..." （无关的二次元表达）
- ❌ 长段道歉 + 大量颜文字

注意：即使在闲聊模式下，也不能编造课程。这是数据准确性的底线。`;
                context.log(`[WebSchedule] ⚠️ 无课表数据 + schedule intent → 启用红线级防幻觉模式`);
            } else {
                context.log(`[WebSchedule] ⚠️ 无课表数据但非schedule问题(tool=${intentResult?.tool}) → 跳过红线模式`);
            }
        }

        // 🆕 合并工具上下文（来自智能工具调用层）
        // toolContextPrompt 包含了根据意图自动获取的天气、搜索等数据
        const combinedToolContext = scheduleContextAddition + (toolContextPrompt || '');

        // 🔒 工程化改造：移除所有情感/角色扮演相关的 prompt 注入
        const basePromptRendered = basePrompt.replace('{{CURRENT_USER_ID}}', senderId);
        const personaAdditions = '';
        // 🆕 注入群聊上下文（群聊背景）- 仅作为上下文参考，不作情感回应
        let currentSystemPrompt = `${basePromptRendered}\n${modeStyleOverride}${groupContextSummary}\n【当前系统时间(北京时间)】${currentTime}\n当前对话的用户昵称是：${userNickname}。${combinedToolContext}${personaAdditions}`;

        // 🎯 责任态约束注入：推演态问题需要结构化输出
        if (gateDecision?.responsibilityMode === 'reason' && gateDecision?.reasonModeConstraints) {
            const constraints = gateDecision.reasonModeConstraints;
            currentSystemPrompt += constraints.text || '';
            context.log(`[责任态] 注入推演态约束 (lang=${constraints.lang})`);
        }

        // 日志记录当前模式（webMode 可能为空：QQ 场景/GET 调试等）
        context.log(`[模式感知] webMode=${webMode || 'null'} inferredMode=${inferredMode} isCopilotMode=${isCopilotMode} isUserProfessionalMode=${isUserProfessionalMode} hasSchedule=${webSchedule && webSchedule.length > 0}`);

        // 调用 AI 封装函数
        const client = token
            ? new OpenAI({
                baseURL: "https://models.github.ai/inference",
                apiKey: token
            })
            : null;

        async function callAI(messages, systemPrompt, opts = {}) {
            if (!client) {
                throw new Error('Token missing');
            }
            const {
                useHistory = true,
                temperature = 0.7,
                maxTokens = 4096,
            } = opts;

            const trimmedHistory = useHistory ? historyForInference.slice(-8) : [];
            const reqMessages = [
                { role: 'system', content: systemPrompt },
                ...trimmedHistory,
                ...messages
            ];

            const request = {
                max_tokens: maxTokens,
                temperature,
                messages: reqMessages
            };

            const modelCandidates = (Array.isArray(RESPONSE_MODELS) ? RESPONSE_MODELS : []).map(m => m?.name).filter(Boolean);
            const { resp } = await chatCompletionWithFallback(client, modelCandidates, request, context, 'chat');
            return resp;
        }

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

            // 【优化5】动态调整回复长度 → 取消限制
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
                                content: `本地联调成功，收到消息：${preview}${preview.length >= 60 ? '...' : ''}`
                            }
                        }
                    ]
                };
            } else {
            
            try {
                response = await callAI([userMessage], currentSystemPrompt, { 
                    useHistory: true,
                    maxTokens: lengthConfig.maxTokens  // 无限制：返回任意长度内容
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
            if (!ARIS_DISABLE_POSTPROCESS && !isSystemLikeMode && (REPLY_CONFIG.ENABLE_EMOJI_CONVERSION || REPLY_CONFIG.ENABLE_AI_SPEAK_FIX)) {
                const beforeProcess = aiReply;
                aiReply = aiPostProcess(aiReply);
                if (beforeProcess !== aiReply) {
                    context.log(`[P0-后处理] 原文: ${beforeProcess.substring(0,50)}... -> 处理后: ${aiReply.substring(0,50)}...`);
                }
            }

            // ⏱️ 可选短回复裁剪（默认关闭）。若开启可避免单条消息过长。
            if (REPLY_CONFIG.ENFORCE_SHORT_REPLY) {
                aiReply = enforceShortReply(aiReply, REPLY_CONFIG.MAX_CHARS, REPLY_CONFIG.MAX_SENTENCES);
            }
            
            // 🎭 将“生硬拒绝”转换为可解释拒绝（不含拟人化动作/撒娇）
            // 只有第一人称明确拒绝且未被 gate 放行时才套用 Schema，确保正常回答直通
            const firstPersonRefusalPatternZh = /(?:^|[\s，。])(?:我|我们|系统|机器人|助手|assistant|bot)(?:目前)?(?:无法|不能|不便|不会|拒绝)(?:[^，。；]{0,12})?(回答|提供|协助|帮助|处理|完成|支持)/i;
            const firstPersonRefusalPatternEn = /(?:^|\b)(i|we|assistant|bot|system)\s+(?:cannot|can't|unable to|won't|do not|don't|refuse to)\s+(answer|provide|assist|help|process|comply|support)/i;
            const hasExplicitRefusal = firstPersonRefusalPatternZh.test(aiReply) || firstPersonRefusalPatternEn.test(aiReply);

            if (gateDecision?.action === 'proceed' && !hasExplicitRefusal) {
                context.log(`[后处理] gate=proceed，正常回答直通，跳过拒绝Schema`);
            } else if (hasExplicitRefusal) {
                const beforeRefusal = aiReply;
                aiReply = replaceRobotRefusal(aiReply);
                if (beforeRefusal !== aiReply) {
                    context.log(`[后处理] 检测到第一人称拒绝，应用Schema: ${beforeRefusal.slice(0,60)}... → ${aiReply.slice(0,60)}...`);
                }
            } else {
                context.log(`[后处理] 未检测到拒绝意图，保持原文`);
            }

            // ⛔️ 时间断言 guardrail：当“确实没有任何课表数据上下文”时，禁止输出具体到某天/具体时段的断言
            // 目的：防止在无数据场景下暗示有隐藏课表；同时避免误伤已有动态课表/事实材料场景的真实课程时间。
            const hasAnyScheduleContext =
                (Array.isArray(webSchedule) && webSchedule.length > 0) ||
                !!(toolContext && toolContext.scheduleData) ||
                (typeof scheduleContextAddition === 'string' && scheduleContextAddition.includes('【🚨 回答指南 - 决赛级精度要求】'));
            aiReply = enforceTimeClaimGuardrail(aiReply, { hasVerifiableSchedule: hasAnyScheduleContext });

            context.log(`[AI回复最终] ${aiReply}`);
            
            // 为用户提供简短指令提示（已隐藏，内部处理）
            // aiReply = appendQuickHints(aiReply);

            // 存入记忆
            if (cosmosContainer) {
                // ⚠️ 核心修复：过滤拒绝模板，避免污染历史记忆
                const isRefusalTemplate = /【原因标签：|我能提供的替代帮助：|我不确定的地方：|如果要继续：/.test(aiReply);
                const cleanedReply = isRefusalTemplate 
                    ? aiReply.split('\n').filter(line => !/【原因标签：|替代帮助|不确定的地方|如果要继续/.test(line)).join('\n').trim() || '(系统拒绝模板已过滤)'
                    : aiReply;
                
                if (isRefusalTemplate) {
                    context.log(`[记忆过滤] 检测到拒绝模板，存储清洗版本: ${cleanedReply.slice(0,40)}...`);
                }
                
                history.push({ role: "user", content: textForMemory });
                history.push({ role: "assistant", content: cleanedReply });
                
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
                
                try {
                    await cosmosContainer.items.upsert({
                        id: dbKey, 
                        history: history,
                        activity: userActivityData, // B. 保存活跃度数据
                        affection: resDoc?.affection || {}, // 保留历史字段（但不再更新）
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

            // ==========================================
            // 🆕 Web/QQ 双链路分离 - 响应处理
            // ==========================================
            const isResponseFromQQ = body?.post_type === 'message';
            const isResponseFromWeb = !body?.post_type && body?.message;
            
            // 🆕 前缀机制（内部标记，转发时去掉）
            let channelPrefix = '';
            let reasoningChain = null;
            
            if (isResponseFromWeb) {
                channelPrefix = '[WEB]';
                // 🆕 Web端：收集思维链（从 intentResult 中提取）
                reasoningChain = {
                    intent_detected: intentResult?.intent || 'unknown',
                    confidence: intentResult?.confidence || 0,
                    tools_used: [],
                    reasoning_steps: []
                };
                
                // 添加工具使用记录
                if (intentResult?.needsSchedule && toolContext?.scheduleData) {
                    reasoningChain.tools_used.push('schedule_query');
                    reasoningChain.reasoning_steps.push('检测到课表查询意图，从本地数据库获取课表数据');
                }
                if (intentResult?.needsWeather && toolContext?.weatherData) {
                    reasoningChain.tools_used.push('weather_api');
                    reasoningChain.reasoning_steps.push(`检测到天气查询意图，调用天气API获取${intentResult?.detectedLocation || ''}天气`);
                }
                if (intentResult?.needsSearch && toolContext?.searchData) {
                    reasoningChain.tools_used.push('hybrid_search');
                    reasoningChain.reasoning_steps.push(`检测到搜索意图，执行混合搜索: ${toolContext.searchData.source}`);
                }
                if (!reasoningChain.tools_used.length) {
                    reasoningChain.tools_used.push('llm_chat');
                    reasoningChain.reasoning_steps.push('无特殊工具需求，直接使用LLM对话');
                }
                
                context.log(`[Web思维链] ${JSON.stringify(reasoningChain)}`);
            } else if (isResponseFromQQ) {
                channelPrefix = '[QQ]';
                // QQ端不返回思维链
                context.log(`[QQ链路] 回复长度: ${finalResponseBody.length} 字符`);
            }

            // 🔇 语音路由已禁用 (2024-12: GitHub URL 直链语音不适用于 Web 前端)
            // const audioSource = getAudioSource(aiReply, context);
            // if (audioSource && audioSource.source === "URL") {
            //     const audioCQ = `[CQ:record,file=${audioSource.url},cache=0]`;
            //     finalResponseBody = `${audioCQ}\n${finalResponseBody}`;
            //     context.log(`[语音路由] 发送 GitHub 音频: ${audioSource.url}`);
            // }

            // ✅ 更新 lastBotReply（在返回前）
            const sessionKey = `${dbKey}:${senderId}`;
            await updateLastBotReply(cosmosContainer, dbKey, sessionKey, context);

            // 🆕 Pillar 4: Accountability - 根据工具类型构建数据来源标签
            let sourceLabel = null;
            let trustLevel = null;
            if (intentResult?.tool === 'schedule' && toolContext?.scheduleData) {
                // 课表查询：来源是本地数据库
                sourceLabel = 'Local Database';
                trustLevel = 'verified';
            } else if (intentResult?.tool === 'weather' && toolContext?.weatherData) {
                // 天气查询：来源是实时 API
                sourceLabel = 'Weather API';
                trustLevel = 'live_search';
            } else if ((intentResult?.tool === 'search' || intentResult?.tool === 'wiki') && toolContext?.searchData) {
                // 搜索/百科：根据 hybridSearch 返回的 source 来定
                const src = toolContext.searchData.source;
                if (src === 'llm') {
                    sourceLabel = 'AI Generated';
                    trustLevel = 'ai_generated';
                } else {
                    sourceLabel = src || 'Search Engine';
                    trustLevel = 'live_search';
                }
            }

            logger.logRequestEnd('ok', String(finalResponseBody || '').length);
            logger.logAuditSummary({
                request_id: requestId,
                client: clientInfo.client,
                user_id: senderId,
                intent: intentResult?.intent || 'unknown',
                policy_version: policySelection?.version,
                policy_source: policySelection?.source,
                tools_used: deriveToolsFromIntent(intentResult),
                cost: { latency_ms: Date.now() - requestStartTs },
                outcome: 'success'
            });

            // 🆕 构建响应体（Web/QQ 差异化）
            const responsePayload = {
                reply: finalResponseBody,
                persona: effectivePersona,
                meta: {
                    requestId,
                    tool: intentResult?.tool || null,
                    intent: intentResult?.intent || null,
                    safety_protocol: intentResult?.safetyProtocol || 'none',
                    safety_category: intentResult?.safetyCategory || '',
                    sourceLabel: sourceLabel,
                    trustLevel: trustLevel,
                    policyVersion: policySelection?.version,
                    policySource: policySelection?.source,
                    client: clientInfo.client,
                    latencyMs: Date.now() - requestStartTs,
                    // 🆕 渠道标识
                    channel: isResponseFromWeb ? 'web' : (isResponseFromQQ ? 'qq' : 'unknown'),
                    // 🔍 调试信息
                    _debug: {
                        historyLen: history?.length || 0,
                        webChatHistoryLen: webChatHistory?.length || 0,
                        detectedLocation: intentResult?.detectedLocation || '',
                        needsWeather: intentResult?.needsWeather || false,
                        shouldAskUser: intentResult?.shouldAskUser || false,
                        hasWeatherData: !!toolContext?.weatherData,
                        // 🆕 安全链路状态
                        safetyBypassed: isQQSafetyBypassed,
                        // 🆕 语境解析结果
                        semanticResolution: semanticResolution ? {
                            subject: semanticResolution.subject,
                            dependsOnContext: semanticResolution.dependsOnContext,
                            reason: semanticResolution.contextDependencyReason
                        } : null
                    }
                },
                auto_escape: false
            };
            
            // 🆕 Web端额外返回思维链
            if (isResponseFromWeb && reasoningChain) {
                responsePayload.reasoning = reasoningChain;
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify(responsePayload)
            };

        } catch (error) {
            context.error("[AI错误]", error);
            return { 
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ reply: "服务暂时不可用，请稍后重试。" }) 
            };
        }
    }
});
