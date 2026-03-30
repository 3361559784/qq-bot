# Backend CI/CD (Azure Functions)

当前仓库后端自动部署工作流：`main_school-bot.yml`

## 触发条件

- `push` 到 `main`
- 且改动命中后端路径：`src/**`、`services/**`、`host.json`、`package*.json`
- 支持手动触发 `workflow_dispatch`

## 流水线阶段

1. `test`
   - 安装依赖
   - 运行 `npm test`
   - 运行 `npm run verify:runtime`
2. `deploy-backend`
   - 使用 GitHub OIDC 登录 Azure
   - 通过 `func azure functionapp publish --build remote --javascript` 部署

## 需要配置的 GitHub Variables

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

> 说明：这是 OIDC 三元组（推荐放在 Repository Variables），不需要长期密钥。需在 Azure 侧为 GitHub 仓库配置 Federated Credential。

## 可调环境变量（在 workflow 内）

- `AZURE_FUNCTIONAPP_NAME`：默认 `school-bot`
- `AZURE_RESOURCE_GROUP`：默认 `qq-bot-rg`
- `NODE_VERSION`：默认 `20.x`

## 验证方式

- 在 GitHub Actions 页面观察 `test` 和 `deploy-backend` 两个 job
- 部署成功后，检查：
  - `https://school-bot.azurewebsites.net/api/schoolbot`
