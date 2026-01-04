> **Languages**: [English README](../README.md) | [中文](../README.zh.md) | [日本語](../README.jp.md) | [Русский](../README.ru.md)

# 🚀 GitHub Actions 自动部署配置指南

## 📋 前提条件

本项目使用 GitHub Actions **仅部署后端 Azure Functions**，前端不通过 Actions 部署。

## 🔑 配置 GitHub Secrets

由于使用 Azure Flex Consumption Plan，需要使用 Service Principal 进行身份验证。

### 步骤 1: 创建 Service Principal

```bash
# 登录 Azure
az login

# 创建 Service Principal（替换 <subscription-id> 为你的订阅 ID）
az ad sp create-for-rbac \
  --name "github-actions-school-bot" \
  --role contributor \
  --scopes /subscriptions/<subscription-id>/resourceGroups/qq-bot-rg \
  --sdk-auth
```

**输出示例**（保存整个 JSON 对象）：
```json
{
  "clientId": "xxxx",
  "clientSecret": "xxxx",
  "subscriptionId": "xxxx",
  "tenantId": "xxxx",
  ...
}
```

### 步骤 2: 获取订阅 ID

```bash
az account show --query id --output tsv
```

### 步骤 3: 在 GitHub 添加 Secret

1. 进入仓库 → Settings → Secrets and variables → Actions
2. 点击 "New repository secret"
3. 添加以下 Secret：

   **Name:** `AZURE_CREDENTIALS`  
   **Value:** 完整的 JSON 对象（步骤 1 的输出）

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
curl https://<your-function-app>.azurewebsites.net/api/schoolbot
```

## 🛠️ 故障排查

### 部署失败
- 检查 Secret `AZURE_CREDENTIALS` 是否正确配置
- 确认 Service Principal 有 `qq-bot-rg` 资源组的 Contributor 权限
- 查看 Actions 日志获取详细错误信息

### 前端意外部署
- 确认 `.funcignore` 包含 `campus-ai-web`
- workflow 的 `paths` 过滤器不包含前端文件
