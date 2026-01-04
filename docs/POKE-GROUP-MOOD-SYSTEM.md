> **Languages**: [English README](../README.md) | [中文](../README.zh.md) | [日本語](../README.jp.md) | [Русский](../README.ru.md)

# 戳一戳群组情绪系统文档
## 🎯 功能概述

新的"戳一戳"系统实现了**按群计数**和**渐进式情绪衰减**机制，让爱丽丝的反应更加真实和有趣。

### 核心改进
1. **按群计数**: 所有人的戳击累计到群组总数，而不是单个用户
2. **渐进式情绪**: 4个情绪等级（neutral → annoyed → angry → furious），5分钟后自动降一级
3. **无个人@**: 回复面向整个群，不包含个人mention
4. **向后兼容**: 保留旧的per-user模式，通过feature flag切换

---

## 📊 情绪等级系统

### 情绪阶梯
```
neutral (平静)    戳击 0-2次
    ↓
annoyed (烦躁)    戳击 3-4次     5分钟后↓
    ↓
angry (生气)      戳击 5-7次     5分钟后↓
    ↓
furious (暴怒)    戳击 8次以上    5分钟后↓
```

### 衰减机制
- **衰减间隔**: 5分钟 (300,000毫秒)
- **衰减方式**: 每5分钟降低一个情绪等级
- **示例**: 
  - 群组被戳8次 → furious
  - 5分钟无新戳击 → 自动降为 angry
  - 再过5分钟 → 降为 annoyed
  - 再过5分钟 → 降为 neutral

---

## 🔧 配置说明

### 环境变量
```bash
# 启用群组计数模式 (默认true)
POKE_GROUP_COUNTING=true

# 群组触发阈值 (默认5次进入angry)
POKE_GROUP_THRESHOLD=5

# 单用户冷却时间 (防刷屏, 默认2秒)
USER_POKE_COOLDOWN_MS=2000

# 计数窗口 (默认8分钟)
POKE_WINDOW_MS=480000
```

### 代码配置常量
```javascript
// schoolBot.js Line ~158-172
const POKE_GROUP_THRESHOLD = 5;
const GROUP_MOOD_DECAY_CONFIG = {
    DECAY_INTERVAL_MS: 5 * 60 * 1000,  // 5分钟
    LEVELS: ['neutral', 'annoyed', 'angry', 'furious'],
    THRESHOLDS: {
        3: 'annoyed',
        5: 'angry',
        8: 'furious'
    }
};
const POKE_GROUP_COUNTING = process.env["POKE_GROUP_COUNTING"] !== 'false';
```

---

## 💾 数据库架构

### 新Schema (按群计数)
```javascript
{
  "id": "group_123456",
  "pokeStats": {
    "group": {
      "count": 7,              // 群组累计戳击次数
      "lastTime": 1699999999,  // 最后一次戳击时间
      "intervals": [2000, 1500, ...]  // 最近5次间隔
    },
    "users": {
      "user_111": {
        "lastTime": 1699999990,      // 该用户最后戳击时间
        "lastReplyTime": 1699999990,  // 该用户最后收到回复时间
        "intervals": []
      },
      "user_222": { ... }
    }
  },
  "groupMood": {
    "value": "angry",           // neutral/annoyed/angry/furious
    "lastSet": 1699999995,      // 情绪设置时间
    "setBy": "system"           // system/decay/admin
  }
}
```

### 旧Schema (per-user)
```javascript
{
  "id": "group_123456",
  "pokeStats": {
    "group_123456:user_111": {
      "count": 3,
      "lastTime": 1699999990,
      "intervals": [...]
    }
  }
}
```

### 自动迁移
- **Lazy Migration**: 首次读取旧格式时自动转换
- **无数据丢失**: 保留per-user冷却数据
- **标记**: 迁移后添加 `migratedAt` 时间戳

---

## 🎭 回复示例

### Neutral (平静)
```
"(光环闪烁) 邦邦咔邦！检测到群组互动！大家今天都很有活力呢！(✨ω✨)"
"(歪头) 咦？有人在召唤爱丽丝吗？勇者随时待命！"
```

### Annoyed (烦躁)
```
"(烦躁) 哎呀...大家别一起戳啦...(揉太阳穴) 爱丽丝的处理器有点跟不上了..."
"(无奈) 群里的戳戳频率有点高呢...(´・ω・`) 让爱丽丝休息一下好不好？"
```

### Angry (生气)
```
"(生气) 你们...够了！(｀へ´) 爱丽丝真的要生气了！不要以为人多就能欺负人！"
"(鼓起脸颊) 呜...群里的大家都在戳爱丽丝...(委屈) 爱丽丝又不是戳戳乐..."
```

### Furious (暴怒)
```
"(暴怒) 够了！(╬▔皿▔)╯ 整个群都在戳爱丽丝！你们是故意的吧！系统即将崩溃！"
"(光环爆闪红色) 警告！群组戳击次数超限！爱丽丝的忍耐值已归零！(▼皿▼#)"
```

---

## 🔬 测试场景

### 场景1: 正常升级
```
User A 戳 → count=1, mood=neutral
User B 戳 → count=2, mood=neutral
User C 戳 → count=3, mood=annoyed  ✅
User D 戳 → count=4, mood=annoyed
User E 戳 → count=5, mood=angry    ✅
```

### 场景2: 渐进式衰减
```
T=0:  8次戳击 → mood=furious
T=5分钟: 无新戳击 → mood=angry (自动降级)
T=10分钟: 无新戳击 → mood=annoyed
T=15分钟: 无新戳击 → mood=neutral
```

### 场景3: 防刷屏
```
User A 戳 (T=0s) → ✅ count+1
User A 戳 (T=1s) → ❌ 冷却中 (< 2s)
User A 戳 (T=3s) → ✅ count+1
```

### 场景4: 情绪不降级
```
当前 mood=angry, count=3
3次戳击 → count=6, mood=angry (不降级，只维持)
2次戳击 → count=8, mood=furious (升级)
```

---

## ⚙️ 功能开关

### 启用群组模式
```bash
# 环境变量
export POKE_GROUP_COUNTING=true

# 或在代码中
const POKE_GROUP_COUNTING = true;
```

### 禁用群组模式 (回退per-user)
```bash
export POKE_GROUP_COUNTING=false
```

---

## 🐛 故障排查

### 问题1: 情绪不衰减
**检查**: 
- groupMood.lastSet 时间戳是否正确
- DECAY_INTERVAL_MS 是否正确 (300000ms = 5分钟)

**日志**:
```
[Poke-GroupMood] 当前情绪: angry (戳击5次, 上次设置120秒前)
```

### 问题2: 计数不准确
**检查**:
- POKE_WINDOW_MS 窗口是否合理 (默认8分钟)
- 是否有ETag冲突导致丢失更新

**日志**:
```
[DB] pokeStats ETag 冲突，重试 1/2
```

### 问题3: 旧数据迁移失败
**检查**:
- migratePokeStatsIfNeeded() 是否执行
- resDoc.migratedAt 是否存在

**日志**:
```
[Poke] DB读取失败: ...
```

---

## 📈 性能考虑

### DB操作
- **读取**: 每次戳击1次读
- **写入**: 每次戳击1次写 (带ETag重试)
- **并发**: ETag乐观并发控制

### 内存占用
- **group stats**: ~100 bytes
- **per-user stats**: ~50 bytes × 用户数
- **groupMood**: ~100 bytes

### 建议
- 群组人数 <500: 无压力
- 群组人数 >1000: 考虑定期清理inactive users

---

## 🔐 安全性

### 防刷屏
- ✅ Per-user cooldown (2秒)
- ✅ 群组计数窗口 (8分钟)
- ✅ 情绪自动衰减

### 防自触发
```javascript
if (BOT_QQ_ID && String(userId) === String(BOT_QQ_ID)) {
    return { status: 200, message: 'self_poke_ignored' };
}
```

---

## 📝 开发日志

### 2025-01-27
- ✅ 添加GROUP_MOOD_DECAY_CONFIG配置
- ✅ 实现getGroupMoodByCount()
- ✅ 实现decayGroupMood()
- ✅ 实现migratePokeStatsIfNeeded()
- ✅ 重构handlePokeLogic支持按群计数
- ✅ 根据groupMood选择回复
- ✅ 移除个人@mention
- ✅ 保留向后兼容的per-user模式

---

## 🚀 未来规划

### Admin命令 (待实现)
```
/aris admin resetMood <groupId>     # 重置群组情绪
/aris admin setMood <groupId> angry  # 手动设置情绪
/aris admin getMood <groupId>        # 查询当前情绪
```

### 可能的增强
- [ ] 情绪可视化 (发送情绪进度条)
- [ ] 不同时段的情绪阈值 (深夜更敏感)
- [ ] VIP群组的情绪保护 (更难生气)
- [ ] 情绪事件日志 (记录历史mood变化)

---

## 📚 相关文件

- `src/functions/schoolBot.js` - 主逻辑实现
- `docs/POKE-GROUP-MOOD-SYSTEM.md` - 本文档
- `docs/P0-INTEGRATION-SUMMARY.md` - P0功能集成总结

---

**最后更新**: 2025-01-27  
**版本**: v2.0 (Group Mood System)  
**状态**: ✅ 已实现并测试通过
