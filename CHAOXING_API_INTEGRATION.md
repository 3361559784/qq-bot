# 学习通课表 API 集成完成 ✅

## 📋 更新摘要

成功将学习通 `getOtherLessons` API 集成到系统中,实现了稳定、快速的课表数据获取。

## 🎯 核心改进

### 1️⃣ 新增 API 服务模块
**文件**: `services/chaoxingSchedule.js`

提供以下功能:
- ✅ 从 URL 提取 `curriculumUuid`
- ✅ 调用 `getOtherLessons` API
- ✅ 数据格式标准化转换
- ✅ 错误分类处理 (invalid_url, not_found, timeout, etc.)
- ✅ 支持指定周次查询

**关键 API**:
```javascript
const { getChaoxingScheduleFromUrl } = require('./services/chaoxingSchedule');

// 使用方法
const result = await getChaoxingScheduleFromUrl(url, week);
if (result.success) {
  console.log(result.schedule); // 标准化的课程数组
  console.log(result.curriculum); // 课表元数据
}
```

### 2️⃣ 更新 schoolBot.js
**文件**: `src/functions/schoolBot.js`

**新增函数**:
- `fetchScheduleFromChaoxingAPI()` - 直接调用 API (主方案)
- `fetchScheduleFromRemoteScraper()` - 远程爬虫 (备用方案)

**优化流程**:
```
用户发送学习通链接
    ↓
提取 curriculumUuid
    ↓
优先: 调用 getOtherLessons API ✅
    ↓ (失败时)
备用: 调用远程爬虫服务
    ↓
数据标准化 → Cosmos DB
    ↓
返回用户友好消息
```

### 3️⃣ OCR 备用方案
**文件**: `services/ocrSchedule.js`

当 API 和爬虫都失败时,支持课表截图 OCR 识别:
```javascript
const { ocrScheduleWorkflow } = require('./services/ocrSchedule');
const schedule = await ocrScheduleWorkflow(imageUrl, githubToken);
```

## 📊 测试结果

### 测试脚本
```bash
node tools/test-chaoxing-api.js <URL> [周次]
```

### 实际测试输出
```
✅ API 调用成功!

📊 课表元数据:
学年: 2025
学期: 1
当前周: 第 15 周 (共 25 周)
课程总数: 25 门
访客模式: 是

📚 课程详情:
1. 大学英语（一)
   教师: 汪玲
   地点: E02-207
   时间: 周2 第8节 (16:45-18:30)
   周次: 15
   日期: 2025-12-09
   校区: 武昌工学院
```

## 🚀 部署清单

### 本地测试
```bash
# 1. 安装依赖
npm install

# 2. 测试 API
node tools/test-chaoxing-api.js

# 3. 测试 Playwright 捕获
node tools/playwright-capture-json-enhanced.js <URL>
```

### Azure Functions 部署
```bash
# 部署到 Azure
func azure functionapp publish <FUNCTION_APP_NAME>

# 确保设置环境变量
az functionapp config appsettings set \
  --name <FUNCTION_APP_NAME> \
  --settings \
    COSMOS_DB_STRING="<your-cosmos-connection>" \
    GITHUB_TOKEN="<your-github-token>"
```

## 📁 新增文件

```
qq-bot-aris-clean/
├── services/
│   ├── chaoxingSchedule.js      # ⭐ 学习通 API 服务
│   └── ocrSchedule.js           # 📷 OCR 备用方案
├── tools/
│   ├── playwright-capture-json.js              # 基础网络捕获
│   ├── playwright-capture-json-enhanced.js     # 增强版捕获
│   ├── test-chaoxing-api.js                    # ⭐ API 测试脚本
│   └── extract-endpoints.js                    # 端点提取工具
├── captured-json-enhanced.json   # 捕获的 API 响应
├── test-result.json              # 测试结果
└── package.json                  # 新增 axios 依赖
```

## 🎓 API 数据结构

### getOtherLessons 响应
```json
{
  "result": 1,
  "msg": null,
  "data": {
    "curriculum": {
      "schoolYear": "2025",
      "semester": 1,
      "currentWeek": 15,
      "maxWeek": 25,
      "lessonTimeConfigArray": ["", "08:00-08:45", ...]
    },
    "lessonArray": [
      {
        "name": "大学英语（一)",
        "teacherName": "汪玲",
        "location": "E02-207",
        "dayOfWeek": 2,
        "beginNumber": 8,
        "length": 1,
        "weeks": "15",
        "wholeDay": "2025-12-09"
      }
    ],
    "visitor": 2
  }
}
```

### 标准化后的格式 (存入 Cosmos DB)
```json
{
  "summary": "大学英语（一)",
  "start": {
    "dateTime": "2025-12-09 16:45",
    "date": "2025-12-09",
    "time": "16:45"
  },
  "end": {
    "dateTime": "2025-12-09 18:30",
    "date": "2025-12-09",
    "time": "18:30"
  },
  "location": "E02-207",
  "description": "汪玲 - 周2 第8节 (15周)",
  "extendedProps": {
    "instructor": "汪玲",
    "dayOfWeek": 2,
    "beginNumber": 8,
    "length": 1,
    "weeks": "15",
    "campus": "武昌工学院",
    "source": "chaoxing-api"
  }
}
```

## 💡 使用场景

### 场景 1: 用户发送学习通链接
```
用户: https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=xxx

Bot: ✅ 学习通课表解析成功!

📅 学年: 2025-1
📍 当前周次: 第 15 周 (共 25 周)
📚 课程总数: 25 门

最近课程安排:
1. 大学英语（一) - 汪玲 - E02-207 - 周2 16:45-18:30
2. 高等数学（一) - 张舒 - E03-A514 - 周3 11:15-14:00
...

💡 数据已保存,可查询"本周课表"、"明天有课吗"等
```

### 场景 2: API 失败降级到爬虫
```
[Log] Chaoxing API 调用失败,尝试远程爬虫...
[Log] RemoteScraper 成功获取 25 门课程
```

### 场景 3: 所有方案失败,建议上传文件
```
Bot: ❌ 无法获取学习通课表
原因: 网络请求超时
建议:
1. 使用 ICS/Excel 文件上传
2. 截图课表后发送给我 (将使用 OCR 识别)
```

## 🏆 MVP 优势

### ✅ 已实现 (Imagine Cup MVP 就绪)
1. **稳定的数据源**: 绕过 IP 限制,直接调用公开 API
2. **多层容错**: API → 爬虫 → OCR,三层保障
3. **数据持久化**: Cosmos DB 存储,支持跨设备查询
4. **用户友好**: 清晰的错误提示和成功反馈
5. **周次支持**: 可查询特定周的课程安排

### 🚀 未来扩展 (半决赛/中国赛/世界赛)
1. **登录认证**: 支持用户登录获取私有课表
2. **智能提醒**: 上课前 15 分钟推送通知
3. **多校支持**: 适配其他教务系统 (正方、强智等)
4. **课表分享**: 生成 ICS 文件导入日历
5. **AI 助手**: 课程相关问答、学习建议

## 📞 联系与支持

- **测试 URL**: `https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=9a44e583-2c48-443c-bc72-d32a2f1ba101`
- **API 文档**: 见 `services/chaoxingSchedule.js` 注释
- **问题反馈**: 查看 Azure Functions 日志

---

**状态**: ✅ MVP 完成,可用于 Imagine Cup 演示
**最后更新**: 2025-12-11
**版本**: v1.0.0
