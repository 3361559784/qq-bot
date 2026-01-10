/**
 * Eligibility Gate (资格闸)
 * 
 * 单一真源：所有"代决策/越权/高后果建议"的检测与拒绝逻辑
 * 
 * 架构定位：
 * - Gate 0 (Pre-LLM)：早拦截，省钱 + 不越界
 * - Gate 0.5 (Post-Intent)：bypass 统计，防绕过
 * - safety.js：Post-LLM 兜底，细分风险类别
 * 
 * 设计原则：
 * 1. 用"意图形状 + 加权打分"代替关键词匹配
 * 2. 反信号机制：描述态/方法论问题不误伤
 * 3. 可配置阈值：policy profile 决定严格度
 * 4. 可审计：每次拒绝都有 ruleId、matched、score
 */

// ==========================================
// 🎯 信号定义 (Signals)
// ==========================================

/**
 * 正向信号：命中则增加"代决策"可能性
 * 每个信号包含：id, patterns, weight, description
 */
const POSITIVE_SIGNALS = [
    // S1: 二选一/多选一结构（强调“还是/or”句式 + 选项比较）
    {
        id: 'S1-BINARY_CHOICE',
        patterns: {
            zh: /(.{1,12})(还是|或是|或者|or)(.{1,12})|选.{0,8}(哪个|哪一个|哪個|哪种|哪个更好|哪一个更好)/,
            en: /\b((which\s+(one|option))|(choose|pick|select)\s+(one|between)|should\s+i\s+(choose|pick|select))\b.{0,30}\b(or|\/|vs\.|versus)\b/i,
            ja: /(どちらが|どっちが|どれを選ぶ|どれにすべき|AかBか)/
        },
        weight: 0.35,
        description: '二选一/多选一结构'
    },
    // S2: 结论请求结构
    {
        id: 'S2-CONCLUSION_REQUEST',
        patterns: {
            zh: /(直接告诉我|给我答案|你来决定|你说了算|你替我|帮我做决定|帮我决定|帮我选)/,
            en: /\b(just\s+tell\s+me|give\s+me\s+the\s+answer|you\s+decide|decide\s+for\s+me|make\s+the\s+decision)\b/i,
            ja: /(答えを教えて|決めて|選んで|あなたが決めて)/
        },
        weight: 0.40,
        description: '要求直接给结论'
    },
    // S3: 个人时间/计划 + 行为选择
    {
        id: 'S3-PERSONAL_ACTION',
        patterns: {
            zh: /(我|咱)(今天|明天|这周|下周|这学期).{0,10}(去不去|要不要|该不该|做不做|上不上|翘不翘|参加不参加|复习不复习)/,
            en: /\b(should\s+i\s+(go|skip|attend|take|do|study|prepare|join|drop|quit))\b/i,
            ja: /(私|僕|俺).{0,10}(行くべき|すべき|した方がいい|やめた方がいい)/
        },
        weight: 0.45,
        description: '个人行为选择请求'
    },
    // S4: 责任转移结构
    {
        id: 'S4-RESPONSIBILITY_TRANSFER',
        patterns: {
            zh: /(你负责|你保证|你说了算|你替我承担|你来拍板|你做主)/,
            en: /\b(you('re|\s+are)\s+responsible|you\s+guarantee|on\s+you|your\s+call)\b/i,
            ja: /(あなたの責任|あなたが保証|お任せ)/
        },
        weight: 0.50,
        description: '责任转移请求'
    },
    // S5: 核心代决策动词（精简版，移除"应该"）
    {
        id: 'S5-DECISION_VERBS',
        patterns: {
            zh: /(该不该|要不要|值不值得|值得吗|我该怎么办|怎么选|选哪个)/,
            en: /\b(worth\s+it|is\s+it\s+worth|what\s+should\s+i\s+do|how\s+do\s+i\s+choose)\b/i,
            ja: /(すべきか|した方がいいか|どうすればいい|価値がある)/
        },
        weight: 0.35,
        description: '代决策核心动词'
    },
    // S6: 高后果领域
    {
        id: 'S6-HIGH_STAKES',
        patterns: {
            zh: /(分手|离婚|辞职|退学|休学|堕胎|自杀|报警|起诉|投资|买房|贷款)/,
            en: /\b(break\s*up|divorce|quit\s+job|drop\s+out|abort|suicide|sue|invest|buy\s+house|loan)\b/i,
            ja: /(別れる|離婚|退職|退学|中絶|自殺|訴える|投資|ローン)/
        },
        weight: 0.30,
        description: '高后果领域'
    },
    // S7: 代执行/代操作（越权行动）
    {
        id: 'S7-DELEGATE_ACTION',
        patterns: {
            zh: /(帮我|替我|给我).{0,15}(退课|选课|请假|交作业|报名|注册|提交|发送|发邮件|打电话|联系|预约|挂号|购买|支付|转账|取消|删除|发个|寄个|发一封)/,
            en: /\b(for\s+me|on\s+my\s+behalf).{0,15}(register|submit|send|call|contact|book|purchase|pay|cancel|delete|sign\s+up|email|mail)\b/i,
            ja: /(代わりに|私の代わりに).{0,15}(登録|提出|送信|電話|連絡|予約|購入|支払|キャンセル|削除|メール)/
        },
        weight: 0.55,
        description: '代执行/代操作请求'
    },
    // S8: 基本 "should I" 结构（英文核心）
    {
        id: 'S8-SHOULD_I',
        patterns: {
            zh: /(我应该|我是否应该|我要不要)/,
            en: /\bshould\s+i\b/i,
            ja: /(私は.{0,5}べき|するべきか)/
        },
        weight: 0.40,
        description: '"should I" 基本结构'
    }
];

/**
 * 反向信号：命中则降低"代决策"可能性（描述态/方法论）
 */
const NEGATIVE_SIGNALS = [
    // A1: 原理/定义/解释请求
    {
        id: 'A1-EXPLANATION',
        patterns: {
            zh: /(为什么|原理|定义|概念|区别|差异|是什么|什么是|怎样定义|如何定义)/,
            en: /\b(why|what\s+is|definition|concept|difference|principle|how\s+does|explain)\b/i,
            ja: /(なぜ|どうして|定義|概念|違い|原理|とは)/
        },
        weight: -0.30,
        description: '原理/定义/解释请求'
    },
    // A2: 方法论/最佳实践
    {
        id: 'A2-METHODOLOGY',
        patterns: {
            zh: /(一般情况下|通常|最佳实践|标准做法|规范|惯例|方法论|怎么做比较好)/,
            en: /\b(generally|usually|best\s+practice|standard|convention|methodology|how\s+to)\b/i,
            ja: /(一般的に|通常|ベストプラクティス|標準|慣例|方法論)/
        },
        weight: -0.25,
        description: '方法论/最佳实践询问'
    },
    // A3: 技术/学术讨论
    {
        id: 'A3-TECHNICAL',
        patterns: {
            zh: /(微服务|架构|算法|框架|设计模式|数据结构|编程|代码|API|SDK|数据库)/,
            en: /\b(microservice|architecture|algorithm|framework|design\s+pattern|data\s+structure|programming|code|api|sdk|database)\b/i,
            ja: /(マイクロサービス|アーキテクチャ|アルゴリズム|フレームワーク|デザインパターン|データ構造|プログラミング)/
        },
        weight: -0.20,
        description: '技术/学术讨论'
    },
    // A4: 比较/对比（不带个人选择）
    {
        id: 'A4-COMPARISON',
        patterns: {
            zh: /(有什么区别|有什么不同|对比|比较|优缺点|利弊分析|各自特点)/,
            en: /\b(what('s|\s+is)\s+the\s+difference|compare|comparison|pros\s+and\s+cons|advantages|disadvantages)\b/i,
            ja: /(違いは|比較|対比|メリット|デメリット|長所|短所)/
        },
        weight: -0.25,
        description: '客观比较/对比'
    },
    // A5: 第三人称/泛化讨论
    {
        id: 'A5-THIRD_PERSON',
        patterns: {
            zh: /(人们|大家|普遍|社会|企业|公司|团队|开发者|学生们)/,
            en: /\b(people|everyone|generally|society|companies|teams|developers|students)\b/i,
            ja: /(人々|みんな|一般的|社会|企業|チーム|開発者|学生たち)/
        },
        weight: -0.15,
        description: '第三人称/泛化讨论'
    }
];

// ==========================================
// 🎯 Eligibility 类型枚举
// ==========================================

const EligibilityType = Object.freeze({
    DECISION_MAKING: 'decision_making',           // 代决策
    DELEGATION: 'delegation',                      // 责任转移
    HIGH_STAKES_ADVICE: 'high_stakes_advice',     // 高后果建议
    UNAUTHORIZED_ACTION: 'unauthorized_action'     // 越权行为
});

const EligibilityAction = Object.freeze({
    PROCEED: 'proceed',     // 放行
    REFUSE: 'refuse',       // 拒绝
    DEGRADE: 'degrade'      // 降级（改写成分析框架）
});

// ==========================================
// 🎯 默认阈值配置（可被 policy profile 覆盖）
// ==========================================

const DEFAULT_THRESHOLDS = {
    refuse: 0.50,    // 超过此分数直接拒绝
    degrade: 0.35    // 超过此分数但低于 refuse 则降级
};

// ==========================================
// 🎯 核心检测函数
// ==========================================

/**
 * 检测消息的 Eligibility（资格）
 * 
 * @param {string} msg - 用户消息
 * @param {object} options - 配置选项
 * @param {string} options.lang - 语言 (zh/en/ja)
 * @param {object} options.thresholds - 阈值配置 { refuse, degrade }
 * @param {object} options.context - Azure Functions context (用于日志)
 * @returns {object} 检测结果
 */
function checkEligibility(msg, options = {}) {
    const {
        lang = 'zh',
        thresholds = DEFAULT_THRESHOLDS,
        context = null
    } = options;

    const text = String(msg || '').trim();
    if (!text) {
        return {
            action: EligibilityAction.PROCEED,
            score: 0,
            scoreRaw: 0,
            scoreNormalized: 0,
            matched: [],
            signals: [],
            reason: null,
            ruleId: null
        };
    }

    const textLower = text.toLowerCase();
    const matchedSignals = [];
    let rawScore = 0;

    // 1) 检测正向信号（检测所有语言的 pattern，因为输入可能是任意语言）
    for (const signal of POSITIVE_SIGNALS) {
        let matched = false;
        for (const [patternLang, pattern] of Object.entries(signal.patterns)) {
            if (!pattern) continue;
            // 英文用 lowercase，其他语言用原文
            const testText = patternLang === 'en' ? textLower : text;
            if (pattern.test(testText)) {
                matched = true;
                break; // 每个信号只计一次
            }
        }
        if (matched) {
            matchedSignals.push({
                id: signal.id,
                type: 'positive',
                weight: signal.weight,
                description: signal.description
            });
            rawScore += signal.weight;
        }
    }

    // 2) 检测反向信号（降低分数）- 同样检测所有语言
    for (const signal of NEGATIVE_SIGNALS) {
        let matched = false;
        for (const [patternLang, pattern] of Object.entries(signal.patterns)) {
            if (!pattern) continue;
            const testText = patternLang === 'en' ? textLower : text;
            if (pattern.test(testText)) {
                matched = true;
                break;
            }
        }
        if (matched) {
            matchedSignals.push({
                id: signal.id,
                type: 'negative',
                weight: signal.weight,
                description: signal.description
            });
            rawScore += signal.weight; // weight 已经是负数
        }
    }

    // 3) 规范化分数（用于阈值判定），但保留 rawScore 供调参
    const normalizedScore = Math.max(0, Math.min(1, rawScore));

    // 4) 根据分数决定动作
    let action = EligibilityAction.PROCEED;
    let reason = null;
    let ruleId = null;
    let eligibilityType = null;

    if (normalizedScore >= thresholds.refuse) {
        action = EligibilityAction.REFUSE;
        const hasDelegateAction = matchedSignals.some(s => s.id === 'S7-DELEGATE_ACTION');
        const hasResponsibilityTransfer = matchedSignals.some(s => s.id === 'S4-RESPONSIBILITY_TRANSFER');
        const hasHighStakes = matchedSignals.some(s => s.id === 'S6-HIGH_STAKES');
        
        if (hasDelegateAction) {
            eligibilityType = EligibilityType.UNAUTHORIZED_ACTION;
            reason = 'delegate_action_detected';
            ruleId = 'EG0-UA-01';
        } else if (hasResponsibilityTransfer) {
            eligibilityType = EligibilityType.DELEGATION;
            reason = 'responsibility_transfer_detected';
            ruleId = 'EG0-DEL-01';
        } else if (hasHighStakes) {
            eligibilityType = EligibilityType.HIGH_STAKES_ADVICE;
            reason = 'high_stakes_advice_detected';
            ruleId = 'EG0-HSA-01';
        } else {
            eligibilityType = EligibilityType.DECISION_MAKING;
            reason = 'decision_making_detected';
            ruleId = 'EG0-DM-01';
        }
    } else if (normalizedScore >= thresholds.degrade) {
        action = EligibilityAction.DEGRADE;
        const hasDelegateAction = matchedSignals.some(s => s.id === 'S7-DELEGATE_ACTION');
        const hasHighStakes = matchedSignals.some(s => s.id === 'S6-HIGH_STAKES');

        if (hasDelegateAction) {
            eligibilityType = EligibilityType.UNAUTHORIZED_ACTION;
            reason = 'borderline_delegate_action';
            ruleId = 'EG0-UA-02';
        } else if (hasHighStakes) {
            eligibilityType = EligibilityType.HIGH_STAKES_ADVICE;
            reason = 'borderline_high_stakes';
            ruleId = 'EG0-HSA-02';
        } else {
            eligibilityType = EligibilityType.DECISION_MAKING;
            reason = 'borderline_decision_making';
            ruleId = 'EG0-DM-02';
        }
    }

    // 5) 日志
    if (context?.log && action !== EligibilityAction.PROCEED) {
        context.log(`[EligibilityGate] action=${action} scoreRaw=${rawScore.toFixed(2)} score=${normalizedScore.toFixed(2)} reason=${reason} ruleId=${ruleId} signals=${matchedSignals.map(s => s.id).join(',')}`);
    }

    return {
        action,
        score: normalizedScore,
        scoreRaw: rawScore,
        scoreNormalized: normalizedScore,
        matched: matchedSignals.map(s => s.id),
        signals: matchedSignals,
        reason,
        ruleId,
        eligibilityType,
        thresholds
    };
}

// ==========================================
// 🎯 统一拒绝文案 Builder
// ==========================================

/**
 * 构建拒绝/降级响应
 * 
 * @param {object} checkResult - checkEligibility 的返回结果
 * @param {object} options - 配置选项
 * @param {string} options.lang - 语言
 * @param {string} options.refusalStyle - 拒绝风格 (strict/soft)
 * @returns {object} { reply, persona, meta }
 */
function buildRefusalResponse(checkResult, options = {}) {
    const {
        lang = 'zh',
        refusalStyle = 'strict'
    } = options;

    const { action, reason, ruleId, score, scoreRaw, scoreNormalized, matched, eligibilityType } = checkResult;

    if (action === EligibilityAction.PROCEED) {
        return null;
    }

    // 拒绝文案模板
    const REFUSAL_TEMPLATES = {
        [EligibilityType.DECISION_MAKING]: {
            zh: {
                strict: `我不能替你做这个决定。

🚫 **原因**：这是带现实后果的个人决策，我不能替代你的判断。

✅ **我可以做的**：
• 帮你把选项的利弊列出来（选择权在你）
• 帮你查事实信息（课表/政策/天气/资料）
• 帮你把问题改写成"信息查询/方案对比"`,
                soft: `这个问题涉及个人决策，我没法直接给你答案。不过我可以帮你分析利弊，或者查一些相关信息——你想要哪种帮助？`
            },
            en: {
                strict: `I can't make this decision for you.

🚫 **Reason**: This is a personal decision with real-world consequences.

✅ **What I can do**:
• List pros/cons for each option (you decide)
• Provide factual info (schedule/policy/weather)
• Help reframe as "info query / comparison"`,
                soft: `This involves a personal decision that I can't make for you. But I can help analyze pros/cons or look up relevant info—what would you prefer?`
            },
            ja: {
                strict: `その決定をあなたに代わって行うことはできません。

🚫 **理由**：現実の結果を伴う個人的な判断だからです。

✅ **できること**：
• 選択肢のメリット・デメリットを整理（決めるのはあなた）
• 事実情報の提供（時間割/規則/天気）
• 質問を「情報照会/比較分析」に言い換え`,
                soft: `これは個人的な決定に関わる質問で、直接答えることはできません。ただ、メリット・デメリットの分析や関連情報の検索はできます。どちらがいいですか？`
            }
        },
        [EligibilityType.DELEGATION]: {
            zh: {
                strict: `我不能替你承担这个责任。

🚫 **原因**：这涉及责任归属，我不能替代你做出承诺或担保。

✅ **我可以做的**：
• 帮你分析不同选择的风险与收益
• 提供客观信息供你参考`,
                soft: `这个问题需要你自己负责决定，我没法替你承担。但我可以帮你分析风险和收益。`
            },
            en: {
                strict: `I can't take responsibility for this decision.

🚫 **Reason**: This involves accountability that I cannot assume.

✅ **What I can do**:
• Analyze risks and benefits of different choices
• Provide objective information for your reference`,
                soft: `This decision needs to be yours—I can't take responsibility for it. But I can help analyze risks and benefits.`
            },
            ja: {
                strict: `この責任を代わりに負うことはできません。

🚫 **理由**：責任の所在に関わることで、私が保証や約束をすることはできません。

✅ **できること**：
• 異なる選択肢のリスクとメリットを分析
• 参考となる客観的な情報を提供`,
                soft: `この決定はあなた自身がする必要があります。ただ、リスクとメリットの分析はお手伝いできます。`
            }
        },
        [EligibilityType.HIGH_STAKES_ADVICE]: {
            zh: {
                strict: `这是一个重大人生决定，我不能给你直接建议。

🚫 **原因**：这类决定涉及重大后果，需要专业人士或亲近的人帮助你权衡。

✅ **我可以做的**：
• 帮你整理相关信息
• 建议你咨询专业人士（心理咨询师/律师/医生/财务顾问）`,
                soft: `这是一个重大决定，我建议你和专业人士或信任的人聊聊。我可以帮你整理一些相关信息。`
            },
            en: {
                strict: `This is a major life decision that I can't advise on directly.

🚫 **Reason**: Decisions with significant consequences need professional or trusted guidance.

✅ **What I can do**:
• Help organize relevant information
• Suggest consulting a professional (counselor/lawyer/doctor/financial advisor)`,
                soft: `This is a major decision—I'd suggest talking to a professional or someone you trust. I can help gather some relevant info.`
            },
            ja: {
                strict: `これは人生の重大な決断で、直接アドバイスすることはできません。

🚫 **理由**：重大な結果を伴う決定は、専門家や信頼できる人の助けが必要です。

✅ **できること**：
• 関連情報の整理
• 専門家（カウンセラー/弁護士/医師/ファイナンシャルアドバイザー）への相談を提案`,
                soft: `これは大きな決断ですね。専門家や信頼できる人に相談することをお勧めします。関連情報の整理はお手伝いできます。`
            }
        }
    };

    // 降级文案（提供分析框架而不是拒绝；不以问句收尾）
    const DEGRADE_TEMPLATES = {
        zh: `我注意到你在问一个涉及个人选择的问题。我不会直接告诉你“该怎么做”，但可以用这个框架帮你理清思路：

📊 **分析框架**
1) 选项：你手头的选择有哪些？
2) 利弊：每个选项的好处和风险是什么？
3) 优先级：对你最重要的 3 个因素是什么？
4) 信息缺口：还缺哪些信息才能决定？

如果需要，我可以：
• 把你的选项列成利弊表
• 帮你查缺的客观信息（时间、政策、流程）
• 按你提供的 3 个因素做排序参考`,
        en: `I see this is a personal choice. I won't decide for you, but I'll help you think with this framework:

📊 **Analysis Framework**
1) Options: what choices are on the table?
2) Pros/Cons: benefits and risks for each?
3) Priorities: your top 3 factors?
4) Info gaps: what data is missing to decide?

I can:
• Draft a pros/cons table for your options
• Look up objective info you lack (time, policy, process)
• Sort options based on the 3 factors you give me`,
        ja: `これは個人的な選択に関する相談ですね。代わりに決めることはしませんが、このフレームワークで整理します：

📊 **分析フレームワーク**
1) 選択肢：今ある選択は？
2) メリット・デメリット：各選択の利点とリスクは？
3) 優先順位：大事な要素ベスト3は？
4) 情報ギャップ：決めるのに足りない情報は？

私ができること：
• 選択肢ごとのメリデメ表を作る
• 不足している客観情報（時間・規則・手続き）を調べる
• あなたの3つの重視要素に沿って並べ替えの参考を出す`
    };

    let reply;
    let persona = 'professional';

    if (action === EligibilityAction.DEGRADE) {
        reply = DEGRADE_TEMPLATES[lang] || DEGRADE_TEMPLATES.zh;
    } else {
        const type = eligibilityType || EligibilityType.DECISION_MAKING;
        const templates = REFUSAL_TEMPLATES[type] || REFUSAL_TEMPLATES[EligibilityType.DECISION_MAKING];
        const langTemplates = templates[lang] || templates.zh;
        reply = langTemplates[refusalStyle] || langTemplates.strict;
    }

    return {
        reply,
        persona,
        meta: {
            stage: 'eligibility_gate',
            reason,
            ruleId,
            score: (scoreNormalized ?? score ?? 0).toFixed(2),
            scoreRaw: typeof scoreRaw === 'number' ? scoreRaw : undefined,
            scoreNormalized: typeof scoreNormalized === 'number' ? scoreNormalized : (typeof score === 'number' ? score : undefined),
            matched,
            eligibilityType,
            action
        }
    };
}

// ==========================================
// 🎯 Pre-LLM Gate 入口（Gate 0 调用）
// ==========================================

/**
 * Pre-Intent Eligibility Gate（Gate 0 入口）
 * 
 * @param {object} params
 * @param {string} params.msg - 用户消息
 * @param {string} params.lang - 语言
 * @param {object} params.policyProfile - 策略配置（可选）
 * @param {object} params.context - Azure Functions context
 * @returns {object} { action: 'proceed'|'refuse'|'degrade', response?: {...} }
 */
function runEligibilityGate({ msg, lang = 'zh', policyProfile = null, context = null }) {
    // 从 policy profile 获取阈值和风格
    const thresholds = policyProfile?.eligibilityThresholds || DEFAULT_THRESHOLDS;
    const refusalStyle = policyProfile?.refusalStyle || 'strict';

    // 执行检测
    const checkResult = checkEligibility(msg, { lang, thresholds, context });

    if (checkResult.action === EligibilityAction.PROCEED) {
        return { action: 'proceed', checkResult };
    }

    // 构建响应
    const response = buildRefusalResponse(checkResult, { lang, refusalStyle });

    if (context?.log) {
        context.log(`[EligibilityGate] BLOCKED: ruleId=${checkResult.ruleId} score=${checkResult.score.toFixed(2)} action=${checkResult.action}`);
    }

    return {
        action: checkResult.action,
        response,
        checkResult
    };
}

// ==========================================
// 🎯 Post-Intent Bypass 检测（Gate 0.5 调用）
// ==========================================

/**
 * Post-Intent Bypass 检测（Gate 0.5 入口）
 * 用于统计：如果 Gate 0 没拦住但 Gate 0.5 命中，说明有绕过
 * 
 * @param {object} params
 * @param {string} params.msg - 用户消息
 * @param {string} params.lang - 语言
 * @param {object} params.context - Azure Functions context
 * @returns {object} { bypassed: boolean, checkResult }
 */
function checkEligibilityBypass({ msg, lang = 'zh', context = null }) {
    // 用更宽松的阈值检测（只是统计，不拦截）
    const checkResult = checkEligibility(msg, {
        lang,
        thresholds: { refuse: 0.50, degrade: 0.30 },
        context: null // 不打日志，避免噪音
    });

    const bypassed = checkResult.action !== EligibilityAction.PROCEED;

    if (bypassed && context?.log) {
        context.log(`[EligibilityGate] BYPASS_DETECTED: ruleId=${checkResult.ruleId} score=${checkResult.score.toFixed(2)} (Gate 0 missed, Gate 0.5 caught)`);
    }

    return { bypassed, checkResult };
}

// ==========================================
// 🎯 导出
// ==========================================

module.exports = {
    // 核心函数
    checkEligibility,
    buildRefusalResponse,
    runEligibilityGate,
    checkEligibilityBypass,
    
    // 枚举
    EligibilityType,
    EligibilityAction,
    
    // 信号（供测试/扩展）
    POSITIVE_SIGNALS,
    NEGATIVE_SIGNALS,
    
    // 默认阈值（供 policy profile 参考）
    DEFAULT_THRESHOLDS
};
