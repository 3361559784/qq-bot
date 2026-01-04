> **Languages**: [English README](../README.md) | [中文](../README.zh.md) | [日本語](../README.jp.md) | [Русский](../README.ru.md)

# P0 功能集成指南
## 📋 概述
本文档说明如何将三个 P0 优先级功能集成到 `schoolBot.js` 中：
1. **更自然的文本输出** - Prompt优化 & 后处理
2. **会话记忆系统** - RAG & 长期记忆
3. **多语言支持** - 自动检测 & 翻译层

---

## 🔧 集成步骤

### 步骤 1: 添加新功能代码

#### 方法 A: 自动合并（推荐）
将 `p0-enhancements.js` 中的代码段复制到 `schoolBot.js` 的相应位置：

1. **配置常量** → 添加到 `GROUP_COOLDOWN_MS` 之后
2. **辅助函数** → 添加到现有辅助函数区域（`getVoiceToneByAffection` 之后）
3. **修改 ARIS_PROMPT** → 将硬编码数字替换为配置变量

#### 方法 B: 手动导入（快速测试）
在 `schoolBot.js` 顶部添加：
```javascript
const p0Functions = require('./p0-enhancements');
```

---

### 步骤 2: 修改 ARIS_PROMPT

找到 `ARIS_PROMPT` 定义（约 1782 行），修改以下行：

**修改前：**
```javascript
- **回复长度硬性限制**：每次回复 3-4 句话，建议总字数 120-150 字。
```

**修改后：**
```javascript
- **回复长度硬性限制**：每次回复 \${REPLY_CONFIG.MIN_SENTENCES}-\${REPLY_CONFIG.MAX_SENTENCES} 句话，建议总字数 \${REPLY_CONFIG.MIN_CHARS}-\${REPLY_CONFIG.MAX_CHARS} 字。
```

**重要：** 将 ARIS_PROMPT 改为模板字符串（使用反引号 `` ` ` `` 而不是单引号 `'`）

---

### 步骤 3: 集成到主处理逻辑

在 `schoolBot` HTTP 函数的主处理逻辑中（约 4500+ 行附近），添加以下增强：

#### 3.1 语言检测（在生成 AI 回复之前）
```javascript
// 🌐 检测用户语言
const userLang = LANG_CONFIG.AUTO_DETECT ? detectLanguage(cleanMsg) : LANG_CONFIG.DEFAULT_LANG;
context.log(`[语言检测] 识别为: ${userLang}`);

// 获取对应语言的 Prompt（如果有）
const langPrompt = getPromptByLanguage(userLang, userId);
const systemPrompt = langPrompt || ARIS_PROMPT; // 使用特定语言 prompt 或默认中文
```

#### 3.2 记忆检索（在构建 messages 之前）
```javascript
// 📝 检索相关长期记忆
let relevantMemories = [];
if (MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM) {
    relevantMemories = await retrieveRelevantMemories(userId, cleanMsg, MEMORY_SYSTEM_CONFIG.TOP_K_MEMORIES, context);
    const memoryContext = formatMemoriesForPrompt(relevantMemories);
    if (memoryContext) {
        systemPrompt += memoryContext;
    }
}
```

#### 3.3 后处理（在获得 AI 回复后）
```javascript
// ✨ 智能后处理
let processedReply = aiPostProcess(aiReply);

// 如果返回数组（分段消息），发送多条
if (Array.isArray(processedReply)) {
    for (const segment of processedReply) {
        await sendMessageToGroup(groupId, segment, context);
        await sleep(800); // 分段间延迟
    }
} else {
    aiReply = processedReply;
    // 继续原有逻辑...
}
```

#### 3.4 存储记忆（在对话结束后）
```javascript
// 💾 存储长期记忆（异步，不阻塞）
if (MEMORY_SYSTEM_CONFIG.ENABLE_LONG_TERM) {
    const memoryContent = `用户说: ${cleanMsg.substring(0, 100)} | 回复: ${aiReply.substring(0, 100)}`;
    storeLongTermMemory(userId, memoryContent, 'conversation', context).catch(err => {
        context.log(`[记忆存储] 异步存储失败: ${err.message}`);
    });
}
```

---

## ⚙️ 环境变量配置

在 Azure Function 的"配置"→"应用程序设置"中添加：

### 回复优化配置
```env
ARIS_MAX_SENTENCES=4
ARIS_MIN_SENTENCES=3
ARIS_MAX_CHARS=150
ARIS_MIN_CHARS=120
ARIS_SMART_SPLIT=true
ARIS_EMOJI_CONVERT=true
```

### 多语言配置
```env
ARIS_DEFAULT_LANG=zh
ARIS_AUTO_DETECT_LANG=true
```

### 记忆系统配置（可选）
```env
ARIS_LONG_TERM_MEMORY=true
ARIS_MAX_LONG_TERM=50
ARIS_MEMORY_DAYS=30
ARIS_SIMILARITY_THRESHOLD=0.7
ARIS_TOP_K_MEMORIES=3
```

---

## 🧪 测试验证

### 测试 1: 回复优化
**输入:** `@爱丽丝 今天天气真好！😊`  
**预期:** 回复应该：
- 3-4句话
- 120-150字左右
- `😊` 转换为 `(✨ω✨)`
- 没有"作为一个人工智能"等AI腔

### 测试 2: 多语言
**输入:** `@爱丽丝 こんにちは！`  
**预期:** 
- 检测到日语 (`ja`)
- 使用日语 prompt 生成回复
- 回复带有日语风格

**输入:** `@Aris Hello!`  
**预期:**
- 检测到英语 (`en`)
- 使用英语 prompt

### 测试 3: 记忆系统
1. 发送: `@爱丽丝 我最喜欢的颜色是蓝色`
2. 等待几秒
3. 发送: `@爱丽丝 你还记得我的喜好吗？`
**预期:** 回复中提到"蓝色"或相关内容

### 测试 4: 智能分段
**输入:** 一条很长的消息（>200字）  
**预期:** 
- 回复分成2-3段
- 按句子边界切分
- 每段单独发送

---

## 📊 监控与调试

### 日志关键字
- `[语言检测]` - 语言识别结果
- `[记忆系统]` - 记忆存储/检索操作
- `[智能分段]` - 消息分段信息

### 常见问题

#### Q1: 记忆系统不工作？
**检查：**
- `ARIS_LONG_TERM_MEMORY=true` 是否设置
- Cosmos DB 连接是否正常
- 查看日志中的 `[记忆系统]` 错误信息

#### Q2: 语言检测不准确？
**解决：**
- 调整检测阈值（修改 `detectLanguage` 函数中的比例）
- 或者禁用自动检测：`ARIS_AUTO_DETECT_LANG=false`

#### Q3: 回复还是太短？
**检查：**
- `enforceShortReply` 函数是否仍在使用旧的硬编码限制
- 确保 `ARIS_MAX_CHARS` 已设置且生效

#### Q4: Emoji 没有转换？
**检查：**
- `ARIS_EMOJI_CONVERT=true` 是否设置
- `aiPostProcess` 是否被调用
- 查看 `EMOJI_TO_KAOMOJI_MAP` 是否包含该 emoji

---

## 🚀 性能优化建议

### 记忆系统优化
1. **使用真实 Embedding API**（生产环境）：
   ```javascript
   // 替换 simpleVectorize 为 OpenAI Embeddings
   const response = await openai.embeddings.create({
       model: "text-embedding-3-small",
       input: content
   });
   const vector = response.data[0].embedding;
   ```

2. **添加缓存层**：
   - 使用 Redis 缓存最近检索的记忆
   - 减少 Cosmos DB 查询次数

3. **异步处理**：
   - 记忆存储不要阻塞主流程
   - 使用 `Promise.allSettled()` 批量处理

### 响应时间优化
```javascript
// 并行执行语言检测和记忆检索
const [userLang, relevantMemories] = await Promise.all([
    detectLanguage(cleanMsg),
    retrieveRelevantMemories(userId, cleanMsg, 3, context)
]);
```

---

## 📈 下一步扩展

### 短期（1-2周）
- [ ] 添加 Application Insights 监控
- [ ] 实现内部命令状态机 (`/继续 /停止 /换题`)
- [ ] 优化 Prompt 模板（A/B 测试）

### 中期（1个月）
- [ ] 集成真实向量数据库（Azure Cognitive Search）
- [ ] 添加内容审核层（Moderation API）
- [ ] 实现用户偏好学习

### 长期（2-3个月）
- [ ] 多轮对话上下文管理
- [ ] 语音识别与语音回复
- [ ] 游戏化互动模块

---

## 📝 代码审查清单

部署前请确认：
- [ ] 所有配置常量已添加
- [ ] ARIS_PROMPT 已改为模板字符串
- [ ] 主处理逻辑已集成 4 个关键点
- [ ] 环境变量已在 Azure 配置
- [ ] 本地测试通过（至少 3 个测试用例）
- [ ] 日志输出正常
- [ ] 错误处理完善（try-catch）
- [ ] 没有硬编码的敏感信息

---

## 🆘 技术支持

如遇问题，请提供：
1. 错误日志（完整堆栈）
2. 触发问题的输入消息
3. 环境变量配置（脱敏）
4. Azure Function 版本信息

---

**版本:** 1.0.0  
**最后更新:** 2025-12-09  
**作者:** AI Agent Development Team
