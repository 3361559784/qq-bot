/**
 * 搜索数据种子脚本
 * 用途：为 searchCache 和 localSearch 填充测试数据
 * 运行：node tools/seed-search-data.js
 */

const { setCachedSearch, getCacheStats } = require('../services/searchCache');
const { CosmosClient } = require('@azure/cosmos');

// 模拟搜索结果数据集
const SEED_DATA = [
  {
    query: '人工智能',
    source: 'duckduckgo',
    results: [
      { title: '人工智能 - 维基百科', snippet: '人工智能（AI）是计算机科学的一个分支，致力于创建能够执行通常需要人类智能的任务的系统。', url: 'https://zh.wikipedia.org/wiki/人工智能' },
      { title: '什么是人工智能？| IBM', snippet: '人工智能利用计算机和机器来模拟人类大脑的问题解决和决策能力。', url: 'https://www.ibm.com/cn-zh/topics/artificial-intelligence' },
      { title: 'AI技术前沿', snippet: '探索最新的AI技术发展，包括机器学习、深度学习和神经网络。', url: 'https://example.com/ai-frontier' }
    ]
  },
  {
    query: '量子计算',
    source: 'duckduckgo',
    results: [
      { title: '量子计算 - 维基百科', snippet: '量子计算是一种遵循量子力学规律调控量子信息单元进行计算的新型计算模式。', url: 'https://zh.wikipedia.org/wiki/量子计算' },
      { title: 'IBM量子计算', snippet: 'IBM正在开发量子计算机，以解决传统计算机无法解决的复杂问题。', url: 'https://www.ibm.com/quantum' },
      { title: '量子计算的未来', snippet: '量子计算将在密码学、材料科学和药物研发领域带来革命性变化。', url: 'https://example.com/quantum-future' }
    ]
  },
  {
    query: 'Azure Functions',
    source: 'duckduckgo',
    results: [
      { title: 'Azure Functions 文档', snippet: 'Azure Functions 是一个无服务器解决方案，可以减少代码编写量、降低基础结构维护成本并节省成本。', url: 'https://docs.microsoft.com/zh-cn/azure/azure-functions/' },
      { title: 'Azure Functions 定价', snippet: '按使用量付费的无服务器计算服务。', url: 'https://azure.microsoft.com/zh-cn/pricing/details/functions/' },
      { title: 'Azure Functions 快速入门', snippet: '在几分钟内创建第一个函数。', url: 'https://example.com/azure-quickstart' }
    ]
  },
  {
    query: 'TypeScript教程',
    source: 'duckduckgo',
    results: [
      { title: 'TypeScript中文网', snippet: 'TypeScript是JavaScript的超集，添加了可选的静态类型和基于类的面向对象编程。', url: 'https://www.tslang.cn/' },
      { title: 'TypeScript官方文档', snippet: 'TypeScript extends JavaScript by adding types to the language.', url: 'https://www.typescriptlang.org/' },
      { title: 'TypeScript入门教程', snippet: '从零开始学习TypeScript，掌握现代前端开发技能。', url: 'https://example.com/ts-tutorial' }
    ]
  },
  {
    query: 'React开发',
    source: 'duckduckgo',
    results: [
      { title: 'React官方文档', snippet: 'React 是一个用于构建用户界面的 JavaScript 库。', url: 'https://react.dev/' },
      { title: 'React中文文档', snippet: '用于构建 Web 和原生交互界面的库。', url: 'https://zh-hans.react.dev/' },
      { title: 'React最佳实践', snippet: '学习React开发的最佳实践和设计模式。', url: 'https://example.com/react-best-practices' }
    ]
  },
  {
    query: 'Node.js性能优化',
    source: 'duckduckgo',
    results: [
      { title: 'Node.js性能优化指南', snippet: 'Node.js性能调优的实用技巧，包括事件循环、内存管理和异步编程。', url: 'https://nodejs.org/en/docs/guides/simple-profiling/' },
      { title: 'Node.js最佳实践', snippet: '提高Node.js应用性能的最佳实践集合。', url: 'https://github.com/goldbergyoni/nodebestpractices' },
      { title: 'Node.js监控工具', snippet: '使用专业工具监控和优化Node.js应用性能。', url: 'https://example.com/node-monitoring' }
    ]
  },
  {
    query: '数据库设计',
    source: 'duckduckgo',
    results: [
      { title: '数据库设计基础', snippet: '学习关系型数据库设计的基本原则和最佳实践。', url: 'https://example.com/db-design' },
      { title: '数据库范式', snippet: '理解第一范式、第二范式和第三范式在数据库设计中的应用。', url: 'https://example.com/db-normalization' },
      { title: 'NoSQL vs SQL', snippet: '了解关系型和非关系型数据库的区别及使用场景。', url: 'https://example.com/nosql-vs-sql' }
    ]
  },
  {
    query: '微服务架构',
    source: 'duckduckgo',
    results: [
      { title: '微服务架构模式', snippet: '微服务架构将应用程序构建为一组小型服务，每个服务运行在自己的进程中。', url: 'https://microservices.io/' },
      { title: 'Docker与微服务', snippet: '使用Docker容器化技术实现微服务架构。', url: 'https://www.docker.com/resources/what-container/' },
      { title: 'Kubernetes入门', snippet: 'Kubernetes是用于自动部署、扩展和管理容器化应用的开源系统。', url: 'https://kubernetes.io/zh-cn/' }
    ]
  },
  {
    query: 'Git版本控制',
    source: 'duckduckgo',
    results: [
      { title: 'Git官方文档', snippet: 'Git是一个免费的开源分布式版本控制系统。', url: 'https://git-scm.com/' },
      { title: 'Git教程 - 廖雪峰', snippet: '史上最浅显易懂的Git教程。', url: 'https://www.liaoxuefeng.com/wiki/896043488029600' },
      { title: 'GitHub使用指南', snippet: '学习如何使用GitHub进行协作开发。', url: 'https://docs.github.com/zh' }
    ]
  },
  {
    query: '前端框架对比',
    source: 'duckduckgo',
    results: [
      { title: 'React vs Vue vs Angular', snippet: '三大前端框架的详细对比和选型指南。', url: 'https://example.com/framework-comparison' },
      { title: '2024前端框架趋势', snippet: '了解当前最流行的前端框架及其发展趋势。', url: 'https://example.com/frontend-trends' },
      { title: '前端框架选型建议', snippet: '根据项目需求选择合适的前端框架。', url: 'https://example.com/framework-selection' }
    ]
  }
];

// Cosmos DB 聊天历史和课表种子数据
const COSMOS_SEED_DATA = [
  {
    id: 'user_test_001',
    qq: '1234567890',
    affection: 300,
    lastInteraction: Date.now(),
    messages: [
      { role: 'user', content: '今天人工智能课讲了什么？', timestamp: Date.now() - 86400000 },
      { role: 'assistant', content: '爱丽丝记得今天讲了机器学习的基础概念！(✨ω✨)', timestamp: Date.now() - 86400000 + 1000 }
    ],
    scheduleData: {
      lessons: [
        { name: '人工智能原理', teacher: '张教授', location: '教学楼A101', start: '08:00', end: '09:40', weekday: 1 },
        { name: '数据结构', teacher: '李老师', location: '教学楼B203', start: '10:00', end: '11:40', weekday: 1 },
        { name: '操作系统', teacher: '王教授', location: '实验楼C301', start: '14:00', end: '15:40', weekday: 2 }
      ]
    }
  },
  {
    id: 'user_test_002',
    qq: '9876543210',
    affection: 150,
    lastInteraction: Date.now(),
    messages: [
      { role: 'user', content: '量子计算有什么应用？', timestamp: Date.now() - 172800000 },
      { role: 'assistant', content: '量子计算在密码学、药物研发等领域有重要应用！(｀・ω・´)ゞ', timestamp: Date.now() - 172800000 + 1000 },
      { role: 'user', content: '下周有什么考试吗？', timestamp: Date.now() - 86400000 },
      { role: 'assistant', content: '让爱丽丝查查...下周三有数据库考试哦！( >﹏<。)', timestamp: Date.now() - 86400000 + 1000 }
    ],
    scheduleData: {
      lessons: [
        { name: '量子计算导论', teacher: '陈教授', location: '教学楼D401', start: '08:00', end: '09:40', weekday: 3 },
        { name: '数据库系统', teacher: '刘老师', location: '教学楼A305', start: '14:00', end: '15:40', weekday: 3 },
        { name: '软件工程', teacher: '赵教授', location: '教学楼B201', start: '10:00', end: '11:40', weekday: 5 }
      ]
    }
  }
];

async function seedSearchCache() {
  console.log('📦 开始填充搜索缓存数据...\n');
  
  let successCount = 0;
  for (const item of SEED_DATA) {
    const ok = await setCachedSearch(item.query, item.results, item.source);
    if (ok) {
      console.log(`✅ 已缓存: "${item.query}" (${item.results.length} 条结果)`);
      successCount++;
    } else {
      console.log(`❌ 缓存失败: "${item.query}"`);
    }
  }
  
  console.log(`\n✅ 搜索缓存填充完成: ${successCount}/${SEED_DATA.length}\n`);
  
  const stats = await getCacheStats();
  console.log('📊 缓存统计:', JSON.stringify(stats, null, 2));
}

async function seedCosmosData() {
  console.log('\n📦 开始填充 Cosmos DB 本地搜索数据...\n');
  
  const cosmosString = process.env.COSMOS_DB_STRING;
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  
  if (!cosmosString && (!endpoint || !key)) {
    console.log('⚠️  Cosmos DB 未配置，跳过 Cosmos 数据填充');
    console.log('   提示：设置 COSMOS_DB_STRING 或 (COSMOS_ENDPOINT + COSMOS_KEY) 环境变量\n');
    return;
  }
  
  try {
    const client = cosmosString 
      ? new CosmosClient(cosmosString)
      : new CosmosClient({ endpoint, key });
    
    const database = client.database(process.env.COSMOS_DATABASE_ID || 'BotDB');
    const container = database.container(process.env.COSMOS_CONTAINER_ID || 'Conversations');
    
    let successCount = 0;
    for (const item of COSMOS_SEED_DATA) {
      try {
        await container.items.upsert(item);
        console.log(`✅ 已添加用户数据: ${item.qq} (${item.messages.length} 条消息, ${item.scheduleData.lessons.length} 门课程)`);
        successCount++;
      } catch (err) {
        console.log(`❌ 添加失败 ${item.qq}: ${err.message}`);
      }
    }
    
    console.log(`\n✅ Cosmos DB 数据填充完成: ${successCount}/${COSMOS_SEED_DATA.length}\n`);
  } catch (err) {
    console.error('❌ Cosmos DB 连接失败:', err.message);
    console.log('   请检查连接字符串是否正确\n');
  }
}

async function main() {
  console.log('========================================');
  console.log('🌱 搜索数据种子脚本');
  console.log('========================================\n');
  
  // 填充搜索缓存
  await seedSearchCache();
  
  // 填充 Cosmos DB（如果配置了）
  await seedCosmosData();
  
  console.log('========================================');
  console.log('✅ 数据填充完成！');
  console.log('========================================');
  console.log('\n💡 提示：');
  console.log('- 本地缓存位置: .cache/search_cache.json');
  console.log('- 运行测试: node tools/test-e2e-search.js');
  console.log('- 查看统计: node tools/test-local-cache.js\n');
}

main().catch(err => {
  console.error('❌ 脚本执行失败:', err);
  process.exit(1);
});
