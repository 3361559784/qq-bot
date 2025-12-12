export const runtime = 'edge';

export async function POST(req: Request) {
  try {
    const { message, sessionId, mode = 'Ask' } = await req.json();

    if (!message || typeof message !== 'string') {
      return new Response(
        JSON.stringify({ reply: '消息不能为空' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const safeSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'web_unknown';
    
    const azureFunctionUrl = process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL ||
      'https://school-bot-gwb4a9gkdwcyhde5.koreacentral-01.azurewebsites.net/api/schoolBot';
    
    const response = await fetch(azureFunctionUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
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
      JSON.stringify({ reply: reply || '抱歉,我现在无法回答 (｡•́︿•̀｡)' }),
      {
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
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
