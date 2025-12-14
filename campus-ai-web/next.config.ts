import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 指定 Turbopack 根目录为当前子项目，消除 monorepo 中的 lockfile 警告
  turbopack: {
    root: './'
  }
};

export default nextConfig;
