/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone', // 核心：生成独立的轻量级 Node 服务器
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
