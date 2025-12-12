export const runtime = 'edge';

/**
 * Plan模式API - 智能计划生成
 * 结合课表、天气、时间生成个性化计划
 */
export async function POST(req: Request) {
  try {
    const { userIntent, userId = "888888888" } = await req.json();

    // Azure Function后端地址
    const azureFunctionUrl = process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL || 
      'http://localhost:7071/api/schoolBot';

    // 调用后端获取课表和天气信息
    const response = await fetch(azureFunctionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        user_id: parseInt(userId),
        message: `计划:${userIntent}` // 使用"计划:"前缀触发Plan模式
      })
    });

    if (!response.ok) {
      throw new Error(`后端返回 ${response.status}`);
    }

    const data = await response.json();

    // 解析返回的计划内容
    const planContent = data.reply || '暂时无法生成计划 (｡•́︿•̀｡)';

    return new Response(
      JSON.stringify({
        success: true,
        plan: planContent,
        timestamp: new Date().toISOString()
      }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error: any) {
    console.error('Plan API Error:', error);
    return new Response(
      JSON.stringify({ 
        success: false,
        error: '生成计划失败,请稍后重试',
        details: error.message 
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
