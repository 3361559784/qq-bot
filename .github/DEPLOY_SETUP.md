# 🚀 GitHub Actions 自动部署配置指南

## 📋 前提条件

本项目使用 GitHub Actions **仅部署后端 Azure Functions**，前端不通过 Actions 部署。

## 🔑 配置 GitHub Secrets

1. 获取 Azure Functions 发布配置文件：

```bash
# 登录 Azure
az login

# 下载 publish profile
az functionapp deployment list-publishing-profiles \
  --name school-bot \
  --resource-group <your-resource-group> \
  --xml > publish-profile.xml
```

2. 在 GitHub 仓库设置中添加 Secret：
   - 进入仓库 → Settings → Secrets and variables → Actions
   - 点击 "New repository secret"
   - Name: `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`
   - Value: 粘贴 `publish-profile.xml` 的全部内容

## ✅ 触发部署

### 自动触发（推荐）
推送以下文件变更到 `main` 分支时自动部署：
- `src/**` - 后端函数代码
- `services/**` - 后端服务模块
- `host.json` / `package.json` - 配置文件

### 手动触发
1. 进入仓库 → Actions → Deploy Backend to Azure Functions
2. 点击 "Run workflow" → 选择 main 分支 → Run

## 🚫 前端部署

**前端 (`campus-ai-web/`) 不使用 GitHub Actions 部署**，请使用以下方式：

```bash
# 本地部署前端到 Azure Static Web Apps
cd campus-ai-web
npm run build
# 按照前端部署文档操作
```

## 📊 部署状态

查看部署状态：
- GitHub 仓库 → Actions 标签页
- 或访问: https://github.com/<your-username>/<repo-name>/actions

## 🔍 验证部署

部署成功后测试端点：

```bash
curl https://school-bot-gwb4a9gkdwcyhde5.koreacentral-01.azurewebsites.net/api/schoolbot
```
