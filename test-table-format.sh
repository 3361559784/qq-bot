#!/bin/bash

# 测试课程查询表格渲染

echo "========================================="
echo "🧪 课程查询表格渲染测试"
echo "========================================="
echo ""

echo "【测试】询问本周课程顺序（含课表数据）"
echo "提问：现在是第几周？我想知道本周课程的顺序。"
echo "预期：1. 使用 Professional 模式（无 Sensei/爱丽丝/邦邦咔邦）"
echo "     2. 使用 Markdown 表格格式展示课程"
echo "---"

response=$(curl -s -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test_table_format",
    "raw_message": "现在是第几周？我想知道本周课程的顺序。",
    "sender": {"nickname": "测试用户"},
    "schedule": [
      {"dayOfWeek": 1, "courseName": "高等数学（一）", "startTime": "08:00", "endTime": "09:40", "location": "E03-A308"},
      {"dayOfWeek": 1, "courseName": "大学英语（一）", "startTime": "10:00", "endTime": "11:40", "location": "E02-207"},
      {"dayOfWeek": 2, "courseName": "物理实验", "startTime": "14:00", "endTime": "15:40", "location": "E01-304"},
      {"dayOfWeek": 3, "courseName": "机械制图", "startTime": "08:00", "endTime": "11:40", "location": "E03-A409"},
      {"dayOfWeek": 4, "courseName": "体育", "startTime": "15:00", "endTime": "16:40", "location": "体育馆"},
      {"dayOfWeek": 5, "courseName": "计算机基础", "startTime": "08:00", "endTime": "09:40", "location": "E04-201"}
    ]
  }' | jq -r '.reply')

echo "$response"
echo ""

# 检查是否使用 Professional 模式
if [[ "$response" == *"Sensei"* ]] || [[ "$response" == *"爱丽丝"* ]] || [[ "$response" == *"邦邦咔邦"* ]] || [[ "$response" == *"(举起拖把)"* ]]; then
  echo "❌ 失败：检测到 Alice 模式特征"
else
  echo "✅ 通过：使用 Professional 模式"
fi

# 检查是否使用表格格式
if [[ "$response" == *"|"* ]] && [[ "$response" == *"星期"* ]] && [[ "$response" == *"课程"* ]]; then
  echo "✅ 通过：使用 Markdown 表格格式"
else
  echo "❌ 失败：未检测到 Markdown 表格格式"
fi

echo ""
echo "========================================="
echo "测试完成！"
echo "========================================="
