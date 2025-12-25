# Azure CLI 部署指南

> 🚫 **告别 GitHub Actions 存储限制！**  
> 改用 Azure CLI 本地部署，节省 GitHub 2GB 存储空间，部署更快更可控。

## 🛠️ 环境准备

### 1. 安装必要工具

```bash
# 安装 Azure CLI
brew install azure-cli

# 安装 Azure Functions Core Tools (Functions 部署需要)
npm install -g azure-functions-core-tools@4 --unsafe-perm true

# 验证安装
az --version
func --version
```

### 2. Azure 登录

```bash
# 登录 Azure（会弹出浏览器）
az login

# 验证登录状态
az account show

# 如果有多个订阅，设置默认订阅
az account set --subscription "你的订阅ID"
```

## 🚀 快速部署

### 部署前端 (Campus Copilot)

```bash
# 给脚本执行权限
chmod +x deploy-frontend.sh

# 一键部署 Next.js 到 Azure App Service
./deploy-frontend.sh
```

### 部署后端 (Azure Functions)  

```bash
# 给脚本执行权限
chmod +x deploy-functions.sh

# 一键部署 Functions 到 Azure Function App
./deploy-functions.sh
```

## 📋 部署脚本说明

### `deploy-frontend.sh` - 前端部署
- **目标**: campus-copilot-demo (Azure App Service)
- **构建**: Next.js standalone 模式
- **打包**: 只包含必要文件 (.next/standalone + static + public)
- **部署**: 使用 `az webapp deploy`

### `deploy-functions.sh` - 后端部署  
- **目标**: school-bot (Azure Function App)
- **依赖**: 自动安装 npm 包
- **验证**: 检查 Functions 配置和文件
- **部署**: 使用 `func azure functionapp publish`

## 🔧 配置修改

如果你的 Azure 资源名称不同，请修改脚本中的配置：

```bash
# 在 deploy-frontend.sh 中
WEBAPP_NAME="你的-web-app-名称"
RESOURCE_GROUP="你的资源组名称"

# 在 deploy-functions.sh 中  
FUNCTION_APP_NAME="你的-function-app-名称"
RESOURCE_GROUP="你的资源组名称"
```

## 🎯 优势对比

| 项目 | GitHub Actions | Azure CLI 本地部署 |
|:----:|:-------------:|:----------------:|
| **存储占用** | ❌ 每次构建消耗存储 | ✅ 无存储占用 |
| **部署速度** | ⏱️ 等待 Runner 启动 | ⚡ 立即开始 |
| **调试能力** | ❌ 查看日志困难 | ✅ 实时查看输出 |
| **网络要求** | ❌ 依赖 GitHub 网络 | ✅ 直连 Azure |
| **控制程度** | ❌ 受 Actions 限制 | ✅ 完全自主控制 |

## 🚫 停用 GitHub Actions

已修改工作流配置，禁用自动触发：
- ✅ `deploy-campus-copilot-demo.yml` - push 触发已注释
- ✅ `main_school-bot.yml` - push 触发已注释  
- ✅ 保留 `workflow_dispatch` 供紧急情况手动触发

## 📊 GitHub Actions 清理建议

1. **修改保留期** (在 GitHub 仓库设置中):
   - Settings → Actions → General
   - Workflow run retention: `90 days` → `1 day`

2. **删除历史记录**:
   - Actions 标签页 → 选择失败的工作流
   - 点击 `...` → Delete workflow run
   - 删除 5-10 条记录即可回血

3. **清空缓存** (如果有):
   - Actions → 左侧栏 Caches → 删除所有缓存

## 🔄 部署工作流

```bash
# 1. 开发完成，准备部署
git add . && git commit -m "feat: 新功能开发完成"
git push

# 2. 部署前端（如果前端有变更）
./deploy-frontend.sh

# 3. 部署后端（如果后端有变更）  
./deploy-functions.sh

# 4. 验证部署结果
curl https://campus-copilot-demo.azurewebsites.net/health
curl https://school-bot.azurewebsites.net/api/schoolBot?test=1
```

**🎉 从此告别 GitHub Actions 存储焦虑，部署更快更稳定！**