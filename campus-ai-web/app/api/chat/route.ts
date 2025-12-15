// NOTE: Use Node.js runtime to allow local development calls to http://127.0.0.1:7071
// (Edge runtime can be restrictive for localhost/network access in dev.)
export const runtime = 'nodejs';

import crypto from 'crypto';

// 戳一戳回复 - 根据心情状态返回不同回复
const POKE_REPLIES_BY_MOOD: Record<string, Array<{ reply: string; emotion: string }>> = {
  happy: [
    { reply: "嗯？有什么事吗？(*^ω^*)", emotion: "happy" },
    { reply: "Aris在这里！有什么可以帮您的吗？✨", emotion: "excited" },
    { reply: "哇哦，被戳到了！(๑•̀ㅂ•́)و✧", emotion: "shy" },
    { reply: "邦邦咔邦！Aris登场！(≧∇≦)/", emotion: "excited" },
    { reply: "嘿嘿，找Aris有什么事呀？(✿◠‿◠)", emotion: "happy" },
  ],
  normal: [
    { reply: "唔...是在叫我吗？(*´▽`*)", emotion: "shy" },
    { reply: "Aris已就位！请问有什么需要帮助的？📚", emotion: "normal" },
    { reply: "哼哼，Aris感受到了您的召唤！✨", emotion: "happy" },
  ],
  annoyed: [
    { reply: "又戳...有事就说吧。(´-ω-`)", emotion: "annoyed" },
    { reply: "戳来戳去的...到底有什么事？", emotion: "annoyed" },
    { reply: "Aris已经知道了，不用再戳了。(-_-)", emotion: "annoyed" },
  ],
  angry: [
    { reply: "够了！不要再戳了！💢", emotion: "angry" },
    { reply: "再戳就生气了哦！(╬ಠ益ಠ)", emotion: "angry" },
    { reply: "Aris很不高兴！请不要再戳了！😤", emotion: "angry" },
    { reply: "哼！不理你了！", emotion: "angry" },
    { reply: "戳戳戳！烦死了！💢💢💢", emotion: "angry" },
  ],
};

export async function POST(req: Request) {
  try {
    const { message, sessionId, mode = 'Ask', schedule, isPoke, mood, curriculumUuid, persona } = await req.json();

    const requestId = crypto.randomUUID();

    // 戳一戳快速本地响应 - 根据心情返回不同回复
    if (isPoke || message === '[poke]') {
      // 根据 mood 选择回复池
      let replyPool = POKE_REPLIES_BY_MOOD.normal;
      if (mood === 'angry' || mood === 'furious') {
        replyPool = POKE_REPLIES_BY_MOOD.angry;
      } else if (mood === 'annoyed') {
        replyPool = POKE_REPLIES_BY_MOOD.annoyed;
      } else if (mood === 'happy' || mood === 'joyful' || mood === 'excited') {
        replyPool = POKE_REPLIES_BY_MOOD.happy;
      }
      
      const randomReply = replyPool[Math.floor(Math.random() * replyPool.length)];
      return new Response(
        JSON.stringify(randomReply),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!message || typeof message !== 'string') {
      return new Response(
        JSON.stringify({ reply: '消息不能为空' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const safeSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'web_unknown';
    
    const isDev = process.env.NODE_ENV !== 'production';
    const azureFunctionUrl =
      process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL ||
      (isDev
        ? 'http://127.0.0.1:7071/api/schoolBot'
        : 'https://school-bot-gwb4a9gkdwcyhde5.koreacentral-01.azurewebsites.net/api/schoolBot');
    
    const response = await fetch(azureFunctionUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({
        // 兼容 schoolBot 的 NapCat/CQHTTP 消息事件路由
        post_type: 'message',
        message_type: 'private',
        raw_message: message,
        user_id: safeSessionId,
        sender: { nickname: 'Web' },

        // 兼容你前端传参（保留字段不影响 schoolBot）
        message,
        sessionId: safeSessionId,
        mode,

        // 让后端能读取已导入课表（若后端不使用该字段也不会有副作用）
        schedule: Array.isArray(schedule) ? schedule : undefined,
        // 🆕 传递 curriculumUuid 供后端跨周动态查询
        curriculumUuid: typeof curriculumUuid === 'string' ? curriculumUuid : undefined,
        // 🆕 用户可选的人格模式：'alice' (默认) | 'professional' (专业模式)
        persona: persona === 'professional' ? 'professional' : undefined,

        // 🆕 端到端追踪：让 Azure Function 日志可按 requestId 关联
        requestId,
      })
    });

    const rawText = await response.text();
    const data = (() => {
      try {
        return rawText ? JSON.parse(rawText) : null;
      } catch {
        return null;
      }
    })();

    if (!response.ok) {
      const errorMsg =
        (typeof data?.error === 'string' && data.error) ||
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.jsonBody?.message === 'string' && data.jsonBody.message) ||
        (rawText ? rawText.slice(0, 300) : `HTTP ${response.status}`);

      return new Response(
        JSON.stringify({ reply: `后端错误(${response.status}): ${errorMsg}` }),
        { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } }
      );
    }

    // 兼容多种返回形态：{ reply }, { body: { reply } }, { jsonBody: { reply } }
    const reply =
      (typeof data?.reply === 'string' && data.reply) ||
      (typeof data?.body?.reply === 'string' && data.body.reply) ||
      (typeof data?.jsonBody?.reply === 'string' && data.jsonBody.reply) ||
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.jsonBody?.message === 'string' && data.jsonBody.message) ||
      '';
    
    return new Response(
      JSON.stringify({ reply: reply || '抱歉,我现在无法回答 (｡•́︿•̀｡)', requestId }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'x-request-id': requestId,
          'x-azure-backend-url': azureFunctionUrl,
        }
      }
    );
    
  } catch (error) {
    console.error('Chat API Error:', error);
    return new Response(
      JSON.stringify({ reply: '连接Alice失败,请稍后重试 (╥﹏╥)' }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
