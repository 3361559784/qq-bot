# 🎉 学习通爬虫成功案例

## 测试结果

✅ **爬取成功!** 从学习通课表页面提取到完整数据

### 提取数据摘要
- **课程数量**: 25门
- **当前周次**: 第15周  
- **日期范围**: 2025-12-08 至 2025-12-14 (周一到周日)
- **文本长度**: 1614字符

### 提取的课程列表

```
1. 大学英语(一) @E02-207
2. 计算机应用基础项目式实践 @S4-202
3. 机械工程制图(一) @E03-A409
4. 高等数学(一) @E03-A108
5. 高等数学(一) @E03-A308
6. 思想道德与法治 @E03-A308
7. 思想道德与法治 @E03-A412
8. 大学体育(一)—乒乓球Ⅰ @T01-201
... (共25门课程)
```

### 数据结构

爬虫返回的JSON包含:
```json
{
  "success": true,
  "text": "格式化后的课表文本",
  "courses": [
    {
      "name": "大学英语(一)",
      "location": "E02-207",
      "duration": "2",
      "style": "height: 83px;"
    }
  ],
  "week": "第15周",
  "dates": ["周一12-08", "周二12-09", ...],
  "screenshotPath": "/tmp/chaoxing_schedule_xxx.png"
}
```

## 关键技术突破

### 1. 反爬虫绕过
```javascript
// 隐藏 webdriver 特征
'--disable-blink-features=AutomationControlled'

// JavaScript注入
Object.defineProperty(navigator, 'webdriver', { get: () => false });
```

### 2. DOM精确提取
```javascript
// 目标选择器
document.querySelectorAll('.tddiv')  // 课程卡片
.querySelector('.courseName')         // 课程名
.querySelector('.courseLoc')          // 上课地点
```

### 3. 动态内容等待
```javascript
// 滚动触发懒加载
await page.evaluate(async () => {
    await new Promise((resolve) => {
        let totalHeight = 0;
        const timer = setInterval(() => {
            window.scrollBy(0, 100);
            totalHeight += 100;
            if(totalHeight >= document.body.scrollHeight){
                clearInterval(timer);
                resolve();
            }
        }, 100);
    });
});
```

## 使用方法

### 快速测试
```bash
node test_chaoxing_scraper.js
```

### 自定义URL
```bash
CHAOXING_URL="https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=你的UUID" \
  node test_chaoxing_scraper.js
```

### API调用
```bash
curl -X POST http://localhost:7071/api/scrapeChaoxing \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "sensei",
    "url": "https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=9a44e583-2c48-443c-bc72-d32a2f1ba101"
  }'
```

## 输出文件

1. **文本文件**: `scraped_schedule.txt`
   - 格式化的课表文本
   - 包含周次、日期、课程列表

2. **截图**: `/tmp/chaoxing_schedule_<timestamp>.png`
   - 完整页面截图
   - 用于验证渲染结果

## 已知问题与解决方案

### 问题: ERR_CONNECTION_CLOSED
**原因**: 学习通检测到headless浏览器并关闭连接

**解决**: 
```javascript
headless: false  // 临时改为可见模式
```

首次访问可能需要可见模式建立连接,后续可切回无头模式。

### 问题: 只提取到导航栏
**原因**: JS未完全加载

**解决**: 
```javascript
await sleep(TIMEOUT_CONFIG.idle);  // 等待JS渲染
await page.evaluate(/* 滚动代码 */);  // 触发懒加载
```

## 性能数据

| 指标 | 数值 |
|------|------|
| 启动浏览器 | ~2秒 |
| 页面加载 | ~3-5秒 |
| 滚动+等待 | ~3秒 |
| 数据提取 | <1秒 |
| **总耗时** | **~10秒** |

## 下一步优化

- [ ] 添加Cookie持久化(保持登录态)
- [ ] 支持多周课表切换
- [ ] 解析rowspan/colspan获取精确时间
- [ ] 导出为iCal格式
- [ ] 集成到QQ机器人自动通知

---

**测试时间**: 2025-12-11  
**成功率**: 100% (基于可见模式)  
**数据完整性**: ✅ 完整
