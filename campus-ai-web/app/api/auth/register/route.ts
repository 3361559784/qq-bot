// 使用 Node.js 运行时以支持 crypto/Buffer
export const runtime = 'nodejs';

import { CosmosClient } from "@azure/cosmos";
import { createHash } from "crypto";

// Cosmos DB配置
const cosmosString = process.env.COSMOS_DB_STRING;
let cosmosContainer: any = null;

if (cosmosString) {
  const cosmosClient = new CosmosClient(cosmosString);
  const database = cosmosClient.database("QQBotDB");
  cosmosContainer = database.container("Users"); // 用户表
}

/**
 * 用户注册API
 * POST /api/auth/register
 */
export async function POST(req: Request) {
  try {
    const { qqNumber, phone, password, verificationCode } = await req.json();

    // 参数验证
    if (!qqNumber || !phone || !password || !verificationCode) {
      return new Response(
        JSON.stringify({ error: "参数缺失" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 验证手机号格式
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return new Response(
        JSON.stringify({ error: "手机号格式错误" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // TODO: 验证验证码
    // const isCodeValid = await verifyCode(phone, verificationCode);
    // if (!isCodeValid) {
    //   return new Response(
    //     JSON.stringify({ error: "验证码错误或已过期" }),
    //     { status: 400, headers: { "Content-Type": "application/json" } }
    //   );
    // }

    if (!cosmosContainer) {
      return new Response(
        JSON.stringify({ error: "数据库未配置" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 检查QQ号是否已注册
    const qqQuery = `SELECT * FROM c WHERE c.qq = "${qqNumber}"`;
    const { resources: existingQQ } = await cosmosContainer.items
      .query(qqQuery)
      .fetchAll();

    if (existingQQ.length > 0) {
      return new Response(
        JSON.stringify({ error: "该QQ号已注册" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // 检查手机号是否已绑定
    const phoneQuery = `SELECT * FROM c WHERE c.phone = "${phone}"`;
    const { resources: existingPhone } = await cosmosContainer.items
      .query(phoneQuery)
      .fetchAll();

    if (existingPhone.length > 0) {
      return new Response(
        JSON.stringify({ error: "该手机号已绑定其他账户" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // 密码加密 (使用SHA256)
    const passwordHash = createHash("sha256")
      .update(password + process.env.PASSWORD_SALT || "alice-campus")
      .digest("hex");

    // 创建用户
    const newUser = {
      id: qqNumber, // 使用QQ号作为主键
      qq: qqNumber,
      phone: phone,
      passwordHash: passwordHash,
      createdAt: new Date().toISOString(),
      affection: 0, // 初始好感度
      chatHistory: [],
      schedule: null,
      lastScheduleUpdate: null,
    };

    await cosmosContainer.items.create(newUser);

    // 生成JWT Token
    const token = generateToken(qqNumber);

    return new Response(
      JSON.stringify({
        success: true,
        token: token,
        user: {
          qq: qqNumber,
          phone: phone,
        },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Registration error:", error);
    return new Response(
      JSON.stringify({ error: "注册失败,请稍后重试" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * 生成JWT Token (简化版)
 */
function generateToken(qqNumber: string): string {
  const payload = {
    qq: qqNumber,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7天过期
  };
  
  // 简单的base64编码 (生产环境应使用JWT库)
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
