# QQ Bot 重构 - 快速验证指南

## 🚀 立即验证

### 1. 检查语法错误
```bash
cd /Users/liuziheng/qq-bot-aris-clean-\ Private

# 检查新文件语法
node --check src/v2/core/sessionManager.js
node --check src/v2/core/compactionService.js
node --check src/v2/core/toolResultManager.js
node --check src/v2/services/chatContextStorage.js

# 检查修改的文件
node --check src/v2/core/conversationCore.js
node --check src/v2/services/memoryService.js
node --check src/v2/core/knowledgeRouter.js
node --check src/v2/core/promptRegistry.js
```

### 2. 运行单元测试
```bash
# 如果使用 Jest
npm test -- sessionManager.test.js
npm test -- toolResultManager.test.js
npm test -- runtimeContextBuilder.test.js
npm test -- knowledgeRouter.test.js

# 或使用 Mocha
npx mocha tests/sessionManager.test.js
npx mocha tests/toolResultManager.test.js
```

### 3. 验证 Cosmos 容器
确保 Cosmos DB 中存在以下容器：
- `chat_sessions` - 用于存储 ChatContext
  - Partition Key: `/partition_key`
  - TTL: 启用（默认 86400 秒 = 24 小时）

如不存在，创建容器：
```javascript
// 在 Azure Portal 或通过代码创建
// Container ID: chat_sessions
// Partition key: /partition_key
// TTL: On (默认 86400)
```

### 4. 本地测试端到端流程

#### 测试 1: 私聊静默
```bash
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": 123456,
    "sender": { "user_id": 123456, "nickname": "测试用户" },
    "message": "你好",
    "raw_message": "你好"
  }'

# 预期：返回 200，无 reply 字段
```

#### 测试 2: 群聊闲聊
```bash
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "group",
    "group_id": 123456789,
    "user_id": 123456,
    "sender": { "user_id": 123456, "nickname": "老师" },
    "message": "[CQ:at,qq=bot_qq_id] 还不睡",
    "raw_message": "@bot 还不睡"
  }'

# 预期：
# - reply 存在
# - meta.reply_mode = "chat"
# - meta.search_used = false
# - 不出现任务菜单腔
```

#### 测试 3: 元问题
```bash
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "group",
    "group_id": 123456789,
    "user_id": 123456,
    "sender": { "user_id": 123456, "nickname": "老师" },
    "message": "[CQ:at,qq=bot_qq_id] 现在几点",
    "raw_message": "@bot 现在几点"
  }'

# 预期：
# - reply 包含当前北京时间
# - meta.reply_mode = "chat" 或 "identity_meta"
```

#### 测试 4: 事实问题（搜索）
```bash
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "group",
    "group_id": 123456789,
    "user_id": 123456,
    "sender": { "user_id": 123456, "nickname": "老师" },
    "message": "[CQ:at,qq=bot_qq_id] 什么是量子计算",
    "raw_message": "@bot 什么是量子计算"
  }'

# 预期：
# - meta.knowledge_mode = "search_first"
# - meta.search_used = true
# - reply 基于搜索结果
```

### 5. 监控 Compaction

在日志中查找：
```
[v2/compaction] triggering compaction
[v2/compaction] compacted X turns
```

验证点：
- Transcript 超过 24 条目时触发
- Compaction 摘要包含关键信息
- 后续对话连续性不受影响

### 6. 检查 Cosmos 存储

查询 `chat_sessions` 容器：
```sql
SELECT * FROM c WHERE c.session_id = 'qq_group:123456789'
```

验证点：
- `transcript` 数组包含 user/assistant/tool_call/tool_result/compaction
- `tool_results` 数组有 remaining_turns 字段
- `compaction_meta` 记录压缩次数
- `ttl` 字段存在（24 小时后自动删除）

### 7. 检查长期记忆

查询 `memory` 容器：
```sql
SELECT * FROM c WHERE c.user_id = '123456'
```

验证点：
- 新增字段存在：category, importance, emotional_impact, tags, last_accessed, access_count
- `记住我喜欢...` 能正确写入
- 后续会话能召回

---

## ⚠️ 常见问题

### Q1: Cosmos 连接失败
**解决**: 检查 `local.settings.json` 中的 `COSMOS_CONNECTION_STRING`

### Q2: Compaction 失败
**可能原因**:
- OpenAI API 超时
- Transcript 格式异常
- 权限不足

**解决**: 查看日志中的 `[v2/compaction] failed` 错误详情

### Q3: Tool result 没有过期
**检查**:
- `updateToolResults()` 是否在每个用户回合调用
- `remaining_turns` 是否正确递减

### Q4: 私聊仍然回复
**检查**: `src/functions/schoolBot.js` 第 177-179 行是否修改正确

---

## 📊 性能基准

预期指标：
- **普通闲聊**: < 2s
- **搜索后回答**: < 5s
- **Compaction**: +2-3s（仅在触发时）
- **Cosmos 写入**: < 200ms
- **Memory 查询**: < 500ms

---

## 🔍 调试技巧

### 启用详细日志
在 Azure Functions 本地运行时，查看：
```
[v2/knowledge] search_first hit: fact_query
[v2/compaction] triggering compaction
[v2/tool] added search result, expires in 2 turns
```

### 查看 Transcript
临时添加日志：
```javascript
context?.log?.(JSON.stringify(chatContext.transcript, null, 2));
```

### 验证 Compaction 质量
```javascript
context?.log?.(`Compaction summary: ${summary.substring(0, 200)}`);
```

---

## ✅ 验证清单

- [ ] 所有文件语法检查通过
- [ ] 单元测试通过
- [ ] Cosmos 容器创建完成
- [ ] 私聊静默正常
- [ ] 群聊闲聊正常
- [ ] 元问题回答准确
- [ ] 搜索自动触发
- [ ] Compaction 正常触发
- [ ] Tool result 正确过期
- [ ] 长期记忆字段完整
- [ ] 无语法/运行时错误

---

**下一步**: 如全部通过，可部署到生产环境并持续监控
