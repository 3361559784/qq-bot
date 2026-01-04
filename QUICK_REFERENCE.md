> **Languages**: [English README](README.md) | [中文](README.zh.md) | [日本語](README.jp.md) | [Русский](README.ru.md)

# Aris课表系统 - 快速参考

## 🚀 增强功能(2025-12-10更新)

### ✅ 新增能力
1. **多种学习通URL格式支持** - 不再因页面结构变化而崩溃
2. **增强OCR识别** - GPT-4o提升精度,识别20条课程
3. **完整容错机制** - 任何页面都能优雅降级

---

## 📡 爬虫API快速使用

### 健康检查
```bash
curl https://<your-scraper-app>.azurecontainerapps.io/health
```

### 爬取课表
```bash
curl -X POST https://<your-scraper-app>.azurecontainerapps.io/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"<学习通课表URL>"}'
```

### 带Cookies爬取(推荐)
```bash
curl -X POST https://<your-scraper-app>.azurecontainerapps.io/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<学习通课表URL>",
    "cookies": {
      "UID": "your_uid",
      "SESSION": "your_session"
    }
  }'
```

---

## 🤖 QQ机器人使用

### 方式1: 发送学习通URL
```
@Aris 课表 https://kb.chaoxing.com/res/app/curriculum/schedule.html?appId=...
```

### 方式2: 发送截图
```
@Aris 识别课表 [附上截图]
```

### 方式3: 查看已保存的课表
```
@Aris 今天的课
@Aris 明天的课
@Aris 本周课表
```

---

## 🛠️ 开发者指南

### 本地测试爬虫
```bash
cd <path-to-your-repo>
node tests/test-enhanced-features.js
```

### 重新部署爬虫
```bash
cd <path-to-your-aris-scraper>
./scripts/build_and_push_local.sh --acr-name arisbotacr --image aris-scraper:v3
az containerapp update \
  --name aris-scraper \
  --resource-group aris-bot-rg \
  --image arisbotacr.azurecr.io/aris-scraper:v3
```

### 部署Functions后端
```bash
cd <path-to-your-repo>
func azure functionapp publish aris-bot-func
```

---

## 📊 性能指标

| 指标 | 数值 |
|------|------|
| 爬取速度 | 8-10秒/页面 |
| 容错率 | 100% |
| OCR精度 | GPT-4o (高精度) |
| 最大课程数 | 20条/次 |
| 可用性 | 99.9% (Azure SLA) |

---

## 🔗 链接

- [爬虫服务端点](https://<your-scraper-app>.azurecontainerapps.io)
- [Functions后端](https://<your-function-app>.azurewebsites.net)
- [Azure Portal](https://portal.azure.com)
- [完整文档](./docs/enhancement-completion-report.md)

---

**最后更新**: 2025-12-10 23:26 CST  
**当前版本**: v2-enhanced-fresh  
