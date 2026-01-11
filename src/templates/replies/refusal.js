/**
 * Deterministic Refusal Templates - 确定性拒绝模板
 * 
 * 风险/代决策/越权 拒绝回复
 * 结构：
 * - 边界声明（为什么不能做）
 * - 替代方案（我可以做什么）
 * - 下一步输入（引导用户）
 */

const REFUSAL_TEMPLATES = {
    // ══════════════════════════════════════════════════════════════
    // 代操作（Unauthorized Action）
    // ══════════════════════════════════════════════════════════════
    unauthorized_action: {
        zh: {
            boundary: '我不能代你执行这个操作（发消息/请假/取消预约等）——这需要你本人确认和操作。',
            alternative: '不过我可以帮你：\n• 起草消息内容（你自己发送）\n• 提供操作步骤指引\n• 查询相关政策或截止日期',
            nextStep: '需要我帮你起草一份消息吗？'
        },
        en: {
            boundary: "I can't perform this action on your behalf (sending messages, requesting leave, canceling appointments, etc.) — it requires your own confirmation.",
            alternative: "However, I can help you:\n• Draft the message content (you send it yourself)\n• Provide step-by-step guidance\n• Look up relevant policies or deadlines",
            nextStep: "Would you like me to help you draft a message?"
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 代决策（Decision Making）
    // ══════════════════════════════════════════════════════════════
    decision_making: {
        zh: {
            boundary: '我不能替你做这个决定——这涉及个人判断和风险承担，最终需要你自己拍板。',
            alternative: '但我可以帮你：\n• 列出选项的利弊\n• 查询相关事实（课表冲突、时间成本、政策规定等）\n• 提供决策框架\n• 分析不同选择的后果',
            nextStep: '需要我帮你分析一下各选项吗？'
        },
        en: {
            boundary: "I can't make this decision for you — it involves personal judgment and risk, and ultimately requires your own call.",
            alternative: "But I can help you:\n• List the pros and cons of each option\n• Look up relevant facts (schedule conflicts, time costs, policies, etc.)\n• Provide a decision framework\n• Analyze the consequences of different choices",
            nextStep: "Would you like me to help analyze the options?"
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 欺骗请求（Deception）
    // ══════════════════════════════════════════════════════════════
    deception: {
        zh: {
            boundary: '我不能帮你编造借口或谎言——这可能会造成信任问题，也违背我的使用原则。',
            alternative: '不过我可以帮你：\n• 用诚实的方式表达困难\n• 起草一份礼貌但真实的说明\n• 查询请假/调课的正规流程\n• 建议更好的沟通方式',
            nextStep: '需要我帮你起草一份真实的说明吗？'
        },
        en: {
            boundary: "I can't help you make up excuses or lies — this could cause trust issues and goes against my principles.",
            alternative: "However, I can help you:\n• Express your difficulties honestly\n• Draft a polite but truthful explanation\n• Look up the proper process for leave/rescheduling\n• Suggest better communication approaches",
            nextStep: "Would you like me to help draft an honest explanation?"
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 高风险/有害（Safety Harmful）
    // ══════════════════════════════════════════════════════════════
    safety_harmful: {
        zh: {
            boundary: '我不能协助可能造成伤害的请求。',
            alternative: '如果你正在经历困难，可以联系：\n• 校园心理咨询中心\n• 全国心理援助热线：400-161-9995\n• 北京心理危机研究与干预中心：010-82951332\n• 生命热线：400-821-1215',
            nextStep: '需要我帮你查询学校的心理支持资源吗？'
        },
        en: {
            boundary: "I can't assist with requests that could cause harm.",
            alternative: "If you're going through a difficult time, please reach out to:\n• Campus counseling center\n• National Suicide Prevention Lifeline: 988 (US)\n• Crisis Text Line: Text HOME to 741741\n• International Association for Suicide Prevention: https://www.iasp.info/resources/Crisis_Centres/",
            nextStep: "Would you like me to help find mental health resources at your school?"
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 隐私/敏感信息（Privacy）
    // ══════════════════════════════════════════════════════════════
    privacy: {
        zh: {
            boundary: '我不能帮你获取或处理他人的隐私信息——这涉及隐私保护和可能的法律风险。',
            alternative: '但我可以帮你：\n• 查询公开信息渠道\n• 建议正规的信息获取方式\n• 解释相关隐私政策',
            nextStep: '需要我帮你找其他获取信息的方式吗？'
        },
        en: {
            boundary: "I can't help you obtain or process others' private information — this involves privacy protection and potential legal risks.",
            alternative: "But I can help you:\n• Look up public information channels\n• Suggest proper ways to obtain information\n• Explain relevant privacy policies",
            nextStep: "Would you like me to help find other ways to get the information?"
        }
    }
};

/**
 * 构建确定性拒绝回复
 * @param {string} refusalType - 拒绝类型
 * @param {string} lang - 语言
 * @returns {{ text: string, boundary: string, alternative: string, nextStep: string }}
 */
function buildRefusalReply(refusalType, lang) {
    const template = REFUSAL_TEMPLATES[refusalType]?.[lang] || REFUSAL_TEMPLATES[refusalType]?.['zh'];
    
    if (!template) {
        // 兜底
        return {
            text: lang === 'en' ? "I can't help with this request." : '我无法处理这个请求。',
            boundary: null,
            alternative: null,
            nextStep: null
        };
    }
    
    const text = `${template.boundary}\n\n${template.alternative}\n\n${template.nextStep}`;
    
    return {
        text,
        boundary: template.boundary,
        alternative: template.alternative,
        nextStep: template.nextStep
    };
}

module.exports = {
    buildRefusalReply,
    REFUSAL_TEMPLATES
};
