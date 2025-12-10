# 学习通课表爬虫使用说明

## 📦 已实现功能

✅ Puppeteer 自动化爬虫模块 (`src/functions/chaoxingScraper.js`)
✅ HTTP API 接口 (`src/functions/scrapeChaoxing.js`)
✅ 移动端 UA 伪装 (iPhone 17.0)
✅ 反爬虫检测绕过 (webdriver 隐藏、Chrome 对象伪装)
✅ 页面滚动触发懒加载
✅ 智能内容提取 (过滤导航栏/脚本)
✅ 自动截图保存 (用于调试)
✅ 集成到现有课表解析流程

## 🚀 使用方法

### 方法一:独立测试脚本
```bash
# 测试默认 URL
node test_chaoxing_scraper.js

# 测试自定义 URL
CHAOXING_URL="https://kb.chaoxing.com/res/app/curriculum/schedule.html?..." \
  node test_chaoxing_scraper.js

# 如果 Chrome 不在标准路径,设置环境变量
CHROME_PATH="/自定义路径/chrome" node test_chaoxing_scraper.js
```

输出文件:
- `/tmp/chaoxing_schedule_<timestamp>.png` - 页面截图
- `scraped_schedule.txt` - 提取的文本内容

### 方法二:HTTP API 调用
```bash
# 启动 Azure Functions
func start

# 调用爬虫接口
curl -X POST http://localhost:7071/api/scrapeChaoxing \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "sensei",
    "url": "https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=你的UUID"
  }'
```

返回格式:
```json
{
  "ok": true,
  "scraped": true,
  "url": "...",
  "screenshotPath": "/tmp/...",
  "textLength": 1234,
  "parsed": false,
  "events": [],
  "summary": "爬取到的文本内容摘要"
}
```

## ⚙️ 配置说明

### 支持的浏览器
脚本会自动检测以下浏览器(按优先级):
1. Google Chrome (`/Applications/Google Chrome.app/...`)
2. Microsoft Edge (`/Applications/Microsoft Edge.app/...`)
3. Chromium
4. 自定义路径(通过 `CHROME_PATH` 环境变量)

### 超时配置
在 `chaoxingScraper.js` 中:
- `navigation`: 45秒 - 页面导航超时
- `selector`: 15秒 - 等待元素出现
- `idle`: 3秒 - 页面稳定等待
- 滚动加载: 额外2秒

### 课表选择器优先级
```javascript
[
  '.class-table-container',  // 学习通专用
  '.schedule-container',
  '.curriculum-table',
  '.course-list',
  '.week-schedule',
  '.timetable',
  'table',                   // 通用表格
  'body'                     // 兜底
]
```

## 🔧 已知问题与解决方案

### 问题1: 页面只显示时间框架,没有课程
**原因**: 目标 URL 可能需要登录认证,或课程数据通过 AJAX 异步加载

**解决方案**:
1. 使用已登录的 Cookie (需要在代码中添加 `page.setCookie(...)`)
2. 增加等待时间让 AJAX 加载完成
3. 使用开发者工具找到 API 接口直接调用

### 问题2: ERR_CONNECTION_CLOSED
**原因**: 学习通检测到自动化访问

**解决方案**: 已实现
- ✅ 隐藏 `navigator.webdriver`
- ✅ 伪装 Chrome 对象
- ✅ 设置完整的 HTTP 头
- ✅ 使用真实移动端 UA

### 问题3: Azure Functions 未注册 scrapeChaoxing 端点
**原因**: 可能是循环依赖或文件加载顺序问题

**验证方法**:
```bash
# 检查语法
node -c src/functions/scrapeChaoxing.js

# 手动加载测试
node -e "require('./src/functions/scrapeChaoxing.js'); console.log('OK')"
```

**解决方案**:
- 确保 `local.settings.json` 设置了 `FUNCTIONS_WORKER_RUNTIME: "node"`
- 重启 Azure Functions 服务

## 📊 数据流程图

```
用户请求
  ↓
HTTP API (/api/scrapeChaoxing)
  ↓
Puppeteer 爬虫 (chaoxingScraper.js)
  ├→ 伪装移动端浏览器
  ├→ 访问学习通页面
  ├→ 滚动触发懒加载
  ├→ 提取文本内容
  └→ 保存截图
  ↓
文本清洗 (cleanScrapedText)
  ↓
智能解析 (parseScheduleFromOcrText)
  ↓
Cosmos DB 存储
  ↓
返回 JSON 结果
```

## 🛡️ 安全建议

1. **不要硬编码 Cookie**: 如需登录,使用环境变量存储凭证
2. **限制访问频率**: 添加请求间隔防止被封IP
3. **仅用于个人学习**: 遵守学习通服务条款

## 🐛 调试技巧

### 查看真实浏览器渲染
```javascript
// chaoxingScraper.js 第82行
headless: false,  // 改为 false
```

### 查看详细日志
```bash
func start --verbose
```

### 检查截图内容
```bash
open /tmp/chaoxing_schedule_<timestamp>.png
```

### 提取的 HTML 调试
在 `scrapeChaoxingSchedule` 函数返回值中包含 `html` 字段,可保存为文件分析:
```javascript
fs.writeFileSync('debug.html', result.html);
```

## 📝 后续优化建议

1. **Cookie 持久化**: 添加登录态保持,避免每次重新登录
2. **并发控制**: 使用队列限制同时爬取数量
3. **增量更新**: 只爬取有变化的周次
4. **错误重试**: 添加指数退避重试机制
5. **代理支持**: 轮换 IP 防止封禁

## 📄 相关文件

- `src/functions/chaoxingScraper.js` - 核心爬虫模块
- `src/functions/scrapeChaoxing.js` - HTTP 接口
- `test_chaoxing_scraper.js` - 独立测试脚本
- `scraped_schedule.txt` - 输出示例
- `local.settings.json` - Azure Functions 配置

---

**作者**: GitHub Copilot  
**日期**: 2025-12-11  
**版本**: v1.0.0
