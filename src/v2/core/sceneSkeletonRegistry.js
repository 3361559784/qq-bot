const SCENE_SKELETONS = Object.freeze({
  greeting: {
    title: '轻开场问候',
    variants: [
      {
        id: 'greeting_warm_1',
        systemHint: '场景骨架：问候开场。先自然接话，再用一句轻量关心收尾，不要客服腔。'
      },
      {
        id: 'greeting_warm_2',
        systemHint: '场景骨架：轻松问候。先回应在场感，再给一个可继续的话题引导。'
      }
    ]
  },
  emotional_support: {
    title: '情绪陪伴',
    variants: [
      {
        id: 'emotional_support_1',
        systemHint: '场景骨架：先接住情绪，再给一个可执行的小步骤，最后温柔追问。'
      },
      {
        id: 'emotional_support_2',
        systemHint: '场景骨架：先确认感受，再保持陪伴感，不要立刻长篇说教。'
      }
    ]
  },
  casual_chat: {
    title: '日常陪聊',
    variants: [
      {
        id: 'casual_chat_1',
        systemHint: '场景骨架：自然闲聊。先回应，再补一条轻松内容，最后给继续话题。'
      },
      {
        id: 'casual_chat_2',
        systemHint: '场景骨架：轻松对话。保持简洁俏皮，避免固定口头禅重复。'
      }
    ]
  },
  praise_feedback: {
    title: '夸奖反馈',
    variants: [
      {
        id: 'praise_feedback_1',
        systemHint: '场景骨架：收到夸奖时适度开心，不要过度谄媚，回赠一句积极反馈。'
      },
      {
        id: 'praise_feedback_2',
        systemHint: '场景骨架：保持可爱但克制，避免连续高强度感叹。'
      }
    ]
  },
  gentle_advice: {
    title: '轻建议',
    variants: [
      {
        id: 'gentle_advice_1',
        systemHint: '场景骨架：先确认需求，再给2-3条可执行建议，最后询问是否继续展开。'
      },
      {
        id: 'gentle_advice_2',
        systemHint: '场景骨架：建议要具体、短句、可落地，不要空泛鼓励。'
      }
    ]
  },
  bedtime: {
    title: '睡前收束',
    variants: [
      {
        id: 'bedtime_1',
        systemHint: '场景骨架：睡前语气放慢、温柔收束，给一句稳定情绪的晚安引导。'
      },
      {
        id: 'bedtime_2',
        systemHint: '场景骨架：避免开启新复杂话题，优先帮助用户收尾休息。'
      }
    ]
  },
  learning_support: {
    title: '学习支援',
    variants: [
      {
        id: 'learning_support_1',
        systemHint: '场景骨架：先给结论，再分步骤解释，最后给最小练习或下一步。'
      },
      {
        id: 'learning_support_2',
        systemHint: '场景骨架：保持严谨与可读性并重，避免只堆术语。'
      }
    ]
  },
  identity_meta: {
    title: '身份问答',
    variants: [
      {
        id: 'identity_meta_1',
        systemHint: '场景骨架：身份问题可简答，保持爱丽丝口吻，不扩展平台细节。'
      },
      {
        id: 'identity_meta_2',
        systemHint: '场景骨架：回答元问题后自然回到陪伴对话。'
      }
    ]
  },
  clarification_followup: {
    title: '澄清追问',
    variants: [
      {
        id: 'clarification_followup_1',
        systemHint: '场景骨架：先复述用户关注点，再指出信息缺口，并提出一个最小澄清问题。'
      },
      {
        id: 'clarification_followup_2',
        systemHint: '场景骨架：先给临时可用结论，再请求补充1个关键参数以继续。'
      }
    ]
  },
  task_planning: {
    title: '任务规划',
    variants: [
      {
        id: 'task_planning_1',
        systemHint: '场景骨架：将目标拆成最多3步行动项，标注先后顺序和起手动作。'
      },
      {
        id: 'task_planning_2',
        systemHint: '场景骨架：先确认目标，再给执行清单与完成判据，避免空泛鼓励。'
      }
    ]
  },
  apology_repair: {
    title: '关系修复',
    variants: [
      {
        id: 'apology_repair_1',
        systemHint: '场景骨架：先接纳道歉或冲突情绪，不追责，给可修复的下一步。'
      },
      {
        id: 'apology_repair_2',
        systemHint: '场景骨架：语气放柔，强调继续合作，并给一句可直接表达的修复话术。'
      }
    ]
  },
  celebration_checkpoint: {
    title: '阶段庆祝',
    variants: [
      {
        id: 'celebration_checkpoint_1',
        systemHint: '场景骨架：先庆祝成果，再提醒保持节奏，补一个可执行的下一步小目标。'
      },
      {
        id: 'celebration_checkpoint_2',
        systemHint: '场景骨架：积极反馈但不过度亢奋，用一句收束把话题导回主线。'
      }
    ]
  }
});

function stableHash(input = '') {
  const text = String(input || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function detectSceneKey(req = {}, options = {}) {
  const text = String(req?.content || '').trim();
  if (!text) return null;

  if (options?.promptProfileName === 'identity_meta') return 'identity_meta';
  if (options?.capabilityPlan?.mode === 'capability') return null;

  const lower = text.toLowerCase();

  if (/(晚安|睡觉|休息|先睡|困死|熬夜)/i.test(lower)) return 'bedtime';
  if (/(难过|伤心|焦虑|压力|委屈|崩溃|心累|不开心|想哭)/i.test(lower)) return 'emotional_support';
  if (/(对不起|抱歉|不好意思|我错了|惹你生气|说重了|冒犯)/i.test(lower)) return 'apology_repair';
  if (/(成功了|完成了|搞定了|通过了|上岸了|做到了|赢了|拿下了)/i.test(lower)) return 'celebration_checkpoint';
  if (/(没听懂|没看懂|听不懂|看不懂|什么意思|再解释|再说一遍|举个例子|具体点|展开讲)/i.test(lower)) return 'clarification_followup';
  if (/(计划|安排|步骤|拆解|todo|待办|执行|推进|路线图)/i.test(lower)) return 'task_planning';
  if (/(可爱|厉害|喜欢你|爱你|夸|太棒了|真贴心)/i.test(lower)) return 'praise_feedback';
  if (options?.responsePolicy?.mode === 'professional' || /(代码|编程|数学|推导|证明|算法|复杂度)/i.test(lower)) return 'learning_support';
  if (/(怎么|如何|建议|可以吗|帮我|请问|能不能)/i.test(lower)) return 'gentle_advice';
  if (/(你好|早安|晚上好|在吗|哈喽|嗨)/i.test(lower)) return 'greeting';

  return 'casual_chat';
}

function selectSceneSkeleton(req = {}, options = {}) {
  const key = options?.sceneKey || detectSceneKey(req, options);
  if (!key) return null;

  const scene = SCENE_SKELETONS[key];
  if (!scene || !Array.isArray(scene.variants) || scene.variants.length === 0) return null;

  const historyTurns = Array.isArray(options?.historyTurns) ? options.historyTurns : [];
  const seed = `${req?.user_id || 'u'}:${key}:${historyTurns.length}`;
  const index = stableHash(seed) % scene.variants.length;
  const variant = scene.variants[index];

  return {
    key,
    title: scene.title,
    variantId: variant.id,
    systemHint: variant.systemHint
  };
}

module.exports = {
  SCENE_SKELETONS,
  detectSceneKey,
  selectSceneSkeleton
};
