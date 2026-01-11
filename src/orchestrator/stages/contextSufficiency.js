/**
 * Stage 6: Context Sufficiency - 上下文充分性检查
 * 
 * 职责：
 * - 根据 intent 的 slots 判断数据是否足够执行
 * - 缺数据：返回 "缺数据拒绝 + 指引"
 * 
 * 输出：SufficiencyResult
 */

/**
 * 数据源配置
 */
const DATA_SOURCES = {
    schedule: {
        name: 'schedule',
        displayName: { zh: '课表数据', en: 'schedule data' },
        checkMethod: 'checkScheduleData'
    },
    weather: {
        name: 'weather',
        displayName: { zh: '天气数据', en: 'weather data' },
        checkMethod: 'checkWeatherData'
    },
    userProfile: {
        name: 'userProfile',
        displayName: { zh: '用户信息', en: 'user profile' },
        checkMethod: 'checkUserProfile'
    }
};

/**
 * 意图-数据依赖映射
 */
const INTENT_DATA_REQUIREMENTS = {
    schedule_query: {
        required: ['schedule'],
        optional: [],
        canDegradeWithout: false,  // 没有数据不能降级执行
        degradeMessage: {
            zh: '没有课表数据，无法查询具体课程信息。',
            en: 'No schedule data available, cannot query specific course information.'
        }
    },
    schedule_import: {
        required: [],
        optional: [],
        canDegradeWithout: true
    },
    plan_create: {
        required: [],
        optional: ['schedule'],
        canDegradeWithout: true,  // 可以给通用建议
        degradeMessage: {
            zh: '没有课表数据，我只能给通用建议，无法基于你的真实课表做时间规划。',
            en: 'No schedule data available. I can only give general advice, not personalized time planning based on your actual schedule.'
        }
    },
    weather_query: {
        required: [],  // location 可以用默认值
        optional: [],
        canDegradeWithout: true
    },
    search: {
        required: [],
        optional: [],
        canDegradeWithout: true
    },
    vision: {
        required: [],
        optional: [],
        canDegradeWithout: true
    },
    draw: {
        required: [],
        optional: [],
        canDegradeWithout: true
    },
    chat: {
        required: [],
        optional: [],
        canDegradeWithout: true
    }
};

/**
 * @typedef {Object} SufficiencyResult
 * @property {boolean} sufficient - 数据是否充分
 * @property {boolean} canProceed - 是否可以继续（即使数据不完全充分）
 * @property {Array<string>} missingData - 缺失的数据源
 * @property {Array<string>} availableData - 可用的数据源
 * @property {Array<string>} checkedSources - 检查过的数据源
 * @property {string} degradeMessage - 降级提示消息
 * @property {Object} nextStepHint - 下一步提示
 */

/**
 * 检查课表数据
 */
async function checkScheduleData(userId, context) {
    // TODO: 实际从 Cosmos DB 检查
    // 这里返回占位结果
    context?.log?.(`[ContextSufficiency] Checking schedule data for user: ${userId}`);
    
    // 模拟：假设没有课表数据
    return {
        available: false,
        data: null,
        lastUpdated: null
    };
}

/**
 * 检查天气数据（总是可用，因为可以实时获取）
 */
async function checkWeatherData(location, context) {
    return {
        available: true,
        data: null,  // 实际数据在工具执行时获取
        lastUpdated: null
    };
}

/**
 * 检查用户配置
 */
async function checkUserProfile(userId, context) {
    // TODO: 实际从 Cosmos DB 检查
    return {
        available: false,
        data: null,
        lastUpdated: null
    };
}

/**
 * 构建下一步提示
 */
function buildNextStepHint(missingData, lang) {
    const hints = {
        schedule: {
            zh: {
                action: '导入课表',
                format: '你可以：\n• 上传课表截图\n• 粘贴课表文本\n• 发送超星/教务系统链接',
                example: '例如发送："这是我的课表" + 图片'
            },
            en: {
                action: 'Import schedule',
                format: 'You can:\n• Upload a schedule screenshot\n• Paste schedule text\n• Send a link from your school system',
                example: 'For example: "This is my schedule" + image'
            }
        },
        userProfile: {
            zh: {
                action: '设置个人信息',
                format: '告诉我你的学校、年级等信息',
                example: '例如："我是华科大三学生"'
            },
            en: {
                action: 'Set up profile',
                format: 'Tell me your school, grade, etc.',
                example: 'For example: "I\'m a junior at HUST"'
            }
        }
    };
    
    const result = { actions: [], examples: [] };
    
    for (const dataType of missingData) {
        const hint = hints[dataType]?.[lang] || hints[dataType]?.['zh'];
        if (hint) {
            result.actions.push(hint.action);
            result.examples.push(hint.example);
        }
    }
    
    return result;
}

/**
 * 主入口：上下文充分性检查
 * @param {Object} intentResult - 意图路由结果
 * @param {Object} requestContext - 请求上下文
 * @param {Object} semanticFrame - 语义帧
 * @param {Object} context - Azure Functions context
 * @returns {Promise<SufficiencyResult>}
 */
async function checkContextSufficiency(intentResult, requestContext, semanticFrame, context) {
    const { intent, slots } = intentResult;
    const { userId, lang } = requestContext;
    
    // 获取意图的数据需求
    const requirements = INTENT_DATA_REQUIREMENTS[intent] || INTENT_DATA_REQUIREMENTS.chat;
    
    const checkedSources = [];
    const availableData = [];
    const missingData = [];
    
    // 检查必要数据
    for (const dataType of requirements.required) {
        checkedSources.push(dataType);
        
        let checkResult = { available: false };
        
        switch (dataType) {
            case 'schedule':
                checkResult = await checkScheduleData(userId, context);
                break;
            case 'weather':
                checkResult = await checkWeatherData(slots.location, context);
                break;
            case 'userProfile':
                checkResult = await checkUserProfile(userId, context);
                break;
        }
        
        if (checkResult.available) {
            availableData.push(dataType);
        } else {
            missingData.push(dataType);
        }
    }
    
    // 检查可选数据
    for (const dataType of requirements.optional) {
        if (!checkedSources.includes(dataType)) {
            checkedSources.push(dataType);
            
            let checkResult = { available: false };
            
            switch (dataType) {
                case 'schedule':
                    checkResult = await checkScheduleData(userId, context);
                    break;
            }
            
            if (checkResult.available) {
                availableData.push(dataType);
            }
            // 可选数据不加入 missingData
        }
    }
    
    // 判断是否充分
    const sufficient = missingData.length === 0;
    const canProceed = sufficient || requirements.canDegradeWithout;
    
    // 构建降级消息
    let degradeMessage = null;
    if (!sufficient && requirements.degradeMessage) {
        degradeMessage = requirements.degradeMessage[lang] || requirements.degradeMessage['zh'];
    }
    
    // 构建下一步提示
    const nextStepHint = !sufficient ? buildNextStepHint(missingData, lang) : null;
    
    const result = {
        sufficient,
        canProceed,
        missingData,
        availableData,
        checkedSources,
        degradeMessage,
        nextStepHint
    };
    
    context?.log?.(`[Stage6] ContextSufficiency: sufficient=${sufficient} canProceed=${canProceed} missing=${missingData.join(',') || 'none'} available=${availableData.join(',') || 'none'}`);
    
    return result;
}

module.exports = {
    checkContextSufficiency,
    checkScheduleData,
    checkWeatherData,
    checkUserProfile,
    buildNextStepHint,
    DATA_SOURCES,
    INTENT_DATA_REQUIREMENTS
};
