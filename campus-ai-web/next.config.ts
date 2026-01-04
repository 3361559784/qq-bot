import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 指定 Turbopack 根目录为当前子项目，消除 monorepo 中的 lockfile 警告
  turbopack: {
    root: process.cwd(),
  },
  // 部署配置：使用 Next.js standalone 输出，便于 Azure App Service 直接运行 server.js
  output: 'standalone',
  // 允许外部图片域名
  images: {
    unoptimized: true, // SWA 不支持 Next.js Image Optimization API
  },
  // 缓存策略：避免 HTML 被浏览器/代理缓存导致“引用旧 chunk hash”进而触发 client-side exception
  // - HTML / 页面路由：no-store
  // - Next 静态资源：immutable
  async headers() {
    return [
      {
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, must-revalidate',
          },
        ],
      },
    ];
  },
  // 环境变量
  env: {
    // 开源仓库默认走本地 Functions；线上地址请通过环境变量覆盖
    NEXT_PUBLIC_AZURE_FUNCTION_URL: process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL || 'http://127.0.0.1:7071/api/schoolbot',
  }
};

export default nextConfig;
