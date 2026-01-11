/**
 * Reply Templates - 回复模板
 * 
 * 三类拒绝模板完全分离：
 * 1. Data Gap - 缺数据
 * 2. Ambiguous - 模糊/需澄清
 * 3. Deterministic Refusal - 风险/代决策
 */

// ══════════════════════════════════════════════════════════════
// 1. Data Gap - 缺数据回复
// ══════════════════════════════════════════════════════════════

const DATA_GAP_TEMPLATES = {
    schedule: {
        zh: {
            main: '我还没有你的课表数据，无法告诉你具体的课程安排。',
            action: '如果你把课表发给我（截图/文件/链接），我可以立即帮你查询。',
            alternative: '或者你也可以直接告诉我课程名称和时间，我记下来。',
            nextStep: '需要我帮你导入课表吗？'
        },
        en: {
            main: "I don't have your schedule data yet, so I can't tell you the specific course arrangement.",
            action: "If you send me your schedule (screenshot/file/link), I can check it immediately.",
            alternative: "Or you can directly tell me the course name and time, I'll note it down.",
            nextStep: "Would you like me to help you import your schedule?"
        }
    },
    location: {
        zh: {
            main: '我不知道你想查哪个城市的天气。',
            action: '告诉我城市名称（如：武汉/北京/上海），我可以帮你查。',
            alternative: null,
            nextStep: '你想查哪个城市？'
        },
        en: {
            main: "I don't know which city's weather you want to check.",
            action: "Tell me the city name (e.g., Wuhan/Beijing/Shanghai), and I can look it up.",
            alternative: null,
            nextStep: "Which city would you like to check?"
        }
    },
    target: {
        zh: {
            main: '我需要知道你想规划什么内容。',
            action: '告诉我具体的目标（如：复习高数/准备面试/完成论文）。',
            alternative: null,
            nextStep: '你想规划什么？'
        },
        en: {
            main: "I need to know what you want to plan.",
            action: "Tell me the specific goal (e.g., review math/prepare for interview/finish paper).",
            alternative: null,
            nextStep: "What would you like to plan?"
        }
    }
};

/**
 * 构建缺数据回复
 */
function buildDataGapReply(sufficiencyResult, lang) {
    const { missingData, nextStepHint } = sufficiencyResult;
    
    if (!missingData || missingData.length === 0) {
        return { text: '', nextStep: null };
    }
    
    const parts = [];
    
    for (const dataType of missingData) {
        const template = DATA_GAP_TEMPLATES[dataType]?.[lang] || DATA_GAP_TEMPLATES[dataType]?.['zh'];
        if (template) {
            parts.push(template.main);
            parts.push(template.action);
            if (template.alternative) {
                parts.push(template.alternative);
            }
        }
    }
    
    // 添加下一步提示
    const firstMissing = missingData[0];
    const firstTemplate = DATA_GAP_TEMPLATES[firstMissing]?.[lang] || DATA_GAP_TEMPLATES[firstMissing]?.['zh'];
    
    return {
        text: parts.join('\n\n'),
        nextStep: firstTemplate?.nextStep || (nextStepHint?.actions?.[0] || null)
    };
}

module.exports = {
    buildDataGapReply,
    DATA_GAP_TEMPLATES
};
