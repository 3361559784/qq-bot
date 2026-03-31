/**
 * 知识路由器
 * 判断问题是否需要"先搜索再回答"
 */

/**
 * 显式能力请求模式（优先级最高）
 */
const EXPLICIT_CAPABILITY_PATTERNS = [
  /画一张|画个|绘图|画图|draw\s+(an?|a)|generate\s+image|生成.*图/i,
  /天气|温度|下雨|weather/i,
  /课表|课程表|明天有课|今天有课|下一节课|下节课|本周课表|下周课表/i
];

/**
 * 事实类问题模式
 * 命中这些模式的问题需要外部知识支撑
 */
const FACT_QUERY_PATTERNS = [
  // 定义类："什么是XX"
  /^(什么是|啥是|何为|what\s+is|define)\s*.{2,}/i,
  /[是吗？].{2,}(是什么|啥|怎么回事)/i,
  
  // 解释类："XX是谁"、"XX有什么特点"
  /.{2,}(是谁|有什么特点|有哪些|怎么样|如何|为什么|为啥|why|how)/i,
  
  // 原理类："XX的原理"、"XX怎么工作"
  /.{2,}(原理|机制|工作原理|怎么运作|怎么实现|背后的)/i,
  
  // 比较类："XX和YY的区别"
  /.{2,}(区别|不同|对比|和.{1,10}比)/i,
  
  // 历史/背景类
  /.{2,}(历史|起源|发展|演变|背景|来历)/i
];

/**
 * 时效性问题模式
 * 这些问题需要最新信息
 */
const TIMELY_QUERY_PATTERNS = [
  /最新|最近|现在|当前|目前|今天|昨天|今年|latest|recent|current/i,
  /.{2,}(新闻|消息|动态|进展|状况|情况|数据|统计)/i,
  /\d{4}年|20\d{2}/  // 具体年份
];

/**
 * 真实性验证模式
 * 这些问题需要可靠来源支撑
 */
const VERIFICATION_PATTERNS = [
  /(真的吗|是真的|确实|有没有证据|来源|可靠吗|准确吗)/i,
  /(听说|据说|有人说).{2,}(真的|假的|对不对)/i
];

/**
 * 外部知识关键词
 * 这些领域通常需要搜索
 */
const EXTERNAL_KNOWLEDGE_KEYWORDS = [
  // 学术/专业
  /(量子|相对论|基因|蛋白质|神经|算法|机器学习|深度学习|区块链|加密|经济学|心理学|社会学)/i,
  
  // 地理/组织
  /(国家|城市|公司|组织|机构|大学|学校)/i,
  
  // 人物（非当前对话参与者）
  /([谁|who].*[创始人|发明|提出|建立])/i
];

/**
 * 闲聊/情感互动模式（不搜索）
 */
const CASUAL_CHAT_PATTERNS = [
  /^(好|嗯|哦|啊|唉|哈|嘿|呀|诶|emmm|em|嘛)/i,
  /^(累|困|饿|渴|冷|热|无聊|开心|难过|生气|烦)/,
  /^(在吗|在不在|干嘛|在干嘛|做什么|忙不忙)/i,
  /^(早|午安|晚安|安|睡了|起床|goodnight|gn)/i,
  /(想睡|要睡|该睡|去睡|睡觉)/i,
  /^[\u4e00-\u9fa5]{1,4}[啊呀吗呢吧哦嘛哈呵]?[？！。～~…]*$/,  // 短句 + 语气词
  /^[a-z\s]{1,15}$/i  // 纯英文短句
];

/**
 * 上下文延续模式（不搜索）
 * 这些是对上一轮的追问，只需要当前对话上下文
 */
const CONTEXT_CONTINUATION_PATTERNS = [
  /^(那|这|然后|接着|继续|还有|再说|对了|所以|因此)/,
  /^(呢|吗|啊|呀)[？?]?$/,
  /^(怎么说|为什么|咋回事|啥意思|详细|具体|展开)/i,
  /^(是吗|真的|假的|对吗|没错|确实)[？?]?$/i
];

/**
 * 元问题模式（不搜索）
 * 关于爱丽丝自身、当前对话的问题
 */
const META_QUESTION_PATTERNS = [
  /(你是谁|你叫啥|你是什么|你是爱丽丝)/i,
  /(你记得|你知道我|长期记忆|长记忆|会记住)/i,
  /(你的模型|底层模型|gpt|openai|prompt|提示词)/i,
  /(现在几点|今天几号|星期几|什么时候)/i,
  /(我是谁|我叫啥|你在和谁说话)/i
];

/**
 * 判断是否需要先搜索
 * @param {string} content - 用户输入内容
 * @param {object} context - 对话上下文（可选）
 * @returns {object} { mode: 'chat' | 'search_first' | 'capability_only', reason: string, confidence: number }
 */
function planKnowledgeMode(content = '', context = {}) {
  const text = String(content || '').trim();
  
  if (!text || text.length < 3) {
    return { mode: 'chat', reason: 'too_short', confidence: 1.0 };
  }

  // 1. 优先级最高：显式能力请求
  if (EXPLICIT_CAPABILITY_PATTERNS.some(re => re.test(text))) {
    return { mode: 'capability_only', reason: 'explicit_capability', confidence: 0.95 };
  }

  // 2. 优先级次高：元问题不搜索
  if (META_QUESTION_PATTERNS.some(re => re.test(text))) {
    return { mode: 'chat', reason: 'meta_question', confidence: 0.95 };
  }

  // 2. 闲聊/情感互动不搜索
  if (CASUAL_CHAT_PATTERNS.some(re => re.test(text))) {
    return { mode: 'chat', reason: 'casual_chat', confidence: 0.9 };
  }

  // 3. 上下文延续不搜索（依赖对话历史）
  if (CONTEXT_CONTINUATION_PATTERNS.some(re => re.test(text))) {
    return { mode: 'chat', reason: 'context_continuation', confidence: 0.85 };
  }

  // 4. 真实性验证需要搜索
  if (VERIFICATION_PATTERNS.some(re => re.test(text))) {
    return { mode: 'search_first', reason: 'verification_needed', confidence: 0.9 };
  }

  // 5. 时效性问题需要搜索
  if (TIMELY_QUERY_PATTERNS.some(re => re.test(text))) {
    return { mode: 'search_first', reason: 'timely_info', confidence: 0.85 };
  }

  // 6. 事实类问题需要搜索
  if (FACT_QUERY_PATTERNS.some(re => re.test(text))) {
    return { mode: 'search_first', reason: 'fact_query', confidence: 0.8 };
  }

  // 7. 外部知识关键词
  if (EXTERNAL_KNOWLEDGE_KEYWORDS.some(re => re.test(text))) {
    return { mode: 'search_first', reason: 'external_knowledge', confidence: 0.75 };
  }

  // 8. 默认：普通聊天
  return { mode: 'chat', reason: 'default_chat', confidence: 0.7 };
}

/**
 * 检查是否应该跳过搜索（即使 knowledge_mode = search_first）
 * @param {object} req - MessageRequest
 * @returns {boolean}
 */
function shouldSkipSearch(req = {}) {
  // 如果有附件（图片/文件），优先处理附件，不搜索
  const attachments = Array.isArray(req.attachments) ? req.attachments : [];
  if (attachments.length > 0) {
    return true;
  }

  // 如果内容太短（搜索无意义）
  const text = String(req.content || '').trim();
  if (text.length < 5) {
    return true;
  }

  return false;
}

/**
 * 格式化搜索结果为上下文注入
 * @param {object} searchResult - hybridSearch 返回结果
 * @returns {string}
 */
function formatSearchContext(searchResult = {}) {
  if (!searchResult || searchResult.status !== 'success') {
    return '';
  }

  const output = searchResult.output || {};
  const trustLevel = String(output.trustLevel || output.trust_level || '').toLowerCase();
  const source = String(output.source || output?.raw?.source || '').toLowerCase();
  if (trustLevel === 'ai_generated' || source === 'llm' || source === 'cache-llm') {
    return '';
  }

  const raw = output.raw || {};
  const results = Array.isArray(output.results)
    ? output.results
    : (Array.isArray(raw.results) ? raw.results : []);
  
  if (results.length === 0) {
    const fallbackMessage = String(output.message || raw.formatted || '').trim();
    if (!fallbackMessage) return '';
    return `🔍 搜索结果摘要:\n${fallbackMessage.slice(0, 1200)}`;
  }

  const lines = ['🔍 搜索结果:'];
  
  results.slice(0, 3).forEach((item, idx) => {
    const title = String(item.title || '').trim();
    const snippet = String(item.snippet || item.content || '').trim().slice(0, 200);
    const source = String(item.url || item.source || '').trim();
    
    lines.push(`${idx + 1}. ${title}`);
    if (snippet) {
      lines.push(`   ${snippet}${snippet.length >= 200 ? '...' : ''}`);
    }
    if (source) {
      lines.push(`   来源: ${source}`);
    }
  });

  return lines.join('\n');
}

module.exports = {
  planKnowledgeMode,
  shouldSkipSearch,
  formatSearchContext
};
