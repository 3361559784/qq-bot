#!/bin/bash
set -euo pipefail

# 在 Mac 上用 Docker 构建 Linux 版的 Next.js standalone 产物
# 产出：deploy.zip（可直接上传到 Azure App Service）

echo "🐳 启动 Docker Linux 容器构建..."

# 清理旧产物
rm -rf deploy deploy.zip

# 在 ubuntu:latest 容器中构建（与 GitHub Actions 一致）
docker run --rm \
  --platform linux/amd64 \
  -v "$(pwd)/campus-ai-web:/workspace" \
  -w /workspace \
  node:20-slim \
  bash -c "
    set -euo pipefail
    echo '📦 安装依赖...'
    npm ci --prefer-offline --no-audit
    
    echo '🔨 构建 Next.js standalone...'
    npm run build
    
    echo '✅ 构建完成'
  "

echo "📦 打包部署产物..."

# 创建部署目录
rm -rf deploy
mkdir -p deploy

# 拷贝 standalone 内容到根目录
# 使用 rsync 确保完整拷贝（包括隐藏文件和目录）
rsync -a campus-ai-web/.next/standalone/ deploy/

# 拷贝静态资源（standalone 不包含静态资源）
mkdir -p deploy/.next/static
rsync -a campus-ai-web/.next/static/ deploy/.next/static/

# 拷贝 public
if [ -d campus-ai-web/public ]; then
  cp -R campus-ai-web/public deploy/public
fi

# 打包成 zip
(cd deploy && zip -qr ../deploy.zip .)

echo "✅ 打包完成：deploy.zip ($(du -h deploy.zip | cut -f1))"
echo ""
echo "📤 上传方式："
echo "   az webapp deployment source config-zip \\"
echo "     --resource-group aris-bot-rg \\"
echo "     --name campus-copilot-demo \\"
echo "     --src $(pwd)/deploy.zip"
