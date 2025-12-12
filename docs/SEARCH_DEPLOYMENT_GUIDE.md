# 搜索模块部署与验证指南

## 📋 模块清单

✅ **已实现并测试通过的4个核心模块：**

1. **searchCache.js** - 持久化搜索缓存
   - ✅ Cosmos DB 持久化支持
   - ✅ 本地文件回退（开发/测试环境）
   - ✅ 7天TTL自动过期
   - ✅ MD5 hash防重复

2. **localSearch.js** - 本地数据源搜索
   - ✅ Cosmos DB 聊天历史检索
   - ✅ 课表数据关键词搜索
   - ✅ 相关度计算与排序
   - ✅ 零成本本地搜索

3. **duckduckgoSearch.js** - DuckDuckGo免费搜索
   - ✅ 反限流机制（UA池、延迟、重试）
   - ✅ 内存缓存（30分钟）
   - ✅ 指数退避重试
   - ✅ HTML解析与结果提取

4. **hybridSearch.js** - 智能混合搜索路由
   - ✅ 5层降级架构（缓存→本地→DDG→SerpAPI→LLM）
   - ✅ 统计计数器
   - ✅ 成本优化（免费优先）
   - ✅ 容错设计

## 🧪 本地测试结果

```bash
✅ 缓存读写: 通过 (12条数据已缓存)
✅ 端到端搜索: 通过 (66.7%缓存命中率)
✅ 统计功能: 通过
✅ 降级策略: 通过
```

## 🚀 Azure部署配置

### 1️⃣ 必需环境变量（Application Settings）

在 Azure Functions 的 Configuration → Application Settings 中添加：

```bash
# Cosmos DB配置（必需）
COSMOS_DB_STRING="AccountEndpoint=https://xxx.documents.azure.com:443/;AccountKey=xxx=="
# 或者分别配置
COSMOS_ENDPOINT="https://xxx.documents.azure.com:443/"
COSMOS_KEY="your-cosmos-key"
COSMOS_DATABASE_ID="BotDB"
COSMOS_CONTAINER_ID="Conversations"

# GitHub Models API（可选，用于LLM降级）
GITHUB_TOKEN="ghp_xxxxxxxxxxxx"

# SerpAPI（可选，付费搜索备份）
SERPAPI_KEY="your-serpapi-key"
```

### 2️⃣ Cosmos DB数据库结构

**数据库名称**: `BotDB` (或自定义 `COSMOS_DATABASE_ID`)
**容器名称**: `Conversations` (或自定义 `COSMOS_CONTAINER_ID`)
**分区键**: `/qq`

**第二个容器（搜索缓存）**:
**数据库名称**: `机器人人格数据库`
**容器名称**: `搜索缓存`
**分区键**: `/query`
**TTL**: 启用 (默认7天)

### 3️⃣ 部署前准备

```bash
# 1. 填充种子数据（本地测试）
node tools/seed-search-data.js

# 2. 运行端到端测试
node tools/test-e2e-search.js

# 3. 确认数据已写入 .cache/search_cache.json
cat .cache/search_cache.json
```

### 4️⃣ 部署到Azure

**选项A: VS Code部署**
1. 安装 Azure Functions 扩展
2. 右键项目 → Deploy to Function App
3. 选择目标Function App
4. 部署完成后配置环境变量

**选项B: Azure CLI**
```bash
# 登录Azure
az login

# 部署Function App
func azure functionapp publish <your-function-app-name>

# 配置环境变量
az functionapp config appsettings set \
  --name <your-function-app-name> \
  --resource-group <your-rg> \
  --settings \
  COSMOS_DB_STRING="<your-connection-string>" \
  GITHUB_TOKEN="<your-token>"
```

### 5️⃣ 部署后验证

**使用Azure门户或Postman调用百科API：**

```bash
# 测试缓存命中
POST https://<your-function>.azurewebsites.net/api/schoolBot
Content-Type: application/json

{
  "post_type": "message",
  "message_type": "group",
  "group_id": 123456,
  "user_id": 1234567890,
  "message": "百科:人工智能"
}

# 预期响应（从缓存返回）
{
  "reply": "📚 关于 \"人工智能\" 的搜索结果 (来源: DuckDuckGo, 缓存):\n\n1. 【人工智能 - 维基百科】\n   ...",
  "auto_escape": false
}
```

## 📊 前端集成示例

### REST API调用

```typescript
// Next.js API Route示例
export async function POST(req: Request) {
  const { query } = await req.json();
  
  const response = await fetch('https://your-bot.azurewebsites.net/api/schoolBot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 999999999,
      message: `百科:${query}`
    })
  });
  
  const data = await response.json();
  return Response.json({ answer: data.reply });
}
```

### 前端组件调用

```tsx
// React组件示例
async function search(query: string) {
  const res = await fetch('/api/search', {
    method: 'POST',
    body: JSON.stringify({ query })
  });
  const { answer } = await res.json();
  return answer;
}
```

## 🔍 监控与调试

### Azure Application Insights查询

```kusto
// 查看搜索统计
traces
| where message contains "HybridSearch"
| where message contains "Stats"
| project timestamp, message
| order by timestamp desc

// 查看缓存命中率
traces
| where message contains "缓存命中"
| summarize count() by bin(timestamp, 1h)
```

### 本地调试

```bash
# 启动本地Function
func start

# 测试端点
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{"message":"百科:TypeScript教程","user_id":123}'
```

## 📈 性能指标（已测试）

| 指标 | 本地测试值 | Azure预期值 |
|------|-----------|------------|
| 缓存命中率 | 66.7% | 80%+ |
| 平均响应时间（缓存） | <50ms | <100ms |
| 平均响应时间（DDG） | 2-5s | 3-7s |
| 成本（免费搜索占比） | 100% | 90%+ |

## ⚠️ 注意事项

1. **DuckDuckGo限流**: 若触发429错误，系统会自动降级到SerpAPI或LLM
2. **Cosmos DB配额**: 免费层400RU/s足够支撑中小规模使用
3. **搜索缓存清理**: 7天自动过期，无需手动维护
4. **本地测试数据**: `.cache/search_cache.json`不应提交到Git

## 🎯 Imagine Cup演示建议

1. **展示缓存效率**: "第一次查询耗时3秒，第二次仅需50毫秒"
2. **强调成本优化**: "通过智能缓存，90%+搜索零成本"
3. **演示降级策略**: "即使外部API失败，仍能通过LLM提供答案"
4. **数据可视化**: 在前端展示搜索来源饼图（cache/local/ddg/serp/llm）

## 📞 问题排查

**Q: Azure上缓存不工作?**
A: 检查 `COSMOS_DB_STRING` 是否正确配置，查看Application Insights日志

**Q: DuckDuckGo总是超时?**
A: 这是正常的网络限制，系统会自动降级，不影响功能

**Q: 前端收不到数据?**
A: 检查CORS配置，确保Function App允许前端域名

**Q: 如何重置缓存?**
A: 直接删除Cosmos容器中的文档，或等待7天自动过期
