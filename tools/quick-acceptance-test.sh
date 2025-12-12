#!/bin/bash
# 快速验收测试脚本
# 运行: bash tools/quick-acceptance-test.sh

echo "=========================================="
echo "🧪 搜索模块快速验收测试"
echo "=========================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0

function test_pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
    ((PASS_COUNT++))
}

function test_fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    ((FAIL_COUNT++))
}

function test_warn() {
    echo -e "${YELLOW}⚠️  WARN${NC}: $1"
}

echo "测试 1: 缓存文件存在性检查"
if [ -f ".cache/search_cache.json" ]; then
    FILE_SIZE=$(wc -c < .cache/search_cache.json)
    if [ $FILE_SIZE -gt 100 ]; then
        test_pass "缓存文件存在且有内容 (${FILE_SIZE} bytes)"
    else
        test_fail "缓存文件太小"
    fi
else
    test_fail "缓存文件不存在"
fi
echo ""

echo "测试 2: 种子数据填充"
node tools/seed-search-data.js > /tmp/seed-output.log 2>&1
if grep -q "搜索缓存填充完成: 10/10" /tmp/seed-output.log; then
    test_pass "种子数据填充成功"
else
    test_fail "种子数据填充失败"
    cat /tmp/seed-output.log
fi
echo ""

echo "测试 3: 端到端搜索测试"
node tools/test-e2e-search.js > /tmp/e2e-output.log 2>&1
if grep -q "缓存命中: 2" /tmp/e2e-output.log; then
    test_pass "端到端搜索测试通过（缓存命中2/3）"
else
    test_fail "端到端测试未达到预期"
    tail -20 /tmp/e2e-output.log
fi
echo ""

echo "测试 4: 模块完整性检查"
MODULES=(
    "services/searchCache.js"
    "services/localSearch.js"
    "services/duckduckgoSearch.js"
    "services/hybridSearch.js"
)

for module in "${MODULES[@]}"; do
    if [ -f "$module" ]; then
        if grep -q "module.exports" "$module"; then
            test_pass "模块 $module 存在且有导出"
        else
            test_fail "模块 $module 缺少导出"
        fi
    else
        test_fail "模块 $module 不存在"
    fi
done
echo ""

echo "测试 5: 依赖包检查"
REQUIRED_PACKAGES=("@azure/cosmos" "axios" "openai")
for pkg in "${REQUIRED_PACKAGES[@]}"; do
    if grep -q "\"$pkg\"" package.json; then
        test_pass "依赖包 $pkg 已配置"
    else
        test_warn "依赖包 $pkg 可能缺失"
    fi
done
echo ""

echo "测试 6: 文档完整性"
DOCS=(
    "docs/SEARCH_DEPLOYMENT_GUIDE.md"
    "docs/SEARCH_ACCEPTANCE_CHECKLIST.md"
)
for doc in "${DOCS[@]}"; do
    if [ -f "$doc" ]; then
        test_pass "文档 $doc 存在"
    else
        test_fail "文档 $doc 缺失"
    fi
done
echo ""

echo "=========================================="
echo "📊 测试总结"
echo "=========================================="
echo -e "通过: ${GREEN}${PASS_COUNT}${NC}"
echo -e "失败: ${RED}${FAIL_COUNT}${NC}"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}✅ 所有测试通过！可以部署到Azure了！${NC}"
    echo ""
    echo "下一步:"
    echo "1. 配置Azure Cosmos DB连接字符串"
    echo "2. 运行: func azure functionapp publish <your-app-name>"
    echo "3. 在Azure门户配置环境变量"
    echo "4. 参考 docs/SEARCH_DEPLOYMENT_GUIDE.md 完成部署"
    exit 0
else
    echo -e "${RED}❌ 有 ${FAIL_COUNT} 个测试失败，请检查后重试${NC}"
    exit 1
fi
