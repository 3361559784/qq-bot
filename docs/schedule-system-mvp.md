# 课表智能解析系统 - 技术文档

## 🎯 系统架构 (MVP 完整实现)

```
用户输入 → Azure Functions → 远程爬虫微服务 → 结构化数据 → Cosmos DB → 用户响应
   ↓              ↓                  ↓                ↓             ↓
学习通URL    Intent识别     Playwright爬取      JSON格式化    持久化存储
```

## ✅ 已完成功能

### 1. 爬虫微服务 (Azure Container Apps)

**服务端点**: `https://<your-scraper-app>.azurecontainerapps.io`

**API接口**:
- `GET /health` - 健康检查
- `POST /scrape` - 课表爬取

**输入格式**:
```json
{
  "url": "https://kb.chaoxing.com/...",
  "cookies": {} // 可选
}
```

**输出格式** (MVP 标准):
```json
{
  "success": true,
  "data": {
    "courses": [
      {
        "courseName": "高等数学",
        "day": "周一",
        "date": "12-11",
        "timeStart": "08:00",
        "timeEnd": "09:40",
        "location": "教学楼A101",
        "teacher": "",
        "period": "1",
        "duration": 2,
        "periodType": "上午"
      }
    ],
    "week": "第15周",
    "weekDays": [...],
    "summary": "人类可读文本"
  },
  "screenshot": "base64_image_data",
  "metadata": {
    "courseCount": 15,
    "elapsedMs": 9234,
    "timestamp": "2025-12-10T22:56:21.330Z",
    "source": "chaoxing-schedule"
  }
}
```

### 2. Azure Functions 端集成

**文件**: `src/functions/schoolBot.js`

**核心函数**:
- `extractChaoxingScheduleUrl(msg)` - 提取学习通URL
- `fetchScheduleFromRemoteScraper(url, context, cookies)` - 调用远程爬虫
- `handleScheduleRequest({...})` - 统一课表处理入口

**数据流优先级**:
1. ✅ 学习通课表 URL (远程爬虫)
2. ✅ 官方导出文件 (ICS/Excel)
3. ✅ OCR截图解析

**触发关键词**:
- `课表`, `课程表`, `课程安排`
- `超星`, `学习通`, `chaoxing`
- `日程`, `日历`, `schedule`

### 3. Cosmos DB 存储

**存储格式** (统一事件模型):
```json
{
  "id": "user_123",
  "schedules": [
    {
      "summary": "高等数学",
      "start": {
        "dateTime": "12-11 08:00",
        "date": "12-11",
        "time": "08:00"
      },
      "end": {
        "dateTime": "12-11 09:40",
        "date": "12-11",
        "time": "09:40"
      },
      "location": "教学楼A101",
      "description": "周一 第1节",
      "extendedProps": {
        "day": "周一",
        "period": "1",
        "duration": 2,
        "teacher": "",
        "source": "chaoxing-remote-scraper"
      }
    }
  ]
}
```

## 📝 使用示例

### 场景1: QQ消息发送学习通链接

```
用户: https://kb.chaoxing.com/pc/course/286506260/326816896

机器人: ✅ 已成功解析学习通课表!

15 门课程已保存到数据库

📚 最近课程安排:
周一 (12-11):
  第1节 08:00-09:40 | 高等数学 @教学楼A101 [2节连上]
  第3节 10:10-11:50 | 大学英语 @教学楼B203

周二 (12-12):
  第2节 09:00-10:40 | 计算机基础 @实验楼C305

💡 数据已同步,可随时查询"本周课表"或"明天有什么课"
```

### 场景2: 直接测试 API

```bash
curl -X POST https://<your-scraper-app>.azurecontainerapps.io/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://kb.chaoxing.com/..."}'
```

## 🔧 配置文件

### local.settings.json
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "SCRAPER_ENDPOINT": "https://<your-scraper-app>.azurecontainerapps.io",
    "GITHUB_TOKEN": "your_token_here",
    "COSMOS_DB_STRING": "AccountEndpoint=https://..."
  }
}
```

## 🚀 部署状态

### 爬虫微服务
- ✅ 部署区域: Korea Central
- ✅ 容器镜像: arisbotacr.azurecr.io/aris-scraper:latest
- ✅ 资源配置: 1 CPU, 2GB RAM, 0-3 副本
- ✅ 架构: linux/amd64 (兼容 Azure Container Apps)

### Azure Functions
- ⏳ 待部署 (本地开发中)
- ✅ 代码完成: schoolBot.js 已完成集成

## 📊 Imagine Cup 评审要点

### ✅ 已实现的核心价值

1. **AI智能解析** - 不是简单截图工具,而是真正理解课表结构
2. **结构化数据** - JSON格式,可用于:
   - 生成 ICS 日历文件
   - 智能提醒系统
   - 数据分析与可视化
   - 跨平台同步

3. **云原生架构** - 微服务解耦,可扩展,容错性强
4. **多数据源支持** - URL/文件/截图三种方式
5. **持久化存储** - Cosmos DB 全球分布式数据库

### 🔄 下一步优化 (可选)

1. **ICS导出功能** - 一键导入 iOS/Android/Outlook
2. **智能提醒** - 上课前15分钟推送
3. **前端界面** - Web/移动端可视化
4. **多学校支持** - 扩展到其他教务系统

## 🧪 测试

### 本地测试脚本

```bash
# 测试爬虫API
node test-scraper-api.js

# 测试完整数据流 (需配置Cosmos DB)
node test-schedule-flow.js
```

### 预期输出
- 爬虫响应时间: 5-15秒
- 数据准确率: 取决于页面结构稳定性
- 支持并发: 0-3个实例自动扩展

## 📚 技术栈

- **后端**: Azure Functions (Node.js)
- **爬虫**: Playwright + Chromium (容器化)
- **存储**: Azure Cosmos DB (NoSQL)
- **部署**: Azure Container Apps
- **CI/CD**: Docker + Azure CLI

## 🔐 安全考虑

- ✅ 环境变量隔离敏感配置
- ✅ HTTPS 加密传输
- ✅ Cosmos DB 访问控制
- ✅ 容器镜像签名验证

---

**最后更新**: 2025-12-11  
**状态**: MVP 完成,可演示  
**维护**: Claude + 用户
