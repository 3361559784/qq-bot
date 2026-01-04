> **Languages**: [English README](README.md) | [中文](README.zh.md) | [日本語](README.jp.md) | [Русский](README.ru.md)

# 🔧 404错误完整排查方案

## ❗ 当前问题
NapCat报错: `Unexpected status code: 404`

## 🎯 根本原因
**不是代码问题,是配置问题!** Azure Functions已经正确返回响应,但NapCat收到404说明:
1. URL配置错误
2. Azure Functions没有正确部署
3. 路由注册失败

---

## ✅ 解决方案(按顺序执行)

### 1️⃣ 检查Azure Functions部署状态

```bash
# 如果你用的是Azure CLI
az functionapp show --name <your-function-app-name> --resource-group <your-rg> --query "state"

# 检查部署日志
az functionapp log deployment show --name <your-function-app-name> --resource-group <your-rg>
```

### 2️⃣ 确认正确的Functions URL

你的Azure Functions URL应该是以下格式之一:
```
https://<your-app-name>.azurewebsites.net/api/schoolBot
https://<your-app-name>.chinacloudsites.cn/api/schoolBot  (如果用Azure China)
```

**不要用**:
- ❌ `http://` (必须https)
- ❌ 缺少 `/api/`
- ❌ 函数名拼写错误

### 3️⃣ 修复NapCat配置

编辑NapCat的`config/onebot11_http.json`:

```json
{
  "http": {
    "enable": true,
    "host": "0.0.0.0",
    "port": 6009,
    "secret": "",
    "enableHeart": true,
    "enablePost": true,
    "postUrls": [
      "https://<your-correct-azure-url>/api/schoolBot"  // ← 修改这里!
    ]
  }
}
```

### 4️⃣ 重启NapCat

```bash
# Docker方式
docker restart napcat

# 或PM2方式
pm2 restart napcat

# 或直接kill进程重启
```

### 5️⃣ 实时测试

在NapCat重启后,发送测试消息并观察日志:

**正确的日志应该是**:
```
[INFO] 接收 <- 群聊 [...] [用户] 消息内容
[INFO] HTTP上报成功 200
```

**而不是**:
```
[ERROR] 新消息事件HTTP上报返回快速操作失败 Error: Unexpected status code: 404
```

---

## 🔍 高级诊断

### 测试1: 直接curl测试Azure Functions

```bash
curl -X POST "https://YOUR-AZURE-URL/api/schoolBot" \
  -H "Content-Type: application/json" \
  -d '{
    "post_type":"message",
    "message_type":"private",
    "user_id":123456789,
    "message":"test",
    "raw_message":"test",
    "sender":{"nickname":"test"}
  }' \
  -v
```

**期望输出**:
- HTTP/2 200
- 返回JSON: `{"status":"ok",...}` 或 `{"reply":"..."}`

**如果返回404**:
- URL错误
- 函数没有部署
- 路由配置问题

### 测试2: 检查Azure Functions日志

Azure Portal → 你的Function App → Monitoring → Log stream

发送消息后应该看到:
```
[事件接收] post_type=message, message_type=group...
[QQ消息] 来自:用户(ID) 内容:消息
```

**如果看不到日志**:
- Azure没有收到请求
- NapCat的URL配置错误

### 测试3: 验证函数路由

```bash
# 列出所有可用的Functions
az functionapp function list \
  --name <your-app-name> \
  --resource-group <your-rg> \
  --query "[].name"
```

应该看到: `["schoolBot"]`

---

## 🚨 常见错误

### 错误1: URL拼写错误
```
❌ https://your-app.azurewebsites.net/schoolBot       (缺少/api/)
❌ https://your-app.azurewebsites.net/api/SchoolBot   (大小写错误)
✅ https://your-app.azurewebsites.net/api/schoolBot
```

### 错误2: 代码未部署
```bash
# 手动强制部署
cd /Users/liuziheng/qq-bot-aris-clean
git push -f origin main

# 如果用GitHub Actions自动部署,检查Actions状态
# 如果用Azure CLI部署
func azure functionapp publish <your-app-name>
```

### 错误3: authLevel不匹配
检查`schoolBot.js`中的:
```javascript
app.http('schoolBot', {
    authLevel: 'anonymous',  // ✅ 应该是这个
    // 不应该是 'function' 或 'admin'
})
```

---

## 📝 快速检查清单

- [ ] Azure Functions已部署最新代码
- [ ] NapCat配置的URL完全正确(包括https、/api/、函数名)
- [ ] NapCat已重启
- [ ] curl测试返回200
- [ ] Azure日志能看到请求
- [ ] authLevel = 'anonymous'

---

## 💡 如果还是不行

**最后的杀手锏**: 查看NapCat **完整配置文件**

```bash
# SSH到NapCat服务器
ssh user@4.230.25.38

# 查看配置
cat /path/to/napcat/config/onebot11_http.json

# 找到postUrls数组,复制URL
# 然后用curl测试这个确切的URL
```

把NapCat配置文件的`postUrls`内容发给我,我帮你检查!
