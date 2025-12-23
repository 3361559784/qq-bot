import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 指定 Turbopack 根目录为当前子项目，消除 monorepo 中的 lockfile 警告
  turbopack: {
    root: './'
  },
  // Azure Static Web Apps 部署配置
  output: 'standalone',
  // 允许外部图片域名
  images: {
    unoptimized: true, // SWA 不支持 Next.js Image Optimization API
  },
  // 环境变量
  env: {
    NEXT_PUBLIC_AZURE_FUNCTION_URL: process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL || 'https://school-bot-gwb4a9gkdwcyhde5.koreacentral-01.azurewebsites.net',
  }
};

export default nextConfig;
