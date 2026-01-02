# ⚡ 快速配置指南

## 🎯 下一步操作

已为你生成 Service Principal 凭据，需要添加到 GitHub Secrets：

### 步骤 1: 复制凭据

凭据已保存到：`.github/AZURE_CREDENTIALS.json`

⚠️ **重要**：配置完成后请删除此文件，不要提交到 Git！

### 步骤 2: 在 GitHub 添加 Secret

1. 打开你的 GitHub 仓库
2. 进入 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. 填写信息：
   - **Name**: `AZURE_CREDENTIALS`
   - **Value**: 复制 `.github/AZURE_CREDENTIALS.json` 的全部内容（整个 JSON 对象）
5. 点击 **Add secret**

### 步骤 3: 推送代码

```bash
git push
```

如果网络连接有问题，可以稍后重试。

### 步骤 4: 测试自动部署

推送成功后，有两种方式测试：

**方式 1: 修改后端文件触发（自动）**
```bash
# 修改任意后端文件，例如
echo "// test" >> src/functions/schoolBot.js
git add . && git commit -m "test: 触发自动部署"
git push
```

**方式 2: 手动触发**
1. 进入 GitHub 仓库 → **Actions** 标签
2. 选择 "Deploy Backend to Azure Functions"
3. 点击 **Run workflow** → 选择 `main` 分支 → **Run workflow**

## ✅ 验证部署

部署成功后（约 3-5 分钟），测试后端：

```bash
curl https://school-bot-gwb4a9gkdwcyhde5.koreacentral-01.azurewebsites.net/api/schoolbot
```

## 🚫 前端不受影响

workflow 配置了路径过滤，只有以下文件变更才会触发部署：
- `src/**` - 后端函数
- `services/**` - 后端服务
- `host.json` / `package.json`

修改 `campus-ai-web/**` 下的文件**不会触发 GitHub Actions**，你的前端部署方式保持不变。

## 🔒 安全提示

配置完成后，请删除凭据文件：

```bash
rm .github/AZURE_CREDENTIALS.json
git add . && git commit -m "chore: 删除临时凭据文件"
```

添加到 `.gitignore`：

```bash
echo ".github/AZURE_CREDENTIALS.json" >> .gitignore
```
