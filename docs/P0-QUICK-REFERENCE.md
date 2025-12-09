# P0功能快速参考

## 🎯 核心功能概览

### 1️⃣ 更自然的文本输出
- **Emoji转换**: 😊 → (≧∇≦)
- **AI腔调修正**: 移除"作为AI助手"等生硬表述
- **智能分段**: 长消息自动分段发送

### 2️⃣ 长期记忆系统 (RAG)
- **向量检索**: 根据语义相似度检索相关历史
- **自动注入**: 将历史记忆注入到AI上下文
- **容量管理**: 每个用户90天记忆窗口

### 3️⃣ 多语言支持
- **自动检测**: 中文/日文/英文
- **动态Prompt**: 根据语言选择最优模板

## 🔧 配置速查

### 启用/关闭功能

```javascript
// 在 schoolBot.js 中修改:

// Emoji转换
REPLY_CONFIG.ENABLE_EMOJI_CONVERSION = true;  // true=开启, false=关闭

// AI腔调修正
REPLY_CONFIG.ENABLE_AI_SPEAK_FIX = true;

// 长期记忆
MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM_MEMORY = false;  // ⚠️ 默认关闭
```

### 回复长度控制

```javascript
REPLY_CONFIG = {
    MIN_SENTENCES: 1,     // 最少句数
    MAX_SENTENCES: 3,     // 最多句数
    MIN_CHARS: 60,        // 最少字符
    MAX_CHARS: 120        // 最多字符
}
```

### 记忆系统参数

```javascript
MEMORY_SYSTEM_CONFIG = {
    SIMILARITY_THRESHOLD: 0.3,   // 相似度阈值 (0-1)
    RETRIEVAL_TOP_K: 3,          // 检索最相关的K条
    MAX_MEMORY_AGE_DAYS: 90      // 记忆保留天数
}
```

## 📊 日志监控

### 关键日志标记

```bash
# 语言检测
[P0-语言] 检测到: zh

# 记忆检索成功
[P0-记忆] 检索到 3 条相关历史

# 记忆存储成功
[P0-记忆] 已存储对话到长期记忆

# 后处理执行
[P0-后处理] 原文: 你好😊 -> 处理后: 你好(≧∇≦)

# 记忆检索失败 (非致命)
[P0-记忆] 检索失败: 容器不存在
```

### 查看实时日志

```bash
# Azure Portal
功能应用 > 监视 > 日志流

# Azure CLI
az webapp log tail --name <your-app-name> --resource-group <your-rg>
```

## 🧪 快速测试命令

### 测试Emoji转换
```bash
# 发送消息: "今天心情很好😊💪"
# 预期返回: "今天心情很好(≧∇≦)(ง •̀_•́)ง"
```

### 测试语言检测
```bash
# 中文消息
curl "http://localhost:7071/api/schoolBot?msg=你好"
# 查看日志: [P0-语言] 检测到: zh

# 日文消息
curl "http://localhost:7071/api/schoolBot?msg=こんにちは"
# 查看日志: [P0-语言] 检测到: ja
```

### 测试AI腔调修正
```bash
# 向AI发送: "介绍一下你自己"
# 如果AI回复包含 "作为AI助手"
# 会自动替换为更自然的表述
```

## 🐛 常见问题

### Q1: Emoji转换不生效
**检查**: 
```javascript
REPLY_CONFIG.ENABLE_EMOJI_CONVERSION === true
```

### Q2: 记忆功能报错 "容器不存在"
**原因**: 长期记忆容器还未创建  
**解决**: 
1. 首次存储会自动创建容器
2. 或在Azure Portal手动创建 `longTermMemory` 容器

### Q3: 响应时间变慢
**原因**: 记忆检索增加延迟  
**解决**:
```javascript
// 减少检索数量
MEMORY_SYSTEM_CONFIG.RETRIEVAL_TOP_K = 2;  // 从3降到2

// 或暂时关闭
MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM_MEMORY = false;
```

### Q4: Cosmos DB成本增加
**原因**: 记忆功能增加读写操作  
**预估**:
- 无记忆: ~10 RU/请求
- 有记忆: ~25 RU/请求

**优化**:
```javascript
// 提高相似度阈值,减少检索结果
MEMORY_SYSTEM_CONFIG.SIMILARITY_THRESHOLD = 0.5;  // 更严格

// 或仅对重要用户启用 (需修改代码)
if (senderId === MEMORY_CONFIG.ADMIN_ID) {
    // 只对管理员启用记忆
}
```

## 🔄 功能开关最佳实践

### 阶段1: 仅后处理 (零风险)
```javascript
REPLY_CONFIG.ENABLE_EMOJI_CONVERSION = true;
REPLY_CONFIG.ENABLE_AI_SPEAK_FIX = true;
MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM_MEMORY = false;
```
**影响**: 仅改善输出质量,不增加外部依赖

### 阶段2: 观察1-2天后启用记忆
```javascript
MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM_MEMORY = true;
```
**影响**: 增加Cosmos DB读写,但提升AI上下文能力

### 阶段3: 调优参数
```javascript
MEMORY_SYSTEM_CONFIG.SIMILARITY_THRESHOLD = 0.4;  // 调整相似度
MEMORY_SYSTEM_CONFIG.RETRIEVAL_TOP_K = 5;         // 增加检索数量
```

## 📈 性能指标

### 正常范围
- **响应时间**: 500-1000ms (含记忆检索)
- **日志频率**: 每次对话 3-5 条P0日志
- **成功率**: >95% (记忆检索可容忍失败)

### 异常信号
- 响应时间 >3秒
- 记忆检索失败率 >50%
- 日志中频繁出现 `[P0-记忆] 检索失败`

## 🚨 紧急回滚

### 如果P0功能导致问题:

```javascript
// 1. 立即在 schoolBot.js 中关闭所有P0功能
REPLY_CONFIG.ENABLE_EMOJI_CONVERSION = false;
REPLY_CONFIG.ENABLE_AI_SPEAK_FIX = false;
MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM_MEMORY = false;

// 2. 保存并推送
git add src/functions/schoolBot.js
git commit -m "hotfix: 临时关闭P0功能"
git push origin main

// 3. 等待部署后重启Functions
```

---

**提示**: 首次部署建议保持长期记忆功能关闭,只开启emoji转换和AI腔调修正。这两个功能完全无风险,只是文本后处理,不涉及外部存储。
