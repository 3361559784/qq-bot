# 🔄 自动 Persona 切换 - 快速参考卡

## 📌 一句话总结
后端根据第一层意图检测结果，自动为决策/规划类任务使用 Professional 模式，为闲聊/引导类任务使用 Alice 模式。

---

## 🎯 切换规则

| 意图分类 | 触发条件 | 自动 Persona | 风格特征 |
|---------|---------|------------|---------|
| 决策/规划 | `tool=plan` 或 `tool=schedule` | `professional` | 无情绪标签、无Sensei、条目化 |
| 闲聊/引导 | `tool=chat` 或 `tool=identity` | `alice` | `[happy] Sensei`、邦邦咔邦 |
| 用户显式 | 前端传 `persona` 参数 | 用户指定 | **优先级最高** |

---

## 🧪 快速测试

```bash
# 运行完整测试（5个场景）
./test-auto-persona-switch.sh

# 手动测试决策类
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test",
    "raw_message": "我明天有4小时空档，合适复习吗？",
    "sender": {"nickname": "测试"}
  }'

# 手动测试闲聊类
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": "test",
    "raw_message": "你好呀爱丽丝！",
    "sender": {"nickname": "测试"}
  }'
```

---

## 🔍 关键词示例

### 决策类（触发 Professional）
- "合不合适"、"可以吗"、"会不会被打断"
- "计划"、"规划"、"拆解"、"任务拆解"
- "课表"、"有课"、"下一节课"

### 闲聊类（触发 Alice）
- "你好"、"早上好"、"晚上好"
- "你是谁"、"介绍一下"
- "爱丽丝"、"陪聊"、"聊天"

---

## 📦 文件清单

```
src/functions/schoolBot.js          # 核心实现（Line ~5690, ~5978）
test-auto-persona-switch.sh         # 测试脚本（5个场景）
docs/AUTO_PERSONA_SWITCH.md         # 详细文档
docs/AUTO_PERSONA_SWITCH_COMPLETION.md  # 完成报告
docs/AUTO_PERSONA_SWITCH_QUICKREF.md    # 本文档
```

---

## 🚦 状态检查

```bash
# 检查服务是否运行
lsof -ti:7071

# 查看日志（关注自动切换）
# 查找 "[自动切换]" 和 "[Persona选择]" 日志
```

---

## 💡 前端集成

### 完全自动（推荐）
```javascript
// 不传 persona，让后端自动判断
fetch('/api/schoolBot', {
  method: 'POST',
  body: JSON.stringify({
    post_type: 'message',
    raw_message: userInput,
    user_id: userId
  })
});
```

### 用户可选
```javascript
// 保留 persona 开关，用户可手动切换
fetch('/api/schoolBot', {
  method: 'POST',
  body: JSON.stringify({
    post_type: 'message',
    raw_message: userInput,
    user_id: userId,
    persona: userPreference // 'alice' 或 'professional'
  })
});
```

---

## ⚡ 优先级记忆

```
用户显式指定 > 自动推荐 > 默认（alice）

即：body.persona > autoRecommendedPersona > 'alice'
```

---

## ✅ 验证清单

- [x] 决策类问题自动使用 Professional
- [x] 计划类问题自动使用 Professional
- [x] 闲聊类问题自动使用 Alice
- [x] 用户显式指定优先级最高
- [x] MVP 核心场景稳定输出 Professional
- [x] 所有测试通过（5/5）

---

## 📞 问题排查

**问题**: 决策类问题仍显示 Alice 风格（`[happy] Sensei`）
**检查**:
1. 是否前端传了 `persona: 'alice'`（用户显式指定优先）
2. 查看日志 `[自动切换]` 和 `[Persona选择]`
3. 确认意图检测结果 `intentResult.tool`

**问题**: 闲聊问题显示 Professional 风格
**检查**:
1. 是否前端传了 `persona: 'professional'`
2. 是否触发了关键词（如"计划"、"课表"）导致 `inferredMode` 变化
3. 查看日志确认自动推荐逻辑

---

**最后更新**: 2024-01-XX  
**版本**: 1.0  
**状态**: ✅ 生产可用
