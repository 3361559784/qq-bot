> **Languages**: [English README](../README.md) | [中文](../README.zh.md) | [日本語](../README.jp.md) | [Русский](../README.ru.md)

# 搜索模块快速验收清单
## ✅ 功能验收（5分钟快速检查）
### 1. 缓存功能（searchCache.js）
```bash
# 运行种子脚本
node tools/seed-search-data.js

# 验证：应看到 "✅ 搜索缓存填充完成: 10/10"
# 验证：.cache/search_cache.json 文件存在且有内容
```

**✅ 通过条件**: 
- 控制台显示10条缓存成功
- 缓存统计显示 `"total": 12`

---

### 2. 端到端搜索（hybridSearch.js）

```bash
# 运行E2E测试
node tools/test-e2e-search.js

# 验证：应看到 2/3 缓存命中
```

**✅ 通过条件**:
- "人工智能" 查询返回 `source=cache-duckduckgo`
- "TypeScript教程" 查询返回 `source=cache-duckduckgo`
- 缓存命中率 ≥ 66%

---

### 3. 本地搜索（localSearch.js）

**当前状态**: ⚠️ Cosmos DB未配置，功能已实现但需Azure环境测试

**Azure环境验证步骤**:
1. 配置 `COSMOS_DB_STRING`
2. 运行 `node tools/seed-search-data.js`（会填充Cosmos数据）
3. 测试查询包含"课程"关键词，应返回本地数据

---

### 4. DuckDuckGo搜索（duckduckgoSearch.js）

**当前状态**: ⚠️ 本地网络超时，功能已实现但需Azure环境测试

**Azure环境验证**:
- 部署到Azure后，首次查询新关键词应触发DDG搜索
- 检查Application Insights日志应看到 `[HybridSearch] Layer 2: DuckDuckGo 搜索`

---

## 🎯 前端集成验收

### API调用示例

```bash
# 使用curl测试（本地Functions）
func start  # 先启动本地Function

# 测试百科指令
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "message_type": "private",
    "user_id": 999999,
    "message": "百科:人工智能"
  }'

# 预期返回JSON包含 "reply" 字段，内容为搜索结果
```

**✅ 通过条件**:
- HTTP 200响应
- JSON包含 `reply` 字段
- `reply` 内容包含 "人工智能 - 维基百科"

---

### 前端代码示例

```typescript
// app/api/search/route.ts
export async function POST(req: Request) {
  const { query } = await req.json();
  
  const response = await fetch(
    process.env.AZURE_FUNCTION_URL + '/api/schoolBot',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        user_id: 888888888,
        message: `百科:${query}`
      })
    }
  );
  
  const data = await response.json();
  
  // 提取搜索结果
  const searchResults = parseSearchResults(data.reply);
  
  return Response.json({ 
    success: true,
    results: searchResults 
  });
}

function parseSearchResults(reply: string) {
  // 解析格式: "1. 【标题】\n   描述\n   🔗 URL"
  const regex = /\d+\.\s*【(.+?)】\s+(.+?)\s+🔗\s+(https?:\/\/.+)/g;
  const results = [];
  let match;
  
  while ((match = regex.exec(reply)) !== null) {
    results.push({
      title: match[1],
      snippet: match[2],
      url: match[3]
    });
  }
  
  return results;
}
```

---

## 📊 Azure部署验收

### 部署后必查清单

- [ ] Application Settings包含 `COSMOS_DB_STRING`
- [ ] Function运行无错误（查看Logs）
- [ ] 调用 `/api/schoolBot` 返回200
- [ ] Application Insights有日志记录
- [ ] Cosmos DB容器存在且有数据

### 快速测试脚本（部署后）

```bash
# 替换为你的Function App URL
FUNCTION_URL="https://your-app.azurewebsites.net"

# 测试1: 缓存查询
curl -X POST "$FUNCTION_URL/api/schoolBot" \
  -H "Content-Type: application/json" \
  -d '{"message":"百科:React开发","user_id":123}'

# 测试2: 新查询（会触发搜索）
curl -X POST "$FUNCTION_URL/api/schoolBot" \
  -H "Content-Type: application/json" \
  -d '{"message":"百科:Kubernetes入门","user_id":123}'

# 测试3: 再次查询（应命中缓存）
curl -X POST "$FUNCTION_URL/api/schoolBot" \
  -H "Content-Type: application/json" \
  -d '{"message":"百科:Kubernetes入门","user_id":123}'
```

---

## 🐛 常见问题快速修复

### ❌ "Cosmos DB 未配置"

**解决**: 在Azure Function App的Configuration中添加:
```
COSMOS_DB_STRING="AccountEndpoint=https://xxx.documents.azure.com:443/;AccountKey=xxx=="
```

### ❌ "缓存未命中"

**原因**: 首次查询或缓存过期
**解决**: 正常现象，再次查询会命中缓存

### ❌ "DDG_RATE_LIMIT"

**原因**: 触发DuckDuckGo限流
**解决**: 自动降级到SerpAPI或LLM，无需手动处理

### ❌ 前端CORS错误

**解决**: 在Function App设置中添加CORS域名
```bash
az functionapp cors add \
  --name <your-function-app> \
  --resource-group <your-rg> \
  --allowed-origins https://your-frontend.vercel.app
```

---

## 🎓 Imagine Cup演示脚本

**场景1: 展示缓存效率**
```
演示者: "我先搜索'人工智能'..."
[第一次查询，显示来源: cache-duckduckgo，耗时50ms]
演示者: "大家注意，响应时间不到100毫秒，因为我们的智能缓存系统..."
```

**场景2: 展示成本优化**
```
演示者: "让我看看搜索统计..."
[显示统计面板: 缓存命中率80%，免费搜索占比95%]
演示者: "通过多层缓存架构，我们实现了90%以上的零成本搜索..."
```

**场景3: 展示容错能力**
```
演示者: "即使外部API失败，系统也能..."
[模拟网络故障，系统自动降级到LLM]
演示者: "看到了吗？系统自动降级，用户体验不受影响..."
```

---

## ✅ 最终验收签字

- [ ] 本地测试全部通过
- [ ] Azure部署成功
- [ ] 前端能正常调用
- [ ] 缓存功能正常
- [ ] 日志记录完整
- [ ] 文档完善

**验收日期**: ___________
**验收人**: ___________
**备注**: ___________
