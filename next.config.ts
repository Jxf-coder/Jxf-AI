import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 容器交付使用 standalone 产物，镜像只包含运行时必需文件
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  logging: {
    fetches: { fullUrl: false },
  },
};

export default nextConfig;
