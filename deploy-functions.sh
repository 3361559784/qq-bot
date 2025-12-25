#!/bin/bash
# ==============================================================================
# Azure Functions 本地部署脚本 - 替代 GitHub Actions CI/CD  
# 功能: 部署 Azure Functions (schoolBot.js) 到 Azure Function App
# 使用: ./deploy-functions.sh
# ==============================================================================

set -euo pipefail

# 配置变量
FUNCTION_APP_NAME="school-bot"
RESOURCE_GROUP="DefaultResourceGroup-EUS"  # 根据实际情况修改
NODE_VERSION="22"

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
    
    if ! command -v func &> /dev/null; then
        log_error "Azure Functions Core Tools 未安装。请运行: npm install -g azure-functions-core-tools@4 --unsafe-perm true"
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

# 安装 Function App 依赖
function install_dependencies() {
    log_info "安装 Function App 依赖..."
    
    # 确保在项目根目录
    if [ ! -f "package.json" ]; then
        log_error "未找到 package.json，请在项目根目录运行此脚本"
        exit 1
    fi
    
    if [ ! -f "host.json" ]; then
        log_error "未找到 host.json，这不是一个 Azure Functions 项目"
        exit 1
    fi
    
    # 安装依赖
    log_info "运行 npm ci..."
    npm ci
    
    log_success "依赖安装完成"
}

# 验证 Function App 配置
function validate_functions() {
    log_info "验证 Functions 配置..."
    
    if [ ! -f "src/functions/schoolBot.js" ]; then
        log_error "未找到 src/functions/schoolBot.js"
        exit 1
    fi
    
    if [ ! -f "local.settings.json" ]; then
        log_warn "未找到 local.settings.json，请确保已配置环境变量"
    fi
    
    log_success "Functions 配置验证通过"
}

# 部署到 Azure Function App
function deploy_to_azure() {
    log_info "部署到 Azure Function App: $FUNCTION_APP_NAME"
    
    # 检查 Function App 是否存在
    if ! az functionapp show --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
        log_error "Function App '$FUNCTION_APP_NAME' 在资源组 '$RESOURCE_GROUP' 中不存在"
        log_info "请先在 Azure Portal 中创建 Function App，或修改脚本中的配置"
        exit 1
    fi
    
    # 使用 Azure Functions Core Tools 部署
    log_info "正在上传和部署 Functions..."
    func azure functionapp publish "$FUNCTION_APP_NAME" --node
    
    log_success "部署完成！"
    
    # 获取 Function App URL
    local app_url=$(az functionapp show --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP" --query "defaultHostName" -o tsv)
    log_success "Function App 访问地址: https://$app_url"
}

# 显示 Function 信息
function show_function_info() {
    log_info "获取 Function 信息..."
    
    # 列出所有 Functions
    local functions=$(az functionapp function list --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP" --query "[].name" -o tsv)
    
    if [ -n "$functions" ]; then
        log_success "已部署的 Functions:"
        while read -r func_name; do
            if [ -n "$func_name" ]; then
                local func_url=$(az functionapp function show --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP" --function-name "$func_name" --query "invokeUrlTemplate" -o tsv)
                echo "  - $func_name: $func_url"
            fi
        done <<< "$functions"
    else
        log_warn "未找到已部署的 Functions"
    fi
}

# 测试部署结果
function test_deployment() {
    log_info "测试部署结果..."
    
    # 获取 schoolBot function 的 URL
    local func_url=$(az functionapp function show \
        --name "$FUNCTION_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --function-name "schoolBot" \
        --query "invokeUrlTemplate" -o tsv 2>/dev/null || echo "")
    
    if [ -n "$func_url" ]; then
        log_success "schoolBot Function 已部署: $func_url"
        log_info "💡 可以使用此 URL 配置 QQ Bot webhook"
    else
        log_warn "未找到 schoolBot Function，请检查部署是否成功"
    fi
}

# 主函数
function main() {
    log_info "开始部署 Azure Functions..."
    echo "========================================"
    
    check_dependencies
    check_azure_login
    install_dependencies
    validate_functions
    deploy_to_azure
    show_function_info
    test_deployment
    
    echo "========================================"
    log_success "🎉 Functions 部署完成！无需 GitHub Actions，节省存储空间！"
    log_info "💡 下次部署只需运行: ./deploy-functions.sh"
}

# 错误处理
function handle_error() {
    log_error "部署过程中发生错误！"
    exit 1
}

trap handle_error ERR

# 执行主函数
main "$@"