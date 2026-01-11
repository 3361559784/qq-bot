/**
 * Clarification Gate - 澄清状态机
 * 
 * 职责：
 * - 管理澄清状态（TTL 5-10 分钟）
 * - 实现渐进式澄清策略
 * - 防止无限循环
 * 
 * 澄清策略：
 * - attempts=0：目标级澄清
 * - attempts=1：给 2-3 个可点选示例
 * - attempts=2：触发 degrade，输出通用建议 + 停止循环
 */

/**
 * 澄清状态配置
 */
const CLARIFICATION_CONFIG = {
    MAX_ATTEMPTS: 2,
    TTL_MS: 5 * 60 * 1000,  // 5 分钟
    STRATEGY: {
        0: 'target_level',      // 目标级澄清
        1: 'example_options',   // 示例选项
        2: 'degrade'            // 降级
    }
};

/**
 * @typedef {Object} ClarificationState
 * @property {boolean} active - 是否在澄清中
 * @property {string} intentCandidate - 候选意图
 * @property {Array<string>} missingSlots - 缺失槽位
 * @property {number} attempts - 尝试次数
 * @property {string} lastPromptId - 上次使用的提示ID
 * @property {number} createdAt - 创建时间戳
 * @property {number} expiresAt - 过期时间戳
 */

/**
 * 创建新的澄清状态
 */
function createClarificationState(intentCandidate, missingSlots) {
    const now = Date.now();
    return {
        active: true,
        intentCandidate,
        missingSlots,
        attempts: 0,
        lastPromptId: null,
        createdAt: now,
        expiresAt: now + CLARIFICATION_CONFIG.TTL_MS
    };
}

/**
 * 检查澄清状态是否有效
 */
function isClarificationStateValid(state) {
    if (!state || !state.active) return false;
    if (Date.now() > state.expiresAt) return false;
    if (state.attempts >= CLARIFICATION_CONFIG.MAX_ATTEMPTS) return false;
    return true;
}

/**
 * 推进澄清状态
 */
function advanceClarificationState(state, newInput) {
    if (!state) return null;
    
    return {
        ...state,
        attempts: state.attempts + 1,
        lastInput: newInput
    };
}

/**
 * 获取当前澄清策略
 */
function getClarificationStrategy(attempts) {
    return CLARIFICATION_CONFIG.STRATEGY[attempts] || 'degrade';
}

/**
 * 澄清提示模板
 */
const CLARIFICATION_PROMPTS = {
    // ══════════════════════════════════════════════════════════════
    // 目标级澄清（attempts=0）
    // ══════════════════════════════════════════════════════════════
    target_level: {
        plan: {
            zh: {
                text: '你想做什么类型的计划？',
                options: ['学习/复习计划', '运动/健身计划', '项目/工作计划', '其他'],
                promptId: 'CLARIFY_PLAN_TARGET_V1'
            },
            en: {
                text: 'What type of plan do you want to make?',
                options: ['Study/review plan', 'Exercise/fitness plan', 'Project/work plan', 'Other'],
                promptId: 'CLARIFY_PLAN_TARGET_V1'
            }
        },
        schedule_query: {
            zh: {
                text: '你想查哪天的课表？',
                options: ['今天', '明天', '本周', '指定日期'],
                promptId: 'CLARIFY_SCHEDULE_DATE_V1'
            },
            en: {
                text: 'Which day\'s schedule do you want to check?',
                options: ['Today', 'Tomorrow', 'This week', 'Specific date'],
                promptId: 'CLARIFY_SCHEDULE_DATE_V1'
            }
        },
        weather_query: {
            zh: {
                text: '你想查哪个城市的天气？',
                options: ['当前位置', '武汉', '北京', '其他城市'],
                promptId: 'CLARIFY_WEATHER_LOCATION_V1'
            },
            en: {
                text: 'Which city\'s weather do you want to check?',
                options: ['Current location', 'Wuhan', 'Beijing', 'Other city'],
                promptId: 'CLARIFY_WEATHER_LOCATION_V1'
            }
        },
        unclear: {
            zh: {
                text: '我不太确定你想做什么。你想：',
                options: ['查课表', '做学习计划', '查天气', '搜索信息'],
                promptId: 'CLARIFY_INTENT_V1'
            },
            en: {
                text: "I'm not sure what you want to do. Do you want to:",
                options: ['Check schedule', 'Make a study plan', 'Check weather', 'Search for information'],
                promptId: 'CLARIFY_INTENT_V1'
            }
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 示例选项（attempts=1）
    // ══════════════════════════════════════════════════════════════
    example_options: {
        plan: {
            zh: {
                text: '给我一个更具体的例子，比如：',
                examples: [
                    '"帮我规划下周的高数复习"',
                    '"安排每天30分钟的跑步计划"',
                    '"这周末要完成论文，帮我安排时间"'
                ],
                promptId: 'CLARIFY_PLAN_EXAMPLE_V1'
            },
            en: {
                text: 'Give me a more specific example, like:',
                examples: [
                    '"Help me plan math review for next week"',
                    '"Arrange a 30-minute daily running plan"',
                    '"I need to finish my paper this weekend, help me schedule"'
                ],
                promptId: 'CLARIFY_PLAN_EXAMPLE_V1'
            }
        },
        unclear: {
            zh: {
                text: '试试这样说：',
                examples: [
                    '"查一下明天的课表"',
                    '"帮我规划下周的学习时间"',
                    '"北京今天会下雨吗"'
                ],
                promptId: 'CLARIFY_GENERAL_EXAMPLE_V1'
            },
            en: {
                text: 'Try saying something like:',
                examples: [
                    '"Check my schedule for tomorrow"',
                    '"Help me plan my study time for next week"',
                    '"Will it rain in Beijing today"'
                ],
                promptId: 'CLARIFY_GENERAL_EXAMPLE_V1'
            }
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 降级（attempts=2）
    // ══════════════════════════════════════════════════════════════
    degrade: {
        default: {
            zh: {
                text: '我还是不太确定你的具体需求。\n\n我可以帮你：\n• 查询课表和空闲时间\n• 制定学习计划\n• 查询天气\n• 搜索信息\n\n请用一句话告诉我你想做什么。',
                promptId: 'CLARIFY_DEGRADE_V1'
            },
            en: {
                text: "I'm still not sure about your specific needs.\n\nI can help you:\n• Check schedule and free time\n• Make study plans\n• Check weather\n• Search for information\n\nPlease tell me what you want to do in one sentence.",
                promptId: 'CLARIFY_DEGRADE_V1'
            }
        }
    }
};

/**
 * 构建澄清回复
 * @param {Object} intentResult - 意图路由结果
 * @param {string} lang - 语言
 * @param {Object} currentState - 当前澄清状态
 * @returns {{ text: string, nextState: ClarificationState }}
 */
function buildClarificationReply(intentResult, lang, currentState) {
    // 获取或创建澄清状态
    let state = currentState;
    if (!state || !isClarificationStateValid(state)) {
        state = createClarificationState(intentResult.intent, intentResult.missingSlots);
    } else {
        state = advanceClarificationState(state, null);
    }
    
    // 获取当前策略
    const strategy = getClarificationStrategy(state.attempts);
    
    // 获取提示模板
    const strategyPrompts = CLARIFICATION_PROMPTS[strategy];
    const intentPrompts = strategyPrompts?.[intentResult.intent] || strategyPrompts?.[state.intentCandidate] || strategyPrompts?.unclear || strategyPrompts?.default;
    const prompt = intentPrompts?.[lang] || intentPrompts?.['zh'];
    
    if (!prompt) {
        // 兜底
        return {
            text: lang === 'en' ? 'Please tell me more specifically what you need.' : '请更具体地告诉我你需要什么。',
            nextState: state
        };
    }
    
    // 构建回复文本
    let replyText = prompt.text;
    
    // 添加选项（如果有）
    if (prompt.options) {
        replyText += '\n\n';
        prompt.options.forEach((opt, idx) => {
            replyText += `${idx + 1}. ${opt}\n`;
        });
    }
    
    // 添加示例（如果有）
    if (prompt.examples) {
        replyText += '\n';
        prompt.examples.forEach(ex => {
            replyText += `• ${ex}\n`;
        });
    }
    
    // 更新状态
    state.lastPromptId = prompt.promptId;
    
    return {
        text: replyText.trim(),
        nextState: state
    };
}

/**
 * 检查用户输入是否回答了澄清问题
 */
function checkClarificationAnswer(input, state) {
    if (!state || !state.active) return { answered: false };
    
    // 检查是否选择了选项（数字）
    const numMatch = input.match(/^[1-4]$/);
    if (numMatch) {
        return {
            answered: true,
            type: 'option_selection',
            value: parseInt(numMatch[0])
        };
    }
    
    // 检查是否提供了具体内容
    if (input.length > 5) {
        return {
            answered: true,
            type: 'specific_input',
            value: input
        };
    }
    
    return { answered: false };
}

module.exports = {
    createClarificationState,
    isClarificationStateValid,
    advanceClarificationState,
    getClarificationStrategy,
    buildClarificationReply,
    checkClarificationAnswer,
    CLARIFICATION_CONFIG,
    CLARIFICATION_PROMPTS
};
