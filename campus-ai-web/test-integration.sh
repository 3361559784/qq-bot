#!/bin/bash
# ==========================================
# 前后端集成测试脚本
# ==========================================

echo "🚀 Campus AI Web - 前后端集成测试"
echo "=================================="
echo ""

# 检查后端是否运行
echo "📡 步骤1: 检查Azure Function后端..."
BACKEND_URL="http://localhost:7071/api/schoolBot"
if curl -s --max-time 3 "$BACKEND_URL" > /dev/null 2>&1; then
    echo "✅ 后端运行中 ($BACKEND_URL)"
else
    echo "❌ 后端未启动!"
    echo "请在另一个终端运行: func start"
    exit 1
fi
echo ""

# 检查前端依赖
echo "📦 步骤2: 检查前端依赖..."
cd "$(dirname "$0")/.." || exit 1
if [ ! -d "node_modules" ]; then
    echo "⚠️  依赖未安装,正在安装..."
    npm install
else
    echo "✅ 依赖已安装"
fi
echo ""

# 测试后端API
echo "🧪 步骤3: 测试后端API响应..."
RESPONSE=$(curl -s -X POST "$BACKEND_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private", 
    "user_id": 888888888,
    "message": "百科:人工智能"
  }')

if echo "$RESPONSE" | grep -q "reply"; then
    echo "✅ 后端API响应正常"
    echo "预览: $(echo "$RESPONSE" | head -c 100)..."
else
    echo "❌ 后端API响应异常"
    echo "响应: $RESPONSE"
    exit 1
fi
echo ""

# 检查环境变量
echo "⚙️  步骤4: 检查环境变量..."
if [ -f ".env.local" ]; then
    echo "✅ .env.local 文件存在"
    if grep -q "NEXT_PUBLIC_AZURE_FUNCTION_URL" .env.local; then
        echo "✅ NEXT_PUBLIC_AZURE_FUNCTION_URL 已配置"
    else
        echo "⚠️  未找到 NEXT_PUBLIC_AZURE_FUNCTION_URL"
    fi
else
    echo "❌ .env.local 文件不存在!"
    exit 1
fi
echo ""

# 提示启动前端
echo "🎉 所有检查通过!"
echo ""
echo "下一步:"
echo "1. 在新终端运行: cd campus-ai-web && npm run dev"
echo "2. 打开浏览器: http://localhost:3000"
echo "3. 点击 'Search' 模式"
echo "4. 输入 '人工智能' 测试搜索"
echo ""
echo "预期结果:"
echo "- 前端显示搜索结果卡片"
echo "- 显示来源标签(缓存/DuckDuckGo/本地)"
echo "- 可点击链接跳转"
echo ""
