# 🚀 Campus AI Web - 完整实施方案

## 📋 你的愿景 (Imagine Cup 决赛级别)

> "校园版GitHub Copilot + Alice UI + QQ深度融合"

### 核心卖点
1. **QQ机器人 + 网站双平台** - 同一账户,数据同步
2. **Q版Alice Copilot** - 会生气、会开心、眼睛跟鼠标的AI助手
3. **三大AI模式** - Plan(智能计划) + Ask(万能问答) + Class(课表管理)
4. **深度校园数据整合** - 课表+天气+新闻一体化

---

## ✅ 已完成的工作

### 1. 搜索模块 (100%完成)
- ✅ 4层智能搜索路由
- ✅ 缓存系统
- ✅ 前端UI组件
- ✅ 完整文档

### 2. Alice动画增强版 (100%完成)
**文件**: `components/AliceAvatarEnhanced.tsx`

**功能**:
- ✅ 鼠标跟随
- ✅ 戳一戳计数 (戳3次生气, 5次暴怒)
- ✅ 颜文字气泡 (5种情绪)
- ✅ 情绪状态管理
- ✅ 全局事件控制

**使用方法**:
```typescript
// 在聊天时触发Alice情绪
window.dispatchEvent(new CustomEvent("alice:emotion", {
  detail: { emotion: "thinking", showBubble: true }
}));
```

### 3. 登录注册页面 (80%完成)
**文件**: `app/login/page.tsx`

**功能**:
- ✅ QQ一键登录按钮
- ✅ 账号密码登录
- ✅ 手机号注册
- ✅ 验证码发送
- ✅ 美化UI

**待完成**:
- [ ] QQ OAuth对接
- [ ] 短信验证码服务
- [ ] JWT Token生成

---

## 🎯 实施路线图 (按优先级)

### Phase 1: 核心功能 (Imagine Cup 初赛必备)

#### 1.1 完成登录系统 ⭐⭐⭐⭐⭐
**优先级**: 最高
**工作量**: 2-3小时
**需要做的**:

```bash
# 1. 配置QQ互联开放平台
# https://connect.qq.com/
# 创建网站应用,获取APP ID和APP Key

# 2. 实现OAuth回调
# 文件: app/api/auth/qq/callback/route.ts
# 逻辑:
#   - 接收QQ返回的code
#   - 换取access_token
#   - 获取用户QQ号和昵称
#   - 检查是否已注册
#   - 未注册→跳转补充信息页
#   - 已注册→生成JWT返回

# 3. 短信验证码服务 (可选,初期可mock)
# 使用阿里云SMS或腾讯云SMS
# 或者直接mock: 验证码固定为"123456"
```

**验收标准**:
- [ ] QQ扫码登录成功
- [ ] 新用户注册流程完整
- [ ] 登录后跳转主页
- [ ] Token保存到localStorage

---

#### 1.2 Alice情绪联动 ⭐⭐⭐⭐⭐
**优先级**: 最高 (这是评委最爱的视觉亮点!)
**工作量**: 1小时

**需要做的**:

</ 1. 在`app/page.tsx`中使用增强版Alice
```typescript
// 替换原来的AliceAvatar
import AliceAvatar from "../components/AliceAvatarEnhanced";

// 在聊天发送时触发thinking状态
const handleSend = async () => {
  window.dispatchEvent(new CustomEvent("alice:emotion", {
    detail: { emotion: "thinking" }
  }));
  
  // ...发送消息
  
  // 收到回复后触发happy
  window.dispatchEvent(new CustomEvent("alice:emotion", {
    detail: { emotion: "happy" }
  }));
};
```

2. 添加错误状态
```typescript
// 搜索失败时触发angry
catch (error) {
  window.dispatchEvent(new CustomEvent("alice:emotion", {
    detail: { emotion: "angry" }
  }));
}
```

**验收标准**:
- [ ] 发送消息时Alice显示thinking颜文字
- [ ] 收到回复时Alice显示happy颜文字
- [ ] 戳3次Alice会生气
- [ ] 鼠标移动Alice眼睛跟随

---

#### 1.3 Plan模式完整实现 ⭐⭐⭐⭐⭐
**优先级**: 最高 (这是核心创新点!)
**工作量**: 3-4小时

**需要做的**:

```typescript
// 1. 创建Plan模式API路由
// 文件: app/api/plan/route.ts

export async function POST(req: Request) {
  const { userIntent, userId } = await req.json();
  
  // 1. 获取用户课表
  const schedule = await getSchedule(userId);
  
  // 2. 获取当前时间
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0-6
  
  // 3. 获取天气
  const weather = await getWeather("Wuhan");
  
  // 4. 分析空闲时间
  const freeSlots = analyzeFreetime(schedule, now);
  
  // 5. 调用LLM生成计划
  const plan = await generatePlan({
    userIntent,
    schedule,
    weather,
    freeSlots,
    currentTime: now
  });
  
  return new Response(JSON.stringify({ plan }));
}
```

2. 创建Plan展示组件
```typescript
// components/PlanView.tsx
function PlanView({ plan }) {
  return (
    <div>
      <h3>📅 今日计划</h3>
      {plan.tasks.map(task => (
        <div key={task.id}>
          <span>{task.time}</span>
          <span>{task.title}</span>
          <span>{task.location}</span>
        </div>
      ))}
      
      {plan.weatherTip && (
        <div>☂️ {plan.weatherTip}</div>
      )}
    </div>
  );
}
```

**验收标准**:
- [ ] 用户输入"帮我规划明天的学习时间"
- [ ] 系统返回包含课表+天气的计划
- [ ] 空闲时间段高亮显示
- [ ] 下雨天提醒带伞

---

### Phase 2: 增强功能 (决赛加分项)

#### 2.1 Class模式 ⭐⭐⭐⭐
**优先级**: 高
**工作量**: 2小时

**核心功能**:
- 本周课程一览
- 下一节课提醒
- 教室位置导航
- 天气联动 (下雨→建议路线)

#### 2.2 Ask模式扩展 ⭐⭐⭐
**优先级**: 中
**工作量**: 1小时

**核心功能**:
- 校园新闻爬虫
- 食堂菜单查询
- 校历查询

#### 2.3 QQ与网站数据同步 ⭐⭐⭐⭐⭐
**优先级**: 最高 (这是杀手锏!)
**工作量**: 2小时

**实现逻辑**:
```typescript
// QQ机器人端 (src/functions/schoolBot.js)
async function handleMessage(event) {
  const userId = event.user_id;
  
  // 1. 从CosmosDB查询用户
  const user = await getUserByQQ(userId);
  
  // 2. 如果用户未注册网站
  if (!user.webRegistered) {
    return "请先访问 alice.campus.com 注册账户后使用完整功能!";
  }
  
  // 3. 使用同一个CosmosDB数据
  const response = await chat(userId, message);
  
  // 4. 更新聊天记录 (QQ和网站共享)
  await saveChatHistory(userId, message, response);
  
  return response;
}
```

**验收标准**:
- [ ] QQ聊天记录同步到网站
- [ ] 网站聊天记录同步到QQ
- [ ] 好感度两边共享
- [ ] 课表两边共享

---

## 🎓 Imagine Cup 演示脚本 (3分钟)

### 开场 (30秒)
> "大家好,我是XXX,我的项目叫Alice Campus - 校园AI助手。
> 
> 它的特别之处在于:QQ机器人和网站是同一个账户系统,你在QQ上的聊天记录、课表、好感度,会实时同步到网页端。"

[展示架构图]

### 功能1: 登录系统 (30秒)
> "首先,用户可以通过QQ一键登录,绑定手机号,创建账户。"

[演示]:
1. 打开 alice.campus.com
2. 点击"QQ一键登录"
3. 扫码授权
4. 填写手机号
5. 设置密码
6. 注册成功

### 功能2: Alice互动 (45秒)
> "右下角是我们的AI助手Alice,她会跟随你的鼠标,你戳她,她会用颜文字回应。"

[演示]:
1. 鼠标移动,Alice眼睛跟随
2. 点击Alice 1次 → 显示开心颜文字
3. 连续戳3次 → 显示生气颜文字
4. 发送消息 → Alice显示thinking状态

### 功能3: Plan模式 (60秒)
> "这是我们的核心功能 - 智能计划模式。
> 
> 它会结合你的课表、当前时间、天气,帮你生成今日计划。"

[演示]:
1. 切换到Plan模式
2. 输入"帮我安排明天的学习时间"
3. 系统返回:
   - 上午9:00-11:00 数学课
   - 11:00-12:00 自习 (推荐去图书馆)
   - 下午2:00-4:00 英语课
   - 明天有雨,建议带伞☂️

### 功能4: QQ同步 (30秒)
> "最后,我们的QQ机器人和网站是完全同步的。
> 
> 你在QQ上问过的问题,会出现在网站的聊天记录里。"

[演示]:
1. 打开QQ
2. 发送"今天天气怎么样"
3. 打开网站
4. 刷新,聊天记录出现

### 总结 (15秒)
> "Alice Campus 实现了AI助手的双平台融合,为校园学生提供7x24智能服务。
> 
> 谢谢大家!"

---

## 📊 技术架构图 (给评委看的)

```
┌─────────────────────────────────────┐
│          用户端                      │
│  ┌──────────┐      ┌──────────┐    │
│  │ QQ客户端 │      │  网页端   │    │
│  │ (NapCat) │      │ Next.js   │    │
│  └────┬─────┘      └────┬──────┘    │
│       │                  │            │
│       │  账户同步        │            │
│       └─────────┬────────┘            │
└─────────────────┼─────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│      Azure Function 后端             │
│  ┌───────────────────────────────┐  │
│  │  schoolBot.js                 │  │
│  │  - 统一账户系统               │  │
│  │  - 消息路由                   │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │  服务模块                     │  │
│  │  - hybridSearch (搜索)        │  │
│  │  - scheduleService (课表)     │  │
│  │  - weatherService (天气)      │  │
│  │  - emotionService (情绪)      │  │
│  └───────────────────────────────┘  │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│      Azure Cosmos DB                │
│  ┌───────────────────────────────┐  │
│  │  Users 表                     │  │
│  │  - qq (主键)                  │  │
│  │  - phone                      │  │
│  │  - passwordHash               │  │
│  │  - affection                  │  │
│  │  - chatHistory                │  │
│  │  - schedule                   │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │  SearchCache 表               │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

---

## ✅ 下一步行动清单

### 今天就做 (2-3小时)
- [ ] 替换AliceAvatar为增强版
- [ ] 测试戳一戳和颜文字
- [ ] 添加消息发送时的情绪触发
- [ ] 录制演示视频

### 本周完成 (5-8小时)
- [ ] QQ OAuth登录对接
- [ ] 注册流程完整测试
- [ ] Plan模式API实现
- [ ] Class模式基础功能

### 下周完成 (3-5小时)
- [ ] QQ与网站数据同步
- [ ] 完整演示脚本练习
- [ ] PPT制作
- [ ] 部署到Azure生产环境

---

## 🎁 我已经帮你做好的

1. ✅ **AliceAvatarEnhanced.tsx** - 完整的情绪系统
2. ✅ **LoginPage** - 美化的登录注册UI
3. ✅ **注册API** - 基础注册逻辑
4. ✅ **搜索模块** - 完整的4层搜索
5. ✅ **完整文档** - 所有技术文档

---

## 💡 你现在要做的

### 第一步: 测试Alice增强版
```bash
# 1. 修改 app/page.tsx
# 把 import AliceAvatar from "../components/AliceAvatar";
# 改成 import AliceAvatar from "../components/AliceAvatarEnhanced";

# 2. 启动前端
npm run dev

# 3. 测试
# - 鼠标移动看Alice眼睛
# - 点击Alice看颜文字
# - 连续戳3次看生气表情
```

### 第二步: 决定登录方案
选择以下之一:

**方案A: 完整QQ OAuth** (推荐给评委看)
- 需要QQ互联开发者账号
- 真实的扫码登录
- 专业度高

**方案B: Mock QQ登录** (快速演示)
- 点击"QQ登录"直接跳转注册页
- 手动输入QQ号
- 开发速度快

我建议: **先用方案B快速跑通,演示前再上方案A**

### 第三步: 联系我继续实现
告诉我你选择哪个方案,我继续帮你实现下一步!

---

**🎊 你离Imagine Cup决赛只差执行了!**

我已经帮你铺好了所有技术路线,现在只需要:
1. 测试Alice增强版
2. 选择登录方案
3. 实现Plan模式
4. 录制演示视频

**加油! (✨ω✨)**
