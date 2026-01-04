> **Languages**: [English README](README.md) | [中文](README.zh.md) | [日本語](README.jp.md) | [Русский](README.ru.md)

# 混合搜索系统配置指南

## 系统架构

采用**三层降级策略**,最大化节省成本,保证服务可用性:

```
用户查询 → Layer 1: 本地数据源 (Cosmos DB)
           ↓ 无结果
          Layer 2: SerpAPI (Google 搜索, 100次/月免费)
           ↓ 无结果/失败
          Layer 3: LLM 降级 (GPT-4o-mini 直接回答)
```

### Layer 1: 本地数据源搜索 (优先级最高)
- **数据源**: Cosmos DB (聊天历史、课表数据、用户问答记录)
- **成本**: ✅ 零成本 (使用现有数据库)
- **延迟**: ✅ 50-200ms (本地查询)
- **个性化**: ✅ 基于用户历史数据
- **隐私**: ✅ 数据不离开 Azure 环境

### Layer 2: SerpAPI 搜索 (外部补充)
- **数据源**: Google 搜索结果
- **成本**: ✅ 免费 100次/月 (足够个人使用)
- **延迟**: ⚡ 500-1000ms
- **质量**: ✅ 真实 Google 结果,质量高
- **稳定性**: ✅ 官方 API,不会被封禁

### Layer 3: LLM 降级 (最终兜底)
- **模型**: GPT-4o-mini (GitHub Models)
- **成本**: ✅ 免费 (GitHub 配额)
- **延迟**: ⚡ 1-3s
- **质量**: ⚠️ 生成内容,需标注 "AI 生成"

---

## 配置步骤

### 1. 注册 SerpAPI 账号

#### 访问官网
- 网站: https://serpapi.com/users/sign_up
- 免费计划: 100 searches/month (无需信用卡)

#### 注册流程
1. 使用 GitHub/Google 账号登录
2. 进入 Dashboard: https://serpapi.com/manage-api-key
3. 复制 **API Key** (以 `xxxxxx...` 开头的长字符串)

### 2. 配置本地环境

编辑 `local.settings.json`:
```json
{
  "Values": {
    "SERPAPI_KEY": "your-actual-serpapi-key-here",
    "COSMOS_ENDPOINT": "https://your-cosmos-account.documents.azure.com:443/",
    "COSMOS_KEY": "your-cosmos-key",
    "GITHUB_TOKEN": "your-github-token"
  }
}
```

### 3. 配置 Azure Functions (生产环境)

#### 方法 1: Azure Portal
1. 进入 Azure Functions 应用
2. 设置 → 配置 → 应用程序设置
3. 新建应用程序设置:
   - 名称: `SERPAPI_KEY`
   - 值: `your-actual-serpapi-key-here`
4. 保存并重启

#### 方法 2: Azure CLI
```bash
az functionapp config appsettings set \
  --name your-function-app-name \
  --resource-group your-resource-group \
  --settings SERPAPI_KEY="your-actual-serpapi-key-here"
```

### 4. 运行测试

```bash
# 测试混合搜索系统
node tools/test-hybrid-search.js
```

---

## 使用示例

### 场景 1: 本地数据命中 (最优)
```
用户: 百科 线性代数
机器人: [从本地聊天历史找到]
💾 从本地数据找到关于 "线性代数" 的信息:

1. 历史对话 - 机器人回复
   线性代数是数学的一个分支,主要研究向量空间、线性映射...
   📊 相关度: 100% | 来源: local_chat_history
```

### 场景 2: SerpAPI 补充 (无本地结果)
```
用户: 百科 量子计算
机器人: [本地无结果 → 调用 SerpAPI]
📚 关于 "量子计算" 的搜索结果:

1. 【量子计算机 - 维基百科】
   量子计算机是一种遵循量子力学规律进行高速数学和逻辑运算...
   🔗 https://zh.wikipedia.org/wiki/量子计算机
```

### 场景 3: LLM 降级 (所有搜索失败)
```
用户: 百科 asdfghjklqwertyuiop
机器人: [本地无结果 → SerpAPI 无结果 → LLM 降级]
🤖 AI 回答:

这个词语看起来像是随机字符,没有明确含义...

⚠️ 此回答由 AI 生成,未经搜索验证
```

---

## 成本分析

### 月度成本估算 (个人 QQ 机器人)

| 层级 | 预计使用 | 成本 |
|------|---------|------|
| Layer 1 (本地) | ~80% 命中率 | ¥0 (Cosmos DB 已有) |
| Layer 2 (SerpAPI) | ~15 次/月 | ¥0 (免费额度 100次) |
| Layer 3 (LLM) | ~5 次/月 | ¥0 (GitHub 免费) |
| **总计** | **100 次/月** | **¥0** |

### 与 Bing Search 对比

| 方案 | 免费额度 | 稳定性 | 个性化 | 实际成本 |
|------|----------|--------|--------|----------|
| ❌ Bing Search v7 | ~~1000次/月~~ | ❌ 学生订阅无法创建 | ❌ 无 | 不可用 |
| ✅ 混合搜索 | 本地无限 + SerpAPI 100次 | ✅ 三层降级 | ✅ 本地数据 | ¥0 |

---

## 监控和优化

### 查看搜索统计
混合搜索会自动记录各层调用次数:

```javascript
const { getStats } = require('./services/hybridSearch');

const stats = getStats();
console.log(stats);
// {
//   totalRequests: 100,
//   localHits: 82,      // 82% 本地命中率
//   serpCalls: 13,      // 13% SerpAPI 调用
//   llmFallbacks: 5     // 5% LLM 降级
// }
```

### 查看 SerpAPI 配额
```bash
# 运行测试脚本查看配额
node tools/test-hybrid-search.js

# 输出:
# ✅ SerpAPI 配额: 87/100 剩余
```

### 优化建议

#### 1. 提高本地命中率
- 定期备份重要对话到 Cosmos DB
- 扩充本地知识库 (常见问题、课程信息)
- 优化关键词匹配算法

#### 2. 节省 SerpAPI 配额
- 对相同查询缓存结果 (24小时)
- 对低频查询跳过 SerpAPI,直接 LLM 降级

#### 3. 提升 LLM 降级质量
- 优化 prompt: 明确告知 "无搜索结果"
- 添加免责声明: "⚠️ AI 生成回答"

---

## 故障排查

### 问题 1: SerpAPI 返回 401 错误
```
❌ SerpAPI 密钥无效或已过期
```
**解决**: 
1. 检查 `local.settings.json` 中的 `SERPAPI_KEY`
2. 访问 https://serpapi.com/manage-api-key 确认密钥有效

### 问题 2: SerpAPI 返回 429 错误
```
❌ SerpAPI 配额已用完 (免费额度: 100次/月)
```
**解决**:
1. 等待下月配额重置 (每月 1 号)
2. 升级到付费计划 ($50/月 = 5000次)
3. 系统会自动降级到 LLM 回答

### 问题 3: 本地搜索无结果
```
⚠️ 本地数据源未配置或为空
```
**解决**:
1. 检查 `COSMOS_ENDPOINT` 和 `COSMOS_KEY` 环境变量
2. 确认 Cosmos DB 中有聊天历史/课表数据
3. 使用一段时间后本地数据会自动积累

### 问题 4: 所有层都失败
```
❌ 搜索服务暂时不可用
所有搜索层均失败:
- 本地数据: 无匹配结果
- SerpAPI: 调用失败或配额耗尽
- LLM 降级: 生成失败
```
**解决**:
1. 检查网络连接
2. 检查所有环境变量配置
3. 查看 Azure Functions 日志 (Application Insights)

---

## 迁移清单

- [x] 创建 `services/serpSearch.js`
- [x] 创建 `services/localSearch.js`
- [x] 创建 `services/hybridSearch.js`
- [x] 修改 `schoolBot.js` 百科处理器
- [x] 更新 `local.settings.json` 配置
- [x] 创建配置文档 (HYBRID_SEARCH_SETUP.md)
- [ ] 注册 SerpAPI 账号
- [ ] 配置 `SERPAPI_KEY` 环境变量
- [ ] 运行测试脚本验证
- [ ] 部署到 Azure Functions
- [ ] 配置生产环境变量
- [ ] 删除旧的 Bing Search 代码

---

## 参考链接

- [SerpAPI 官网](https://serpapi.com)
- [SerpAPI 文档](https://serpapi.com/search-api)
- [SerpAPI 定价](https://serpapi.com/pricing)
- [Azure Cosmos DB 文档](https://learn.microsoft.com/zh-cn/azure/cosmos-db/)
