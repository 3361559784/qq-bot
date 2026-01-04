# P0 功能环境变量配置模板

## 📝 Azure Function 应用设置

将以下配置添加到 Azure Portal → Function App → 配置 → 应用程序设置

---

## 🎯 回复优化配置 (Reply Optimization)

```properties
# 最大句数（推荐: 3-5）
ARIS_MAX_SENTENCES=4

# 最小句数（推荐: 2-3）
ARIS_MIN_SENTENCES=3

# 最大字数（推荐: 120-200）
ARIS_MAX_CHARS=150

# 最小字数（推荐: 80-150）
ARIS_MIN_CHARS=120

# 启用智能分段（true/false）
ARIS_SMART_SPLIT=true

# Emoji 转颜文字（true/false）
ARIS_EMOJI_CONVERT=true
```

**说明:**
- 根据QQ消息限制，单条消息建议不超过 300 字
- 句数和字数会影响 LLM 成本，请根据实际情况调整
- 智能分段会在内容过长时自动拆分为多条消息

---

## 🌐 多语言配置 (Multi-Language)

```properties
# 默认语言（zh/ja/en）
ARIS_DEFAULT_LANG=zh

# 启用自动语言检测（true/false）
ARIS_AUTO_DETECT_LANG=true
```

**说明:**
- `zh`: 中文（简体）
- `ja`: 日语
- `en`: 英语
- 自动检测基于字符特征，准确率约 85-95%
- 若检测不准确，可设置为 `false` 并指定固定语言

---

## 🧠 记忆系统配置 (Memory System / RAG)

```properties
# 启用长期记忆（true/false，默认: false）
# ⚠️ 需要 Cosmos DB 支持
ARIS_LONG_TERM_MEMORY=true

# 最大长期记忆条数（推荐: 30-100）
ARIS_MAX_LONG_TERM=50

# 记忆保留天数（推荐: 7-90）
ARIS_MEMORY_DAYS=30

# 相似度阈值（0.0-1.0，推荐: 0.6-0.8）
ARIS_SIMILARITY_THRESHOLD=0.7

# 检索Top-K记忆（推荐: 2-5）
ARIS_TOP_K_MEMORIES=3
```

**说明:**
- **ENABLE_LONG_TERM**: 必须设置为 `true` 才能启用记忆功能
- **MAX_LONG_TERM**: 每个用户最多存储的记忆条数
- **MEMORY_DAYS**: 记忆 TTL（Time To Live），过期自动删除
- **SIMILARITY_THRESHOLD**: 相似度越高，检索越精确但结果越少
- **TOP_K_MEMORIES**: 注入 Prompt 的记忆数量，过多会增加 LLM 成本

---

## 🔧 现有配置（保留）

以下配置已存在，请勿删除：

```properties
# GitHub Token (必需)
GITHUB_TOKEN=your_github_token_here

# Cosmos DB 连接字符串 (必需)
COSMOS_DB_STRING=your_cosmos_connection_string

# NapCat API 地址
NAPCAT_API_URL=http://127.0.0.1:6009

# NapCat Token (可选)
NAPCAT_TOKEN=

# 机器人 QQ 号
BOT_QQ_ID=123456789

# 戳一戳配置
POKE_WINDOW_MS=480000
POKE_ANGRY_THRESHOLD=3
POKE_COUNTER_THRESHOLD=5
JUST_REPLIED_MS=15000
USER_POKE_COOLDOWN_MS=2000

# 群消息冷却
GROUP_COOLDOWN_MS=8000
```

---

## 🚀 快速配置（生产环境推荐）

### 方案 A: 保守配置（低成本、稳定）
```properties
ARIS_MAX_SENTENCES=3
ARIS_MIN_SENTENCES=2
ARIS_MAX_CHARS=120
ARIS_MIN_CHARS=90
ARIS_SMART_SPLIT=false
ARIS_EMOJI_CONVERT=true
ARIS_DEFAULT_LANG=zh
ARIS_AUTO_DETECT_LANG=false
ARIS_LONG_TERM_MEMORY=false
```

**适用场景:**
- 预算有限
- 用户量较大
- 不需要复杂记忆功能

---

### 方案 B: 标准配置（推荐）
```properties
ARIS_MAX_SENTENCES=4
ARIS_MIN_SENTENCES=3
ARIS_MAX_CHARS=150
ARIS_MIN_CHARS=120
ARIS_SMART_SPLIT=true
ARIS_EMOJI_CONVERT=true
ARIS_DEFAULT_LANG=zh
ARIS_AUTO_DETECT_LANG=true
ARIS_LONG_TERM_MEMORY=true
ARIS_MAX_LONG_TERM=50
ARIS_MEMORY_DAYS=30
ARIS_SIMILARITY_THRESHOLD=0.7
ARIS_TOP_K_MEMORIES=3
```

**适用场景:**
- 平衡成本与体验
- 需要多语言支持
- 需要基础记忆功能

---

### 方案 C: 高级配置（最佳体验）
```properties
ARIS_MAX_SENTENCES=5
ARIS_MIN_SENTENCES=3
ARIS_MAX_CHARS=200
ARIS_MIN_CHARS=150
ARIS_SMART_SPLIT=true
ARIS_EMOJI_CONVERT=true
ARIS_DEFAULT_LANG=zh
ARIS_AUTO_DETECT_LANG=true
ARIS_LONG_TERM_MEMORY=true
ARIS_MAX_LONG_TERM=100
ARIS_MEMORY_DAYS=90
ARIS_SIMILARITY_THRESHOLD=0.6
ARIS_TOP_K_MEMORIES=5
```

**适用场景:**
- VIP 用户或小规模部署
- 追求最佳用户体验
- 成本不敏感

---

## 📊 配置影响分析

### LLM 成本影响

| 配置项 | 影响 | 成本变化 |
|--------|------|---------|
| MAX_SENTENCES ↑ | 生成更多内容 | +5-10% |
| MAX_CHARS ↑ | 生成更多内容 | +5-10% |
| TOP_K_MEMORIES ↑ | Prompt 更长 | +10-20% |
| AUTO_DETECT_LANG | 额外处理 | +2-3% |

### Cosmos DB 成本影响

| 配置项 | 影响 | 成本变化 |
|--------|------|---------|
| LONG_TERM_MEMORY | 启用存储 | +RU 消耗 |
| MAX_LONG_TERM ↑ | 存储更多 | +存储费用 |
| MEMORY_DAYS ↑ | 保留更久 | +存储费用 |

---

## 🔒 安全注意事项

### 敏感信息保护
```properties
# ❌ 不要在代码中硬编码
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# ✅ 使用 Azure Key Vault（高级）
@Microsoft.KeyVault(SecretUri=https://your-vault.vault.azure.net/secrets/github-token/)
```

### 访问控制
- 启用 Azure Function 身份验证
- 限制 Cosmos DB 访问权限
- 定期轮换 Token 和密钥

---

## 🧪 开发/测试环境配置

```properties
# 开发环境：快速响应、详细日志
ARIS_MAX_SENTENCES=2
ARIS_MIN_SENTENCES=1
ARIS_MAX_CHARS=80
ARIS_MIN_CHARS=50
ARIS_SMART_SPLIT=false
ARIS_EMOJI_CONVERT=true
ARIS_AUTO_DETECT_LANG=true
ARIS_LONG_TERM_MEMORY=false  # 避免污染生产数据
```

---

## 📝 配置检查清单

部署前请确认：

- [ ] 所有必需配置已设置（GITHUB_TOKEN、COSMOS_DB_STRING）
- [ ] 回复长度配置合理（不超过 QQ 消息限制）
- [ ] 记忆系统配置与 Cosmos DB 容量匹配
- [ ] 敏感信息已加密或使用 Key Vault
- [ ] 开发/生产环境配置已分离
- [ ] 已在 Azure Portal 测试配置生效

---

## 🆘 常见配置问题

### Q1: 配置修改后不生效？
**解决:**
1. 重启 Azure Function App
2. 检查配置拼写（区分大小写）
3. 查看应用日志确认读取到新值

### Q2: 记忆系统启用后报错？
**检查:**
- `COSMOS_DB_STRING` 是否正确
- Cosmos DB 是否有 `Conversations` 容器
- 网络连接是否正常

### Q3: 多语言检测不工作？
**检查:**
- `ARIS_AUTO_DETECT_LANG` 是否为 `true`
- 查看日志中的 `[语言检测]` 输出
- 尝试更明显的语言特征输入

---

**配置版本:** 1.0.0  
**最后更新:** 2025-12-09  
**兼容版本:** schoolBot.js v2.0+
