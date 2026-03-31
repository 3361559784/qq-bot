# QQ Bot 上下文、记忆与回答链统一重构 - 完成摘要

## 🎯 重构目标
整合 Moltbot 上下文工程思路 + airi_副本 会话/记忆结构，实现：
- 群聊优先，私聊静默
- Session transcript + 自动 compaction
- Tool result pruning
- Cosmos 托管长期记忆
- 知识型问题自动先搜再答
- 每轮稳定注入 runtime context
- Prompt 模块化
- 回答默认自然聊天，不助手菜单腔

## ✅ 完成状态
**全部完成** - 8/8 个核心任务

## 📦 新增文件 (7 个)
1. `src/v2/core/sessionManager.js` - ChatContext + Transcript (285 行)
2. `src/v2/core/compactionService.js` - 自动压缩 (118 行)
3. `src/v2/core/toolResultManager.js` - 工具结果治理 (166 行)
4. `src/v2/services/chatContextStorage.js` - Cosmos 存储层 (102 行)
5. `tests/sessionManager.test.js` - 会话管理测试
6. `tests/toolResultManager.test.js` - 工具结果测试
7. `tests/refactor.integration.test.js` - 集成测试清单

**新增代码**: ~670 行核心实现 + ~350 行测试

## 🔧 修改文件 (4 个)
1. `src/v2/services/memoryService.js` - 扩展字段（category, importance, emotional_impact, tags, access_count）
2. `src/v2/core/knowledgeRouter.js` - 新增 capability_only 模式
3. `src/v2/core/promptRegistry.js` - 新增 3 个 prompt profile
4. `src/v2/core/conversationCore.js` - 整合所有新模块

## 🚀 核心功能

### 1. ChatContext + Transcript
- 群聊按 `qq_group:<group_id>` 建会话
- 私聊返回 null（不创建会话）
- Transcript 类型：user | assistant | tool_call | tool_result | compaction
- 持久化到 Cosmos，TTL 24 小时

### 2. Compaction（自动压缩）
- 触发条件：> 24 条目 OR > 12000 tokens
- 保留最近 8 个非工具条目
- 用 GPT-4o (temp=0.3) 摘要旧对话
- 保留人物关系、话题走向、约束、未完成事项

### 3. Tool Result Pruning
- 工具结果独立生命周期管理
- Vision/OCR/Search/Weather: 2 轮过期
- Draw: 1 轮过期
- 自动去重（同工具只保留最新）

### 4. 长期记忆升级
新增字段：
- `category`: 记忆分类
- `importance`: 1-10
- `emotional_impact`: -10 到 +10
- `tags`: 标签数组
- `last_accessed`, `access_count`: 访问跟踪

### 5. Knowledge Router 升级
新增路由模式：
- `capability_only`: 显式工具请求（画图/天气/课表）
- 优先级：capability_only > meta_question > chat > search_first

### 6. Prompt 模块化
新增 Profile：
- `identity_meta`: 元问题专用
- `search_grounded_answer`: 搜索后回答
- `vision_answer`: 视觉理解回答

约束：
- qq_chat 添加"聊天优先，不推荐任务菜单"
- identity_meta 明确说明记忆策略
- 分离职责：prompt 只负责角色，时间/记忆/工具分层处理

### 7. 主回复链重排
新的执行流程：
1. Session 管理 → 2. Identity/Meta 优先 → 3. 知识路由 → 
4. 安全检测 → 5. Transcript 写入 → 6. 工具生命周期更新 → 
7. 搜索执行 → 8. 工具调用 → 9. LLM 回复 → 
10. Assistant Turn 写入 → 11. 工具清理 → 12. Compaction 检查 → 
13. 保存 Session

新增 Meta 字段：
- `compaction_used`
- `transcript_entry_count`
- `active_tool_results`

## 📊 测试覆盖

### 单元测试
- ✅ Runtime Context Builder
- ✅ Knowledge Router
- ✅ Session Manager
- ✅ Tool Result Manager

### 集成测试清单
1. 私聊静默
2. 群聊普通闲聊
3. 群聊事实类问题
4. 元问题（你是谁/现在几点）
5. 长期记忆写入与召回
6. 长对话 compaction
7. 工具结果治理
8. Capability 路由

## ⚠️ 注意事项

1. **双写兼容**: 当前同时写 transcript 和旧 memory 系统
2. **Cosmos TTL**: 需确保 chat_sessions 容器启用 TTL
3. **LLM 成本**: Compaction 调用 GPT-4o，注意成本
4. **并发控制**: 暂未实现 session 写锁，建议后续添加 eTag
5. **异步更新**: Memory access_count 更新为异步，失败不阻塞

## 🔍 后续优化建议

### P0（必须）
- [ ] 实际运行集成测试
- [ ] 监控 Compaction 质量和频率
- [ ] 验证 Cosmos TTL 清理

### P1（重要）
- [ ] 添加乐观并发控制（eTag）
- [ ] Compaction 异步化
- [ ] Tool result 摘要优化

### P2（可选）
- [ ] Transcript 可视化接口
- [ ] Memory 自动清理
- [ ] Compaction 质量评估

## 📝 文档
- 详细报告: `docs/REFACTOR_REPORT.md`
- 实施计划: `plan.md` (session folder)

## 👤 审查清单
用户需审查：
1. ✅ P1: 私聊静默
2. ✅ P2: Runtime context
3. ✅ P3: Knowledge router
4. 🔍 P4-6: 全面重构（本次完成）

---

**完成时间**: $(date +%Y-%m-%d)  
**状态**: ✅ 代码完成，待实测  
**作者**: GitHub Copilot CLI
