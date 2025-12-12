# 🧪 学习通课表系统测试报告

## ✅ 已完成测试

### TEST 0: OCR 置信度计算验证 ✅

**测试内容:**
- 完整数据 (7/7 字段): 100% ✅
- 中等数据 (5/7 字段): 71.4% ✅  
- 低质量数据 (2/7 字段): 28.6% ✅ (< 60%, 会触发警告)
- 空数据: 0% ✅

**结果:** 所有测试通过,置信度计算逻辑正确。

**关键代码:**
```javascript
// services/ocrSchedule.js
function computeOcrConfidence(schedule) {
  // 计算公式: (填充字段数 / 总字段数) 的平均值
  // 例如: 7/7 = 100%, 5/7 = 71.4%, 2/7 = 28.6%
  // 当 confidence < 0.6 时,系统会警告用户图片质量太低
}
```

---

## 📋 待执行测试清单

### TEST 1: Chaoxing API 主路径测试 (A Path)

**目标:** 验证学习通课表导入完整流程

**测试脚本:**
```bash
# 使用真实的学习通课表链接
node tools/test-chaoxing-url.js "https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=1000&curriculumUuid=YOUR_UUID"
```

**预期输出:**
```
🔍 测试 URL: https://kb.chaoxing.com/...

📝 步骤 1: 提取 UUID
✅ UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

📝 步骤 2: 获取课表基本信息
✅ maxWeek: 20
✅ 学年: 2024-2025
✅ 学期: 秋

📝 步骤 3: 获取单周课表 (验证链接有效性)
✅ 第 1 周课程数: 15

📋 示例课程:
   - 课程名: 高等数学
   - 教师: 张三
   - 地点: A101
   - 星期: 1
   - 开始: 08:00
   - 时长: 100分钟

📝 步骤 4: 获取全学期课表 (并发获取所有周)
✅ 总周数: 20
✅ 课程总数: 300 (已去重)

📝 步骤 5: 验证标准化字段
✅ 所有标准字段均存在: name, teacher, location, day, start, duration, date, raw

🎉 所有测试通过!
```

**关键验证点:**
- [ ] UUID 提取成功
- [ ] maxWeek 非 0
- [ ] 全学期课程数 >> 单周课程数 (证明多周合并生效)
- [ ] 标准化字段完整 (name, teacher, location, day, start, duration, date, raw)

---

### TEST 2: 重复导入检测 (Cosmos UUID 比对)

**目标:** 验证系统能检测到重复导入的课表

**测试步骤:**
1. 第一次导入课表 → 应成功保存
2. 第二次导入同一课表 → 应提示 "已检测到你之前的课表"
3. 修改 curriculumUuid 后导入 → 应提示 "检测到新课表"

**预期 Cosmos 数据结构:**
```json
{
  "id": "schedule_3361559784",
  "qq": "3361559784",
  "curriculumUuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "maxWeek": 20,
  "semesterStartDate": "2024-09-01",
  "schedule_config": {
    "source_url": "https://kb.chaoxing.com/...",
    "last_updated": "2025-12-11T09:00:00Z",
    "total_courses": 300,
    "full_semester": true
  },
  "weekly_schedule": [...]
}
```

**关键验证点:**
- [ ] 首次导入成功写入 Cosmos
- [ ] curriculumUuid 字段存在且非空
- [ ] maxWeek 字段存在且非 0
- [ ] semesterStartDate 字段存在
- [ ] 重复导入时系统能识别 UUID 不变

---

### TEST 3: 远程爬虫 Fallback 测试 (B Path)

**目标:** 验证 API 失败时自动降级到远程爬虫

**模拟方法:**
```bash
# 方法 1: 使用无效的 UUID
node tools/test-chaoxing-url.js "https://kb.chaoxing.com/...?curriculumUuid=invalid-uuid-test"

# 方法 2: 临时关闭网络 (断网测试)
```

**预期日志:**
```
[Chaoxing API] 获取失败: ...
[RemoteScraper] 调用远程爬虫 (备用方案)
[RemoteScraper] 请求 https://aris-scraper.blueglacier...
[RemoteScraper] 成功获取 15 门课程
```

**关键验证点:**
- [ ] API 失败后自动触发远程爬虫
- [ ] 远程爬虫超时时间为 15000ms (15秒)
- [ ] 爬虫成功返回课程数据

---

### TEST 4: OCR 路径测试 (C Path)

**目标:** 验证图片上传 → OCR 识别 → 置信度警告流程

**测试步骤:**
1. 准备高质量课表截图 (清晰文字)
2. 准备低质量课表截图 (模糊/光照不足)
3. 分别上传测试

**预期输出:**

**高质量图片:**
```
[OCR] 步骤 1: 从图片提取文本...
[OCR] 提取到 1200 字符
[OCR] 步骤 2: 使用 LLM 解析文本为 JSON...
[OCR] 解析到 15 条课程, 置信度: 95.2%
✅ 已保存课表数据
```

**低质量图片:**
```
[OCR] 置信度: 48.3%

⚠️ **图片质量太低,识别准确率不足**
建议: 重新上传更清晰的截图或使用 ICS/Excel 文件
```

**关键验证点:**
- [ ] 高质量图片置信度 > 60%
- [ ] 低质量图片置信度 < 60% 并显示警告
- [ ] computeOcrConfidence 函数正确计算

---

### TEST 5: Cosmos 数据库字段验证

**检查命令:**
```bash
# Azure Portal → Cosmos DB → Data Explorer → BotDB → Conversations
# 查找 id = "schedule_YOUR_QQ_NUMBER"
```

**必须存在的字段:**
```json
{
  "qq": "3361559784",                    // ✅ QQ 号
  "curriculumUuid": "xxxx-xxxx-...",    // ✅ 课表 UUID
  "maxWeek": 20,                         // ✅ 最大周数
  "semesterStartDate": "2024-09-01",    // ✅ 学期开始日期
  "schedule_config": {
    "full_semester": true                // ✅ 全学期标记
  }
}
```

**关键验证点:**
- [ ] qq 字段存在
- [ ] curriculumUuid 字段存在
- [ ] maxWeek 字段存在且 > 0
- [ ] semesterStartDate 字段存在
- [ ] full_semester 字段为 true

---

### TEST 7: 端到端用户流程测试

**真实场景模拟:**

1. **导入课表**
   ```
   QQ: 导入课表 https://kb.chaoxing.com/...
   Bot: ✅ 已成功导入全学期课表！共 300 门课程
   ```

2. **查看今天课表**
   ```
   QQ: 今天有什么课
   Bot: 📅 今天 (周三) 的课程:
        1. 08:00-09:40 | 高等数学 | 张三 | A101
        2. 14:00-15:40 | 大学英语 | 李四 | B202
   ```

3. **查看本周课表**
   ```
   QQ: 本周课表
   Bot: 📅 本周课程 (第 10 周):
        周一: 3 门课
        周二: 2 门课
        ...
   ```

4. **查看全部课表**
   ```
   QQ: 全部课表
   Bot: 📚 全学期课表:
        总计 300 门课程
        学期: 2024-2025 秋季学期
        周次: 1-20 周
   ```

**关键验证点:**
- [ ] 导入成功返回正确课程数量
- [ ] 今天课程数量正确
- [ ] 本周课程数量正确
- [ ] 全部课程数量 ≥ 一周课程数 × 周数
- [ ] 时间、地点、教师名称与学习通原数据一致

---

## 🔧 测试工具使用指南

### 1. Chaoxing API 测试
```bash
node tools/test-chaoxing-url.js "<学习通课表链接>"
```

### 2. OCR 置信度测试
```bash
node tools/test-ocr-confidence.js
```

### 3. 完整系统测试
```bash
node tools/test-full-system.js "<学习通课表链接>"
```

---

## 📊 测试进度

- [x] TEST 0: OCR 置信度计算 ✅
- [ ] TEST 1: Chaoxing API 主路径
- [ ] TEST 2: 重复导入检测
- [ ] TEST 3: 远程爬虫 Fallback
- [ ] TEST 4: OCR 路径验证
- [ ] TEST 5: Cosmos 字段验证
- [ ] TEST 7: 端到端用户流程

---

## 🎯 下一步操作

**需要你提供:**
1. 一个真实的学习通课表链接 (用于 TEST 1)
2. Azure Cosmos DB 访问权限 (用于 TEST 2, 5, 7)
3. 一张高质量课表截图 + 一张低质量课表截图 (用于 TEST 4)

**执行命令:**
```bash
# 替换 YOUR_URL 为真实链接
node tools/test-chaoxing-url.js "YOUR_URL"
```

**如果你有学习通课表链接,请直接发给我,我会立即执行完整测试流程!** 🚀
