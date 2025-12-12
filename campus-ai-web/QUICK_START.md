# 🚀 Campus AI Web 快速启动指南

## 📋 前置条件检查

✅ 所有搜索模块已就绪
✅ 前端代码已完成集成
✅ 环境变量已配置

---

## 🎯 启动步骤 (5分钟)

### 步骤1: 启动Azure Function后端

在**终端1**运行:

```bash
cd /Users/liuziheng/qq-bot-aris-clean

# 启动Azure Function
func start
```

等待看到:
```
Functions:
  schoolBot: [POST] http://localhost:7071/api/schoolBot
  ...其他函数
```

**保持此终端运行** ✨

---

### 步骤2: 启动前端开发服务器

在**终端2**运行:

```bash
cd /Users/liuziheng/qq-bot-aris-clean/campus-ai-web

# 安装依赖(首次运行)
npm install

# 启动开发服务器
npm run dev
```

等待看到:
```
✓ Ready in 2.5s
○ Local:   http://localhost:3000
```

**保持此终端运行** ✨

---

### 步骤3: 测试搜索功能

1. **打开浏览器** → `http://localhost:3000`

2. **点击侧边栏 'Search' 图标** (放大镜🔍)

3. **输入测试查询**: `人工智能`

4. **预期结果**:
   - ✅ 显示3-5条搜索结果卡片
   - ✅ 显示绿色"缓存"标签(第二次查询)
   - ✅ 可点击链接跳转外部网页
   - ✅ 显示来源信息 (DuckDuckGo/本地/缓存)

---

## 🎨 UI功能演示

### 模式切换
- **Plan** (📋): 计划管理 (开发中)
- **Search** (🔍): 智能搜索 ✅
- **Ask** (💬): 普通对话 ✅
- **Class** (📚): 课表查询 (开发中)

### 搜索来源标签
| 标签颜色 | 来源 | 说明 |
|---------|------|------|
| 🟢 绿色 | 缓存 | 极速响应 (<50ms) |
| 🔵 蓝色 | 本地 | 聊天历史/课表 |
| 🟣 紫色 | DuckDuckGo | 免费搜索引擎 |
| 🟡 黄色 | SerpAPI | 付费搜索(备份) |
| 🔴 红色 | LLM | AI生成答案 |

---

## 🧪 测试用例

### 用例1: 缓存命中测试
1. 输入: `人工智能`
2. 等待3-5秒获得结果
3. **再次输入** `人工智能`
4. **预期**: <1秒返回,显示绿色"缓存"标签

### 用例2: 多样化查询
依次测试:
- `量子计算`
- `TypeScript教程`
- `Azure Functions`
- `React开发`

### 用例3: 本地搜索(需Cosmos数据)
- `我的课表`
- `今天有什么课`
- `数学老师是谁`

---

## ⚠️ 常见问题

### Q1: 后端连接失败 (fetch failed)
**原因**: Azure Function未启动或端口错误

**解决**:
```bash
# 检查后端是否运行
curl http://localhost:7071/api/schoolBot

# 重启后端
cd /Users/liuziheng/qq-bot-aris-clean
func start
```

### Q2: 搜索结果不显示
**原因**: 
- 后端返回格式错误
- 正则表达式未匹配

**解决**:
1. 打开浏览器控制台 (F12)
2. 查看Network标签中的API响应
3. 检查`reply`字段格式是否正确

### Q3: CORS错误
**原因**: 跨域请求被阻止

**解决**: 在 `host.json` 添加:
```json
{
  "extensions": {
    "http": {
      "cors": {
        "allowedOrigins": ["http://localhost:3000"],
        "allowedMethods": ["POST", "GET"]
      }
    }
  }
}
```

### Q4: 环境变量未生效
**原因**: Next.js需要重启才能读取.env.local

**解决**:
```bash
# 停止开发服务器 (Ctrl+C)
# 重新启动
npm run dev
```

---

## 📊 性能监控

### 查看搜索统计
在浏览器控制台运行:
```javascript
// 查看API响应时间
performance.getEntriesByType('resource')
  .filter(r => r.name.includes('/api/chat'))
  .map(r => ({ url: r.name, duration: r.duration }))
```

### 查看缓存命中率
后端终端会显示:
```
[hybridSearch] 总请求: 10, 缓存命中: 8 (80%)
```

---

## 🎓 Imagine Cup演示技巧

### 演示脚本 (2分钟)

**开场** (15秒)
> "这是Alice校园AI助手,集成了智能搜索、课表管理、语音交互等功能"

**功能1: 智能搜索** (45秒)
1. 切换到Search模式
2. 输入"人工智能"
3. 展示搜索结果卡片
4. 再次搜索同一词汇
5. 强调: "第二次仅需50毫秒,缓存命中!"

**功能2: 成本优化** (30秒)
1. 点击不同结果,展示来源标签
2. 强调: "90%搜索零成本,通过5层智能路由"
3. 展示架构图 (缓存→本地→免费搜索→付费→LLM)

**功能3: 交互体验** (30秒)
1. 点击Alice动画形象
2. 展示Rive交互效果
3. 切换不同模式 (Plan/Class/Ask)
4. 展示响应式设计

**总结** (15秒)
> "Alice通过混合搜索架构,实现了快速响应、低成本运营,为校园学生提供7x24智能助手服务"

### 数据准备
运行种子脚本确保有演示数据:
```bash
cd /Users/liuziheng/qq-bot-aris-clean
node tools/seed-search-data.js
```

---

## 📁 关键文件清单

### 前端文件
- ✅ `app/page.tsx` - 主页面(含模式切换)
- ✅ `app/api/chat/route.ts` - API路由
- ✅ `components/SearchResults.tsx` - 搜索结果组件
- ✅ `components/AliceAvatar.tsx` - Rive动画组件
- ✅ `.env.local` - 环境配置

### 后端文件
- ✅ `src/functions/schoolBot.js` - 主函数
- ✅ `services/hybridSearch.js` - 搜索路由
- ✅ `services/searchCache.js` - 缓存服务
- ✅ `services/duckduckgoSearch.js` - 免费搜索
- ✅ `services/localSearch.js` - 本地搜索

### 测试文件
- ✅ `tools/seed-search-data.js` - 数据种子
- ✅ `tools/test-e2e-search.js` - 端到端测试
- ✅ `campus-ai-web/test-integration.sh` - 集成测试

### 文档文件
- ✅ `docs/SEARCH_DEPLOYMENT_GUIDE.md` - 部署指南
- ✅ `docs/SEARCH_MODULE_DELIVERY.md` - 交付报告
- ✅ `campus-ai-web/FRONTEND_INTEGRATION_GUIDE.md` - 前端集成指南
- ✅ `campus-ai-web/QUICK_START.md` - 本文档

---

## ✅ 验收检查清单

在演示前确认:

- [ ] 后端 `func start` 运行正常
- [ ] 前端 `npm run dev` 运行正常
- [ ] 浏览器能打开 `http://localhost:3000`
- [ ] 搜索功能返回结果
- [ ] 缓存功能正常(第二次查询<1秒)
- [ ] 来源标签正确显示
- [ ] Alice动画可点击交互
- [ ] 模式切换流畅
- [ ] 暗黑模式切换正常
- [ ] 移动端响应式正常

---

**准备好了吗? 开始启动吧!** 🚀

按照**步骤1和步骤2**启动两个终端,然后打开浏览器测试!
