#!/bin/bash
# ==============================================================================
# Azure CLI 本地部署脚本 - 替代 GitHub Actions CI/CD
# 功能: 构建并部署 Campus Copilot (Next.js) 到 Azure App Service
# 使用: ./deploy-frontend.sh
# ==============================================================================

set -euo pipefail

# 配置变量
WEBAPP_NAME="campus-copilot-demo"
RESOURCE_GROUP="DefaultResourceGroup-EUS"  # 根据实际情况修改
NODE_VERSION="20"

# 颜色输出函数
function log_info() {
    echo -e "\033[34m[INFO]\033[0m $1"
}

function log_success() {
    echo -e "\033[32m[SUCCESS]\033[0m $1"
}

function log_error() {
    echo -e "\033[31m[ERROR]\033[0m $1"
}

function log_warn() {
    echo -e "\033[33m[WARN]\033[0m $1"
}

# 检查依赖
function check_dependencies() {
    log_info "检查部署依赖..."
    
    if ! command -v node &> /dev/null; then
        log_error "Node.js 未安装。请安装 Node.js $NODE_VERSION"
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        log_error "npm 未安装。请安装 npm"
        exit 1
    fi
    
    if ! command -v az &> /dev/null; then
        log_error "Azure CLI 未安装。请运行: brew install azure-cli"
        exit 1
    fi
    
    log_success "依赖检查通过"
}

# 检查 Azure 登录状态
function check_azure_login() {
    log_info "检查 Azure 登录状态..."
    
    if ! az account show &> /dev/null; then
        log_warn "未登录 Azure CLI，正在启动登录..."
        az login
    fi
    
    local account_name=$(az account show --query "name" -o tsv)
    log_success "已登录 Azure: $account_name"
}

# 构建 Next.js 应用
function build_nextjs() {
    log_info "开始构建 Next.js 应用..."
    
    cd campus-ai-web
    
    # 清理旧的构建产物
    rm -rf .next deploy deploy.zip
    
    # 安装依赖（使用缓存加速）
    log_info "安装依赖..."
    npm ci
    
    # 构建应用
    log_info "构建 Next.js (standalone 模式)..."
    NEXT_TELEMETRY_DISABLED=1 npm run build
    
    if [ ! -d ".next/standalone" ]; then
        log_error "构建失败：.next/standalone 目录不存在"
        exit 1
    fi
    
    log_success "Next.js 构建完成"
    cd ..
}

# 打包部署文件
function package_for_azure() {
    log_info "打包部署文件..."
    
    rm -rf deploy deploy.zip
    mkdir -p deploy
    
    # 复制 standalone 文件到部署目录
    log_info "复制 standalone 文件..."
    cp -R campus-ai-web/.next/standalone/* deploy/
    
    # 确保静态资源正确放置
    log_info "复制静态资源..."
    mkdir -p deploy/.next
    cp -R campus-ai-web/.next/static deploy/.next/
    
    # 复制 public 文件夹
    if [ -d "campus-ai-web/public" ]; then
        log_info "复制 public 资源..."
        cp -R campus-ai-web/public deploy/public
    fi
    
    # 创建部署包
    log_info "创建部署 ZIP 包..."
    cd deploy && zip -qr ../deploy.zip .
    cd ..
    
    local zip_size=$(du -h deploy.zip | cut -f1)
    log_success "部署包已创建: deploy.zip ($zip_size)"
}

# 部署到 Azure App Service
function deploy_to_azure() {
    log_info "部署到 Azure App Service: $WEBAPP_NAME"
    
    # 检查 Web App 是否存在
    if ! az webapp show --name "$WEBAPP_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
        log_error "Web App '$WEBAPP_NAME' 在资源组 '$RESOURCE_GROUP' 中不存在"
        log_info "请先在 Azure Portal 中创建 Web App，或修改脚本中的配置"
        exit 1
    fi
    
    # 使用 Azure CLI 部署
    log_info "正在上传和部署..."
    az webapp deploy \
        --name "$WEBAPP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --src-path "deploy.zip" \
        --type zip \
        --async false
    
    log_success "部署完成！"
    
    # 获取应用 URL
    local app_url=$(az webapp show --name "$WEBAPP_NAME" --resource-group "$RESOURCE_GROUP" --query "defaultHostName" -o tsv)
    log_success "应用访问地址: https://$app_url"
}

# 清理临时文件
function cleanup() {
    log_info "清理临时文件..."
    rm -rf deploy deploy.zip campus-ai-web/.next/standalone campus-ai-web/.next/static
    log_success "清理完成"
}

# 主函数
function main() {
    log_info "开始部署 Campus Copilot 前端应用..."
    echo "========================================"
    
    check_dependencies
    check_azure_login
    build_nextjs
    package_for_azure
    deploy_to_azure
    cleanup
    
    echo "========================================"
    log_success "🎉 部署完成！无需 GitHub Actions，节省存储空间！"
    log_info "💡 下次部署只需运行: ./deploy-frontend.sh"
}

# 错误处理
function handle_error() {
    log_error "部署过程中发生错误！"
    cleanup
    exit 1
}

trap handle_error ERR

# 执行主函数
main "$@"