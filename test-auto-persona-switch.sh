#!/bin/bash

# 自动 Persona 切换测试脚本
# 测试双模型架构的自动模式切换功能

echo "========================================="
echo "🧪 自动 Persona 切换测试"
echo "========================================="
echo ""

# 测试1：决策类问题（无 persona 参数）→ 应自动使用 Professional
echo "【测试1】决策判断类问题（无 persona 参数）"
echo "提问：我明天有4小时连续空档，合适用来复习线性代数吗？"
echo "预期：Professional 模式（无情绪标签、无 Sensei、直接结论）"
echo "---"
response1=$(curl -s -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test_auto_1",
    "raw_message": "我明天有4小时连续空档，合适用来复习线性代数吗？",
    "sender": {"nickname": "测试"}
  }' | jq -r '.reply')
echo "$response1"
if [[ "$response1" == *"[calm]"* ]] || [[ "$response1" == *"[happy]"* ]] || [[ "$response1" == *"Sensei"* ]]; then
  echo "❌ 失败：检测到 Alice 模式特征"
else
  echo "✅ 通过：使用 Professional 模式"
fi
echo ""

# 测试2：计划类问题（无 persona 参数）→ 应自动使用 Professional
echo "【测试2】计划拆解类问题（无 persona 参数）"
echo "提问：帮我把大作业拆解成具体的学习计划"
echo "预期：Professional 模式"
echo "---"
response2=$(curl -s -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test_auto_2",
    "raw_message": "帮我把大作业拆解成具体的学习计划",
    "sender": {"nickname": "测试"}
  }' | jq -r '.reply')
echo "$response2"
if [[ "$response2" == *"[calm]"* ]] || [[ "$response2" == *"[happy]"* ]] || [[ "$response2" == *"Sensei"* ]]; then
  echo "❌ 失败：检测到 Alice 模式特征"
else
  echo "✅ 通过：使用 Professional 模式"
fi
echo ""

# 测试3：闲聊类问题（无 persona 参数）→ 应使用 Alice
echo "【测试3】闲聊打招呼（无 persona 参数）"
echo "提问：你好呀爱丽丝！"
echo "预期：Alice 模式（有情绪标签、Sensei、游戏术语）"
echo "---"
response3=$(curl -s -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test_auto_3",
    "raw_message": "你好呀爱丽丝！",
    "sender": {"nickname": "测试"}
  }' | jq -r '.reply')
echo "$response3"
if [[ "$response3" == *"["*"]"* ]] || [[ "$response3" == *"Sensei"* ]]; then
  echo "✅ 通过：使用 Alice 模式"
else
  echo "❌ 失败：未检测到 Alice 模式特征"
fi
echo ""

# 测试4：闲聊问题 + 显式指定 professional → 应使用 Professional
echo "【测试4】闲聊问题 + 显式 persona=professional"
echo "提问：你好呀！（但指定 persona=professional）"
echo "预期：Professional 模式（用户指定优先级最高）"
echo "---"
response4=$(curl -s -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test_auto_4",
    "raw_message": "你好呀！",
    "persona": "professional",
    "sender": {"nickname": "测试"}
  }' | jq -r '.reply')
echo "$response4"
if [[ "$response4" == *"[calm]"* ]] || [[ "$response4" == *"[happy]"* ]] || [[ "$response4" == *"Sensei"* ]]; then
  echo "❌ 失败：检测到 Alice 模式特征（用户指定被忽略）"
else
  echo "✅ 通过：使用 Professional 模式（尊重用户显式指定）"
fi
echo ""

# 测试5：MVP核心场景 - "会不会被打断"
echo "【测试5】MVP核心场景：时间冲突判断"
echo "提问：我现在开始复习3小时的《数据结构》会不会被打断？"
echo "预期：Professional 模式（决策类关键词）"
echo "---"
response5=$(curl -s -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test_auto_5",
    "raw_message": "我现在开始复习3小时的《数据结构》会不会被打断？",
    "sender": {"nickname": "测试"}
  }' | jq -r '.reply')
echo "$response5"
if [[ "$response5" == *"[calm]"* ]] || [[ "$response5" == *"[happy]"* ]] || [[ "$response5" == *"Sensei"* ]]; then
  echo "❌ 失败：检测到 Alice 模式特征"
else
  echo "✅ 通过：使用 Professional 模式"
fi
echo ""

echo "========================================="
echo "测试完成！"
echo "========================================="
